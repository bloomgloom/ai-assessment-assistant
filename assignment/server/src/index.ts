import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { execFileSync } from 'child_process';
import MarkdownIt from 'markdown-it';
import { execute, initDb, queryAll, queryOne, transaction } from './db';
import { decodeUploadFilename, studentDownloadFilename } from './filename';
import { LOGS_DIR, moveFileToTrash, resolveStoredPath, restoreTrashedFile, SUBMISSIONS_DIR, TEMP_DIR, toStoredPath } from './storage';

const app = express();
const teacherApp = express();
const studentApp = express();
const ADMIN_PORT = Number(process.env.ADMIN_PORT || process.env.PORT || 3002);
const TEACHER_PORT = Number(process.env.TEACHER_PORT || ADMIN_PORT + 1);
const STUDENT_PORT = Number(process.env.STUDENT_PORT || 10000);
const ADMIN_HOST = '127.0.0.1';
const PUBLIC_HOST = process.env.HOST || '0.0.0.0';
const ASSESSMENT_CLIENT_DIST = path.resolve(__dirname, '../../../assessment/client/dist');
const mdRenderer = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false
});

const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 200 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
teacherApp.use(cors());
teacherApp.use(express.json());
teacherApp.use(express.urlencoded({ extended: true }));
studentApp.use(cors());
studentApp.use(express.json());
studentApp.use(express.urlencoded({ extended: true }));

// 평가 관리에서 사용하는 산출물 뷰어 번들을 평가 실시 화면에서도 그대로
// 띄운다. 루트 정적 서빙은 각 앱의 현황판과 충돌하므로 Vite 자산만 공유한다.
app.use('/assets', express.static(path.join(ASSESSMENT_CLIENT_DIST, 'assets')));
teacherApp.use('/assets', express.static(path.join(ASSESSMENT_CLIENT_DIST, 'assets')));

const virtualInterface = /^(?:bridge\d*|utun\d*|awdl\d*|llw\d*|vnic\d*|vmnet\d*|vboxnet\d*|docker\d*|br-|virbr\d*|tun\d*|tap\d*|ppp\d*)|tailscale|parallels|hyper-v|vethernet|vmware|virtualbox|wsl/i;
const physicalInterface = /^(?:en\d+|eth\d+|wlan\d+|wl\w+)$|wi-?fi|ethernet/i;

function macNetworkInterfaceOrder(): string[] {
  if (process.platform !== 'darwin') return [];
  const ordered: string[] = [];

  try {
    const route = execFileSync('/sbin/route', ['-n', 'get', 'default'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const defaultInterface = route.match(/^\s*interface:\s*(\S+)/m)?.[1];
    if (defaultInterface && !virtualInterface.test(defaultInterface)) ordered.push(defaultInterface);
  } catch {
    // 기본 경로가 없는 오프라인 LAN에서는 서비스 순서만 사용합니다.
  }

  try {
    const services = execFileSync('/usr/sbin/networksetup', ['-listnetworkserviceorder'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let disabled = false;
    for (const line of services.split(/\r?\n/)) {
      if (/^\((?:\d+|\*)\)\s/.test(line)) disabled = line.startsWith('(*)');
      const interfaceName = line.match(/\bDevice:\s*([^)]+)\)/)?.[1]?.trim();
      if (interfaceName && !disabled && !virtualInterface.test(interfaceName)) ordered.push(interfaceName);
    }
  } catch {
    // networksetup을 사용할 수 없으면 일반 물리 인터페이스 순서로 대체합니다.
  }

  return [...new Set(ordered)];
}

function windowsNetworkAddressOrder(): string[] {
  if (process.platform !== 'win32') return [];
  try {
    const routes = execFileSync('route.exe', ['print', '-4', '0.0.0.0'], {
      encoding: 'utf8',
      timeout: 1000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const defaults: Array<{ address: string; metric: number }> = [];
    for (const line of routes.split(/\r?\n/)) {
      const match = line.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/);
      if (match) defaults.push({ address: match[1], metric: Number(match[2]) });
    }
    return [...new Set(defaults.sort((a, b) => a.metric - b.metric).map(route => route.address))];
  } catch {
    return [];
  }
}

function localIps() {
  const results: Array<{ address: string; interfaceName: string }> = [];
  for (const [interfaceName, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) results.push({ address: info.address, interfaceName });
    }
  }

  // Parallels, Docker, VPNs, etc. expose non-internal IPv4 addresses too. They
  // often precede the actual LAN adapter in os.networkInterfaces(), so using
  // the first result can show an address that students cannot reach.
  const preferred = results.filter(({ interfaceName }) => !virtualInterface.test(interfaceName));
  const macOrder = macNetworkInterfaceOrder();
  const macPriority = new Map(macOrder.map((interfaceName, index) => [interfaceName, index]));
  const windowsOrder = windowsNetworkAddressOrder();
  const windowsPriority = new Map(windowsOrder.map((address, index) => [address, index]));

  return preferred
    .sort((a, b) => {
      const aWindowsPriority = windowsPriority.get(a.address) ?? Number.MAX_SAFE_INTEGER;
      const bWindowsPriority = windowsPriority.get(b.address) ?? Number.MAX_SAFE_INTEGER;
      if (aWindowsPriority !== bWindowsPriority) return aWindowsPriority - bWindowsPriority;
      const aMacPriority = macPriority.get(a.interfaceName) ?? Number.MAX_SAFE_INTEGER;
      const bMacPriority = macPriority.get(b.interfaceName) ?? Number.MAX_SAFE_INTEGER;
      if (aMacPriority !== bMacPriority) return aMacPriority - bMacPriority;
      return Number(!physicalInterface.test(a.interfaceName)) - Number(!physicalInterface.test(b.interfaceName));
    })
    .map(({ address }) => address);
}

function clientIp(req: any) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function isLocalRequest(req: any) {
  const ip = clientIp(req);
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}

function requireLocal(req: any, res: any, next: any) {
  if (!isLocalRequest(req)) return res.status(403).send('Forbidden');
  next();
}

function safeSegment(value: string) {
  return value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim() || '_';
}

function runCode() {
  return crypto.randomBytes(8).toString('hex');
}

function escapeHtml(value: string) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function assignmentLogPath() {
  return path.join(LOGS_DIR, `assignment-${new Date().toISOString().slice(0, 10)}.log`);
}

function writeAssignmentLog(event: string, details: Record<string, unknown>) {
  const line = JSON.stringify({ time: new Date().toLocaleString('sv-SE'), event, ...details });
  fs.appendFileSync(assignmentLogPath(), `${line}\n`, 'utf8');
}

async function getTeacherPasswordHash() {
  const row = await queryOne<{ value: string }>('SELECT value FROM assignment_settings WHERE key=?', ['teacher_password_hash']);
  return row?.value || '';
}

function parseCookies(req: any) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index < 0) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function teacherAuthToken(passwordHash: string) {
  return crypto.createHmac('sha256', passwordHash).update('assignment-teacher-viewer').digest('hex');
}

function verifyPassword(password: string, passwordHash: string) {
  const parts = passwordHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  const expected = Buffer.from(parts[3], 'hex');
  const actual = crypto.pbkdf2Sync(password, parts[2], iterations, expected.length, 'sha256');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function isTeacherAuthenticated(req: any, allowLocal = true) {
  if (allowLocal && isLocalRequest(req)) return true;
  const passwordHash = await getTeacherPasswordHash();
  if (!passwordHash) return true;
  return parseCookies(req).assignment_teacher_auth === teacherAuthToken(passwordHash);
}

async function requireTeacherAuth(req: any, res: any, next: any) {
  if (await isTeacherAuthenticated(req)) return next();
  res.status(401).json({ error: '교사 비밀번호 인증이 필요합니다.' });
}

function allowedExtensions(value: string) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
}

interface SubmissionRule {
  extension: string;
  max_file_size_mb: number;
  max_files: number;
}

function submissionRules(value: string, fallbackSize = 50, fallbackFiles = 1): SubmissionRule[] {
  try {
    const parsed = JSON.parse(value || '[]');
    if (Array.isArray(parsed)) {
      return parsed
        .map(item => ({
          extension: String(item.extension || item.ext || '').trim().replace(/^\./, '').toLowerCase(),
          max_file_size_mb: Math.max(1, Number(item.max_file_size_mb || item.maxFileSizeMb || fallbackSize)),
          max_files: Math.max(1, Number(item.max_files || item.maxFiles || fallbackFiles)),
        }))
        .filter(item => item.extension)
        .filter((item, index, arr) => arr.findIndex(other => other.extension === item.extension) === index);
    }
  } catch {
    // Legacy newline/comma separated extension list.
  }
  return allowedExtensions(value).map(extension => ({
    extension,
    max_file_size_mb: Math.max(1, Number(fallbackSize) || 50),
    max_files: Math.max(1, Number(fallbackFiles) || 1),
  }));
}

function extensionLabel(rule: SubmissionRule) {
  return `${rule.extension.toUpperCase()} / 최대 ${rule.max_file_size_mb}MB / ${rule.max_files}개`;
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#eef2f7;color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid #dbe2ea;background:#fff;box-shadow:0 1px 8px rgba(15,23,42,.04)}
main{max-width:1100px;margin:0 auto;padding:20px}
p{font-size:16px}
a{font-size:16px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.student-layout{grid-template-columns:minmax(0,2fr) minmax(320px,1fr);align-items:start}.stack{display:grid;gap:16px}
.admin-controls{display:grid;grid-template-columns:115px 86px 86px minmax(150px,.8fr) minmax(280px,2fr) minmax(170px,.9fr) auto;gap:10px;align-items:end}
.field{display:grid;gap:6px;min-width:0}
.card{border:1px solid #dbe2ea;background:#fff;border-radius:8px;padding:18px;box-shadow:0 8px 22px rgba(15,23,42,.05)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.summary{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0;padding:10px 12px;border:1px solid #dbe2ea;border-radius:8px;background:#f8fafc;font-weight:700}.summary span{font-size:15px}.summary-done{border-color:#22c55e;background:#dcfce7;color:#166534;box-shadow:0 0 0 2px rgba(34,197,94,.14)}.complete-badge{margin-left:auto;padding:4px 9px;border-radius:999px;background:#15803d;color:#fff;font-size:13px}.absent-row td{background:#f1f5f9;color:#64748b}.absent-row a{color:#64748b}
label{display:block;font-size:15px;font-weight:700;color:#374151;margin-bottom:6px}
select,input,button,textarea{font:inherit}
select,input{width:100%;box-sizing:border-box;height:44px;border:1px solid #d1d5db;border-radius:6px;padding:0 12px;background:#fff;font-size:16px}
button,.button{height:44px;border:1px solid #2563eb;border-radius:6px;background:#2563eb;color:#fff;padding:0 14px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;text-align:center}
button.secondary,.button.secondary{border-color:#d1d5db;background:#fff;color:#374151}
button:disabled,.button.disabled{opacity:.35;cursor:not-allowed;pointer-events:none}
.resource-list{display:grid;gap:10px}.resource-card{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #dbe2ea;background:#f8fafc;border-radius:8px;padding:12px 14px;text-decoration:none;color:#111827}.resource-card:hover{border-color:#2563eb;background:#eff6ff}.resource-name{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.resource-action{flex:0 0 auto;color:#2563eb;font-size:14px;font-weight:700}
.file-list{display:grid;gap:10px;margin:10px 0}.upload-rule{display:grid;gap:8px;border:1px solid #dbe2ea;background:#f8fafc;border-radius:8px;padding:12px}.file-row{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid #e5e7eb;background:#fff;border-radius:6px;padding:10px 12px;font-size:16px}.file-row button{height:30px;border-color:#fecaca;background:#fff;color:#dc2626;padding:0 10px}.student-form{display:grid;gap:16px}.student-info{grid-column:1/-1}.student-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.full{grid-column:1/-1}.no-file-option{display:flex;align-items:center;gap:9px;margin:2px 0 0;padding:12px;border:1px solid #dbe2ea;border-radius:8px;background:#f8fafc;cursor:pointer}.no-file-option input{width:18px;height:18px;margin:0;flex:0 0 auto}.no-file-option span{font-size:16px;font-weight:700}.uploads-disabled{opacity:.45;pointer-events:none}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;font-size:13px}
th{background:#f9fafb;color:#4b5563}
.muted{color:#6b7280;font-size:15px}.danger{color:#dc2626}.ok{color:#15803d}.guide{line-height:1.75;font-size:16px}.guide p{font-size:16px}.guide h1{font-size:24px}.guide h2{font-size:20px}.guide h3{font-size:18px}.guide ul,.guide ol{padding-left:22px}.guide blockquote{margin:16px 0;padding:8px 16px;border-left:4px solid #94a3b8;background:#f8fafc;color:#475569}.guide table{margin:14px 0}.guide th{font-weight:700}
@media(max-width:900px){.grid,.student-layout,.admin-controls,.student-fields{grid-template-columns:1fr}main{padding:14px}header{padding:0 14px}}
</style>
</head>
<body>${body}</body>
</html>`;
}

function markdown(md: string) {
  return mdRenderer.render(String(md || ''));
}

async function currentOpenRun() {
  return queryOne<any>(
    `SELECT run.*, cfg.*, ac.id AS ac_id, ac.room
     FROM assignment_runs run
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     WHERE run.is_open=1
     ORDER BY run.started_at DESC, run.id DESC
     LIMIT 1`
  );
}

async function runByShareCode(shareCode: string) {
  return queryOne<any>(
    `SELECT run.*, cfg.*, ac.id AS ac_id, ac.room
     FROM assignment_runs run
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     WHERE run.share_code=?`,
    [shareCode]
  );
}

async function renderStudentPage(run: any, submitPath: string, res: any) {
  const resources = await queryAll<any>('SELECT id, filename, size FROM assignment_resources WHERE config_id=? ORDER BY uploaded_at DESC', [run.config_id]);
  const rules = submissionRules(run.allowed_extensions, Number(run.max_file_size_mb || 50), Number(run.max_files || 1));
  const uploadRules = rules.length ? rules : [{ extension: '', max_file_size_mb: Number(run.max_file_size_mb || 50), max_files: Number(run.max_files || 1) }];
  res.send(page(run.title || '수행평가 제출', `
<header><strong>${escapeHtml(run.title || '수행평가 제출')}</strong><span class="${run.is_open ? 'ok' : 'danger'}">${run.is_open ? '제출 가능' : '제출 마감'}</span></header>
<main class="grid student-layout">
 <section class="card student-info"><h2>학생 정보</h2><div class="student-fields"><div><label>학년</label><input value="${Number(run.grade)}" readonly></div><div><label>반</label><input form="f" name="classNum" type="number" min="1" step="1" required inputmode="numeric"></div><div><label>번호</label><input form="f" name="seatNum" type="number" min="1" step="1" required inputmode="numeric"></div><div><label>이름</label><input form="f" name="name" required autocomplete="name" placeholder="띄어쓰기 없이 입력"></div></div></section>
 <section class="card"><h2>안내</h2><div class="guide">${markdown(run.guide_md)}</div></section>
 <div class="stack">
  <section class="card"><h2>다운로드 자료</h2><div class="resource-list">${resources.map(r=>`<a class="resource-card" href="/api/public/resources/${r.id}/file" onclick="downloadResource(event,${r.id})"><span class="resource-name">${escapeHtml(r.filename)}</span><span class="resource-action">다운로드</span></a>`).join('') || '<p class="muted">자료 없음</p>'}</div></section>
  <section class="card"><h2>제출</h2><form id="f" class="student-form"><div id="fileSection"><label>파일</label><div id="uploadGroups" class="file-list"></div></div><label class="no-file-option"><input id="noFile" name="noFile" type="checkbox" value="1"><span>파일 미제출</span></label><button>제출</button></form><p id="msg"></p></section>
 </div>
</main>
<script>
const rules=${JSON.stringify(uploadRules)};
let selectedFiles=rules.map(()=>[]);
f.elements.name.oninput=()=>{f.elements.name.value=f.elements.name.value.replace(/\\s+/g,'');};
function label(rule){return rule.extension?rule.extension.toUpperCase()+' 파일':'파일';}
function limitText(rule){return (rule.extension?rule.extension:'모든 확장자')+' / 최대 '+rule.max_file_size_mb+'MB / '+rule.max_files+'개';}
function renderFiles(){uploadGroups.innerHTML=rules.map((rule,groupIndex)=>{
 const rows=selectedFiles[groupIndex].map((file,fileIndex)=>'<div class="file-row"><span>'+file.name+'</span><button type="button" onclick="removeFile('+groupIndex+','+fileIndex+')">X</button></div>').join('')||'<p class="muted">선택한 파일이 없습니다.</p>';
 const accept=rule.extension?' accept=".'+rule.extension+'"':'';
 return '<div class="upload-rule"><div class="row" style="justify-content:space-between"><div><b>'+label(rule)+'</b><p class="muted">'+limitText(rule)+'</p></div><button type="button" class="secondary" onclick="document.getElementById(\\'fileInput_'+groupIndex+'\\').click()">파일 추가</button></div><input id="fileInput_'+groupIndex+'" type="file" '+(rule.max_files>1?'multiple':'')+accept+' hidden onchange="addFiles('+groupIndex+',this)">'+rows+'</div>';
}).join('');}
function addFiles(groupIndex,input){const rule=rules[groupIndex];for(const file of input.files||[]){if(selectedFiles[groupIndex].length<rule.max_files)selectedFiles[groupIndex].push(file);}input.value='';renderFiles();}
function removeFile(groupIndex,fileIndex){selectedFiles[groupIndex].splice(fileIndex,1);renderFiles();}
function downloadResource(event,id){event.preventDefault();if(!f.reportValidity())return;const query=new URLSearchParams({classNum:f.elements.classNum.value,seatNum:f.elements.seatNum.value,name:f.elements.name.value});location.href='/api/public/resources/'+id+'/file?'+query;}
noFile.onchange=()=>{fileSection.classList.toggle('uploads-disabled',noFile.checked);};
f.onsubmit=async(e)=>{e.preventDefault();const allFiles=selectedFiles.flat();if(!noFile.checked&&allFiles.length===0){msg.textContent='파일을 추가하거나 파일 미제출을 체크하세요.';msg.className='danger';return;}msg.textContent='제출 중...';const fd=new FormData(f);fd.delete('files');if(!noFile.checked)allFiles.forEach(file=>fd.append('files',file));const r=await fetch('${submitPath}',{method:'POST',body:fd});const data=await r.json().catch(()=>({error:'제출 실패'}));msg.textContent=r.ok?data.message:data.error;msg.className=r.ok?'ok':'danger';if(r.ok){f.reset();selectedFiles=rules.map(()=>[]);fileSection.classList.remove('uploads-disabled');renderFiles();}};
renderFiles();
</script>`));
}

async function submissionStatusForRun(runId: string | number, sort: string) {
  const run = await queryOne<any>(
    `SELECT run.assignment_class_id, cfg.domain_name
     FROM assignment_runs run
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     WHERE run.id=?`,
    [runId]
  );
  if (!run) return [];
  const order = sort === 'default'
    ? 'rst.sort_order ASC, rst.id ASC'
    : 'rst.is_absent ASC, CASE WHEN sub.id IS NULL THEN 1 ELSE 0 END ASC, sub.submitted_at DESC, sub.id DESC, rst.class_num ASC, rst.seat_num ASC, rst.name ASC';
  return queryAll(
    `SELECT
       rst.id AS run_student_id,
       rst.assignment_student_id,
       rst.student_num,
       rst.class_num,
       rst.seat_num,
       rst.name,
       rst.is_absent,
       rst.absent_at,
       rst.assessment_student_id,
       sub.id AS submission_id,
       sub.submitted_at,
       sub.ip_address,
       sub.original_filename,
       sub.status,
       sub.reject_reason,
       sub.teacher_checked,
       sub.teacher_checked_at,
       (
         SELECT COUNT(*)
         FROM assignment_submissions
         WHERE run_id=? AND status='accepted' AND (assignment_student_id=rst.assignment_student_id OR (student_num=rst.student_num AND name=rst.name))
       ) AS accepted_count,
       (
         SELECT COUNT(*)
         FROM assignment_artifacts
         WHERE assessment_student_id=rst.assessment_student_id AND domain=?
       ) AS separate_artifact_count,
       (
         SELECT COUNT(*)
         FROM assignment_submissions
         WHERE run_id=? AND status='accepted' AND (assignment_student_id=rst.assignment_student_id OR (student_num=rst.student_num AND name=rst.name))
       ) + (
         SELECT COUNT(*)
         FROM assignment_artifacts
         WHERE assessment_student_id=rst.assessment_student_id AND domain=?
       ) AS artifact_count
     FROM assignment_run_students rst
     LEFT JOIN assignment_submissions sub ON sub.id = (
       SELECT id
       FROM assignment_submissions
       WHERE run_id=? AND (assignment_student_id=rst.assignment_student_id OR (student_num=rst.student_num AND name=rst.name))
       ORDER BY submitted_at DESC, id DESC
       LIMIT 1
     )
     WHERE rst.run_id=?
     ORDER BY ${order}`,
    [runId, run.domain_name, runId, run.domain_name, runId, runId]
  );
}

app.get(['/', '/admin'], requireLocal, (_req, res) => {
  const ips = localIps();
  res.send(page('평가 실시 관리', `
<header><strong>평가 실시 관리</strong><div class="row"><span class="muted">관리 ${ADMIN_PORT} / 교사 ${TEACHER_PORT} / 학생 ${STUDENT_PORT}</span><a id="exitBtn" class="button secondary" href="app://launcher">종료</a></div></header>
<main>
  <div class="card">
    <h2>평가 실시</h2>
    <div class="admin-controls">
      <div class="field"><label>학년도</label><select id="year"></select></div>
      <div class="field"><label>학기</label><select id="semester"></select></div>
      <div class="field"><label>학년</label><select id="grade"></select></div>
      <div class="field"><label>과목</label><select id="subject"></select></div>
      <div class="field"><label>영역</label><select id="domain"></select></div>
      <div class="field"><label>강의실</label><select id="class"></select></div>
      <button id="runToggle">시작</button>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:8px">
      <div id="links" style="flex:1"></div>
      <label id="targetFilter" class="row" style="margin:0;font-size:15px;font-weight:600;cursor:pointer"><input id="absentOnly" type="checkbox" style="width:auto;height:auto"> 미실시자만</label>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">제출 현황</h2>
      <select id="sort" style="width:auto;height:36px;font-size:14px"><option value="default">기본순</option><option value="recent">제출순</option></select>
    </div>
    <div id="summary" class="summary"></div>
    <div id="submissions"></div>
  </div>
</main>
<script>
const yearSel=document.querySelector('#year'), semesterSel=document.querySelector('#semester'), gradeSel=document.querySelector('#grade'), subjectSel=document.querySelector('#subject'), domainSel=document.querySelector('#domain'), classSel=document.querySelector('#class');
const teacherBase='${ips[0] || '127.0.0.1'}:${TEACHER_PORT}';
const studentBase='${ips[0] || '127.0.0.1'}:${STUDENT_PORT}';
let configs=[], classes=[], currentRun=null, suppressRoster=false, rosterRows=[];
async function j(url,opt){const r=await fetch(url,opt);if(!r.ok)throw new Error(await r.text());return r.json();}
function unique(rows,key){return [...new Set(rows.map(r=>r[key]))].sort((a,b)=>String(a).localeCompare(String(b),'ko',{numeric:true}));}
function selectedConfig(){return configs.find(c=>String(c.year)===yearSel.value&&String(c.semester)===semesterSel.value&&String(c.grade)===gradeSel.value&&c.subject===subjectSel.value&&c.domain_name===domainSel.value);}
function options(sel,items,keep){const old=keep?sel.value:'';sel.innerHTML=items.map(v=>'<option value="'+v+'">'+v+'</option>').join('');if(items.map(String).includes(old))sel.value=old;}
function defaultYear(){return String(new Date().getFullYear());}
function defaultSemester(){const m=new Date().getMonth()+1;return String(m>=3&&m<=8?1:2);}
async function load(){
 configs=await j('/api/admin/configs');
 options(yearSel,unique(configs,'year'),false); if(unique(configs,'year').map(String).includes(defaultYear())) yearSel.value=defaultYear();
 refreshSemester(false); if([...semesterSel.options].some(o=>o.value===defaultSemester())) semesterSel.value=defaultSemester();
 refreshGrade(false); refreshSubject(false); refreshDomain(false); await loadClasses(); await loadRuns();
}
function scoped(level){
 return configs.filter(c=>(!yearSel.value||String(c.year)===yearSel.value)
  &&(level==='semester'||!semesterSel.value||String(c.semester)===semesterSel.value)
  &&(['semester','grade'].includes(level)||!gradeSel.value||String(c.grade)===gradeSel.value)
  &&(['semester','grade','subject'].includes(level)||!subjectSel.value||c.subject===subjectSel.value));
}
function refreshSemester(keep=true){options(semesterSel,unique(scoped('semester'),'semester'),keep);refreshGrade(keep);}
function refreshGrade(keep=true){options(gradeSel,unique(scoped('grade'),'grade'),keep);refreshSubject(keep);}
function refreshSubject(keep=true){options(subjectSel,unique(scoped('subject'),'subject'),keep);refreshDomain(keep);}
function refreshDomain(keep=true){options(domainSel,unique(scoped('domain'),'domain_name'),keep);}
async function loadClasses(){ const cfg=selectedConfig(); classes=cfg?await j('/api/admin/configs/'+cfg.id+'/classes'):[]; classSel.innerHTML=classes.map(c=>'<option value="'+c.id+'">'+c.room+' ('+c.student_count+'명)</option>').join(''); await loadClassRoster(); }
function runLabel(r){return (r.is_open?'[진행중] ':'[종료] ')+r.title+' / '+r.room+' / '+r.started_at;}
function setControlsLocked(locked){[yearSel,semesterSel,gradeSel,subjectSel,domainSel,classSel].forEach(el=>el.disabled=locked);targetFilter.style.display=locked?'none':'';const exitBtn=document.getElementById('exitBtn');if(exitBtn){if(locked){exitBtn.classList.add('disabled');exitBtn.removeAttribute('href');}else{exitBtn.classList.remove('disabled');exitBtn.setAttribute('href','app://launcher');}}}
function updateLinks(r){
 if(!r){links.innerHTML='';runToggle.textContent='시작';runToggle.className='';setControlsLocked(false);return;}
 runToggle.textContent=Number(r.is_open)?'종료':'시작';
 runToggle.className=Number(r.is_open)?'secondary':'';
 setControlsLocked(Number(r.is_open));
 links.innerHTML='<p><b>학생</b>: <a target="_blank" href="http://'+studentBase+'">http://'+studentBase+'</a></p><p><b>교사</b>: <a target="_blank" href="http://'+teacherBase+'">http://'+teacherBase+'</a></p>';
}
async function loadRuns(){ const rows=await j('/api/admin/runs'); currentRun=rows.find(r=>Number(r.is_open)); updateLinks(currentRun); await loadSubs(); }
function visibleRows(rows){return absentOnly.checked?rows.filter(s=>Number(s.artifact_count||0)===0):rows;}
function orderedRows(rows){return rows;}
function renderSummary(rows){
 const total=rows.length;
 const absent=rows.filter(s=>Number(s.is_absent||0)===1).length;
 const present=total-absent;
 const submitted=rows.filter(s=>Number(s.is_absent||0)!==1&&!!s.submission_id).length;
 const checked=rows.filter(s=>Number(s.is_absent||0)!==1&&(s.status==='accepted'||s.status==='no_file')&&Number(s.teacher_checked||0)===1).length;
 const done=present>0&&checked>=present;
 summary.className='summary '+(done?'summary-done':'');
 summary.innerHTML='<span>총원 '+total+'명</span><span>결시 '+absent+'명</span><span>실시 '+present+'명</span><span>제출 '+submitted+'명</span><span>확인 '+checked+'명</span>'+(done?'<strong class="complete-badge">전원 확인 완료</strong>':'');
}
function statusHtml(s){
 if(!s.submission_id)return Number(s.separate_artifact_count||0)>0?'<span class="ok">별도 산출물 있음</span>':'<span class="muted">미제출</span>';
 if(s.status==='rejected')return '<span class="danger">제출 실패</span><div class="muted">'+(s.reject_reason||'사유 없음')+'</div>';
 if(s.status==='no_file')return '<span class="muted">파일 미제출</span>';
 return '<span class="ok">'+(Number(s.accepted_count||0)>1?'새로 제출됨':'제출됨')+'</span>';
}
function rowHtml(s){
 const isAbsent=Number(s.is_absent||0)===1;
 const submitted=!!s.submission_id;
 const checked=Number(s.teacher_checked||0)===1;
 const confirmable=submitted&&(s.status==='accepted'||s.status==='no_file');
 const file=s.status==='accepted'?'<a target="_blank" rel="noopener" href="/file-preview/assignment/'+s.submission_id+'?filename='+encodeURIComponent(s.original_filename||'')+'">'+s.original_filename+'</a>':(s.status==='rejected'?'<span class="danger">저장 안 됨</span>':'<span class="muted">-</span>');
 const check=confirmable&&!isAbsent?'<input type="checkbox" '+(checked?'checked disabled':'')+' onchange="toggleCheck('+s.submission_id+',this.checked)">':'<span class="muted">-</span>';
 const absent='<input type="checkbox" '+(isAbsent?'checked':'')+' onchange="toggleRunAbsent('+s.run_student_id+',this.checked)">';
 return '<tr class="'+(isAbsent?'absent-row':'')+'"><td>'+absent+'</td><td>'+check+'</td><td>'+statusHtml(s)+'</td><td>'+(s.submitted_at||'-')+'</td><td>'+s.class_num+'</td><td>'+s.seat_num+'</td><td>'+s.name+'</td><td>'+(s.ip_address||'-')+'</td><td>'+file+'</td></tr>';
}
async function loadClassRoster(){ if(currentRun||suppressRoster)return; if(!classSel.value){rosterRows=[];summary.innerHTML='';submissions.innerHTML='';return;} rosterRows=await j('/api/admin/classes/'+classSel.value+'/students'); const visible=orderedRows(visibleRows(rosterRows)); renderSummary(visible); submissions.innerHTML='<table><thead><tr><th>결시 여부</th><th>상태</th><th>반</th><th>번호</th><th>이름</th></tr></thead><tbody>'+visible.map(s=>'<tr class="'+(Number(s.is_absent||0)===1?'absent-row':'')+'"><td><input type="checkbox" '+(Number(s.is_absent||0)===1?'checked':'')+' onchange="toggleAbsent('+s.id+',this.checked)"></td><td>'+(Number(s.is_absent||0)===1?'<span class="danger">결시</span>':'<span class="muted">대기</span>')+'</td><td>'+s.class_num+'</td><td>'+s.seat_num+'</td><td>'+s.name+'</td></tr>').join('')+'</tbody></table>'; }
async function loadSubs(){ if(!currentRun){await loadClassRoster();return;} const rows=await j('/api/teacher/runs/id/'+currentRun.id+'/submissions?sort='+sort.value); renderSummary(rows); submissions.innerHTML='<table><thead><tr><th>결시 여부</th><th>제출 확인</th><th>제출 상태</th><th>제출 시간</th><th>반</th><th>번호</th><th>이름</th><th>IP</th><th>파일</th></tr></thead><tbody>'+rows.map(rowHtml).join('')+'</tbody></table>'; }
async function toggleCheck(id,checked){ await j('/api/teacher/submissions/'+id+'/check',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({checked})}); await loadSubs(); }
async function toggleAbsent(id,absent){ await j('/api/admin/students/'+id+'/absent',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({absent})}); await loadSubs(); }
async function toggleRunAbsent(id,absent){ await j('/api/admin/run-students/'+id+'/absent',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({absent})}); await loadSubs(); }
async function startRun(body){
 let response=await fetch('/api/admin/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 let data=await response.json().catch(()=>({error:'평가를 시작하지 못했습니다.'}));
 if(response.status===409&&data.conflict==='existing_artifacts'){
  const message='선택한 학생 중 기존 산출물이 있는 학생 '+data.affectedStudentCount+'명(파일 '+data.affectedArtifactCount+'개)이 포함되어 있습니다.\\n\\n계속하면 기존 산출물을 휴지통으로 이동하고 해당 학생들도 처음부터 다시 실시합니다. 계속하시겠습니까?';
  if(!confirm(message))return false;
  response=await fetch('/api/admin/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,replaceExistingArtifacts:true})});
  data=await response.json().catch(()=>({error:'평가를 시작하지 못했습니다.'}));
 }
 if(!response.ok)throw new Error(data.error||'평가를 시작하지 못했습니다.');
 return true;
}
yearSel.onchange=()=>{suppressRoster=false;refreshSemester(false);loadClasses();}; semesterSel.onchange=()=>{suppressRoster=false;refreshGrade(false);loadClasses();}; gradeSel.onchange=()=>{suppressRoster=false;refreshSubject(false);loadClasses();}; subjectSel.onchange=()=>{suppressRoster=false;refreshDomain(false);loadClasses();}; domainSel.onchange=()=>{suppressRoster=false;loadClasses();}; classSel.onchange=()=>{suppressRoster=false;loadClassRoster();}; sort.onchange=loadSubs; absentOnly.onchange=loadSubs;
runToggle.onclick=async()=>{ try{if(currentRun){await j('/api/admin/runs/'+currentRun.id+'/end',{method:'POST'});currentRun=null;suppressRoster=false;updateLinks(null);await loadClassRoster();return;}const cfg=selectedConfig();if(!cfg||!classSel.value)return;const studentIds=visibleRows(rosterRows).map(s=>Number(s.id));if(!studentIds.length)return;suppressRoster=false;if(await startRun({configId:Number(cfg.id),assignmentClassId:Number(classSel.value),studentIds}))await loadRuns();}catch(error){alert(error.message||String(error));} };
setInterval(loadSubs,3000); load();
</script>`));
});

studentApp.get('/', async (_req, res) => {
  const run = await currentOpenRun();
  if (!run) {
    return res.send(page('수행평가 제출', `
<header><strong>수행평가 제출</strong><span class="danger">대기 중</span></header>
<main><section class="card"><h2>열린 수행이 없습니다</h2><p class="muted">교사가 수행을 시작하면 이 주소에서 바로 제출 화면이 열립니다.</p></section></main>`));
  }
  await renderStudentPage(run, '/api/public/submissions', res);
});

app.get('/s/:shareCode', async (req, res) => {
  const run = await runByShareCode(req.params.shareCode);
  if (!run) return res.status(404).send('수행 정보를 찾을 수 없습니다.');
  await renderStudentPage(run, `/api/public/runs/${req.params.shareCode}/submissions`, res);
});

teacherApp.get('/', async (req, res) => {
  const studentUrl = `http://${localIps()[0] || '127.0.0.1'}:${STUDENT_PORT}`;
  const studentLink = `<section class="card" style="margin-bottom:16px;text-align:center">
    <div class="muted">학생 접속 주소</div>
    <a href="${escapeHtml(studentUrl)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;font-size:32px;font-weight:800;word-break:break-all">${escapeHtml(studentUrl)}</a>
  </section>`;
  const run = await currentOpenRun();
  if (!run) {
    return res.send(page('교사용 확인', `
<header><strong>교사용 확인</strong><span class="danger">대기 중</span></header>
<main>${studentLink}<section class="card"><h2>진행 중인 수행이 없습니다</h2><p class="muted">수행이 시작되면 이 화면에 현황이 표시됩니다.</p></section></main>`));
  }
  if (!(await isTeacherAuthenticated(req, false))) {
    return res.send(page('교사용 확인', `
<header><strong>교사용 확인</strong><span class="muted">비밀번호 필요</span></header>
<main>
  ${studentLink}
  <section class="card" style="max-width:420px;margin:40px auto">
    <h2>교사 비밀번호</h2>
    <form method="post" action="/auth">
      <label>비밀번호</label>
      <input type="password" name="password" required autofocus style="width:100%">
      <div style="margin-top:12px"><button>확인</button></div>
    </form>
  </section>
</main>`));
  }
  res.send(page(`${run.title} 제출 현황`, `
<header><strong>${escapeHtml(run.title)} / ${escapeHtml(run.room)}</strong><div class="row"><span class="${run.is_open ? 'ok' : 'danger'}">${run.is_open ? '진행 중' : '종료'}</span><select id="sort"><option value="default">기본순</option><option value="recent">제출순</option></select></div></header>
<main>${studentLink}<div id="summary" class="summary"></div><div id="submissions"></div></main>
<script>
async function j(url,opt){const r=await fetch(url,opt);if(!r.ok)throw new Error(await r.text());return r.json();}
function renderSummary(rows){const total=rows.length;const absent=rows.filter(s=>Number(s.is_absent||0)===1).length;const present=total-absent;const submitted=rows.filter(s=>Number(s.is_absent||0)!==1&&!!s.submission_id).length;const checked=rows.filter(s=>Number(s.is_absent||0)!==1&&(s.status==='accepted'||s.status==='no_file')&&Number(s.teacher_checked||0)===1).length;const done=present>0&&checked>=present;summary.className='summary '+(done?'summary-done':'');summary.innerHTML='<span>총원 '+total+'명</span><span>결시 '+absent+'명</span><span>실시 '+present+'명</span><span>제출 '+submitted+'명</span><span>확인 '+checked+'명</span>'+(done?'<strong class="complete-badge">전원 확인 완료</strong>':'');}
function statusHtml(s){if(!s.submission_id)return Number(s.separate_artifact_count||0)>0?'<span class="ok">별도 산출물 있음</span>':'<span class="muted">미제출</span>';if(s.status==='rejected')return '<span class="danger">제출 실패</span><div class="muted">'+(s.reject_reason||'사유 없음')+'</div>';if(s.status==='no_file')return '<span class="muted">파일 미제출</span>';return '<span class="ok">'+(Number(s.accepted_count||0)>1?'새로 제출됨':'제출됨')+'</span>';}
function rowHtml(s){const isAbsent=Number(s.is_absent||0)===1;const submitted=!!s.submission_id;const checked=Number(s.teacher_checked||0)===1;const confirmable=submitted&&(s.status==='accepted'||s.status==='no_file');const file=s.status==='accepted'?'<a target="_blank" rel="noopener" href="/file-preview/assignment/'+s.submission_id+'?filename='+encodeURIComponent(s.original_filename||'')+'">'+s.original_filename+'</a>':(s.status==='rejected'?'<span class="danger">저장 안 됨</span>':'<span class="muted">-</span>');const check=confirmable&&!isAbsent?'<input type="checkbox" '+(checked?'checked disabled':'')+' onchange="toggleCheck('+s.submission_id+',this.checked)">':'<span class="muted">-</span>';const absent='<input type="checkbox" '+(isAbsent?'checked':'')+' onchange="toggleAbsent('+s.run_student_id+',this.checked)">';return '<tr class="'+(isAbsent?'absent-row':'')+'"><td>'+absent+'</td><td>'+check+'</td><td>'+statusHtml(s)+'</td><td>'+(s.submitted_at||'-')+'</td><td>'+s.class_num+'</td><td>'+s.seat_num+'</td><td>'+s.name+'</td><td>'+(s.ip_address||'-')+'</td><td>'+file+'</td></tr>';}
async function load(){const rows=await j('/api/submissions?sort='+sort.value);renderSummary(rows);submissions.innerHTML='<table><thead><tr><th>결시 여부</th><th>제출 확인</th><th>제출 상태</th><th>제출 시간</th><th>반</th><th>번호</th><th>이름</th><th>IP</th><th>파일</th></tr></thead><tbody>'+rows.map(rowHtml).join('')+'</tbody></table>'}
async function toggleCheck(id,checked){await j('/api/submissions/'+id+'/check',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({checked})});await load();}
async function toggleAbsent(id,absent){await j('/api/students/'+id+'/absent',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({absent})});await load();}
sort.onchange=load;setInterval(load,3000);load();
</script>`));
});

teacherApp.post('/auth', async (req, res) => {
  const passwordHash = await getTeacherPasswordHash();
  const password = String(req.body?.password || '');
  if (!passwordHash || verifyPassword(password, passwordHash)) {
    if (passwordHash) {
      res.setHeader('Set-Cookie', `assignment_teacher_auth=${encodeURIComponent(teacherAuthToken(passwordHash))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
    }
    return res.redirect('/');
  }
  res.status(401).send(page('교사용 확인', `
<header><strong>교사용 확인</strong><span class="danger">인증 실패</span></header>
<main>
  <section class="card" style="max-width:420px;margin:40px auto">
    <h2>비밀번호가 맞지 않습니다</h2>
    <p class="muted">다시 입력하세요.</p>
    <form method="post" action="/auth">
      <label>비밀번호</label>
      <input type="password" name="password" required autofocus style="width:100%">
      <div style="margin-top:12px"><button>확인</button></div>
    </form>
  </section>
</main>`));
});

app.get('/api/admin/configs', requireLocal, async (_req, res) => {
  res.json(await queryAll('SELECT * FROM assignment_configs ORDER BY year, semester, grade, subject, domain_name'));
});

app.get('/api/admin/configs/:id/classes', requireLocal, async (req, res) => {
  res.json(await queryAll(`SELECT ac.*, COUNT(ast.id) AS student_count FROM assignment_classes ac LEFT JOIN assignment_students ast ON ast.assignment_class_id=ac.id WHERE ac.config_id=? GROUP BY ac.id ORDER BY ac.room`, [req.params.id]));
});

app.get('/api/admin/classes/:id/students', requireLocal, async (req, res) => {
  res.json(await queryAll(
    `SELECT ast.id, ast.student_num, ast.class_num, ast.seat_num, ast.name, ast.is_absent, ast.absent_at,
       (
         SELECT COUNT(*) FROM assignment_artifacts aa
         WHERE aa.assessment_student_id=ast.assessment_student_id AND aa.domain=cfg.domain_name
       ) + (
         SELECT COUNT(*) FROM assignment_submissions sub
         JOIN assignment_runs run ON run.id=sub.run_id
         WHERE run.config_id=ac.config_id AND run.assignment_class_id=ac.id AND sub.status IN ('accepted', 'no_file')
           AND (sub.assignment_student_id=ast.id OR (sub.student_num=ast.student_num AND sub.name=ast.name))
       ) AS artifact_count
     FROM assignment_students ast
     JOIN assignment_classes ac ON ac.id=ast.assignment_class_id
     JOIN assignment_configs cfg ON cfg.id=ac.config_id
     WHERE ast.assignment_class_id=?
     ORDER BY ast.id`,
    [req.params.id]
  ));
});

async function setStudentAbsent(req: any, res: any) {
  const absent = req.body?.absent ? 1 : 0;
  await execute(
    `UPDATE assignment_students
     SET is_absent=?, absent_at=CASE WHEN ?=1 THEN datetime('now', 'localtime') ELSE '' END
     WHERE id=?`,
    [absent, absent, req.params.id]
  );
  const student = await queryOne<any>(
    `SELECT ast.id, ast.student_num, ast.class_num, ast.seat_num, ast.name, ast.is_absent, ast.absent_at,
            cfg.year, cfg.semester, cfg.grade, cfg.subject, cfg.domain_name, ac.room
     FROM assignment_students ast
     JOIN assignment_classes ac ON ac.id=ast.assignment_class_id
     JOIN assignment_configs cfg ON cfg.id=ac.config_id
     WHERE ast.id=?`,
    [req.params.id]
  );
  if (student) writeAssignmentLog(absent ? 'student_absent_checked' : 'student_absent_unchecked', student);
  res.json({ ok: true });
}

async function setRunStudentAbsent(req: any, res: any) {
  const absent = req.body?.absent ? 1 : 0;
  await execute(
    `UPDATE assignment_run_students
     SET is_absent=?, absent_at=CASE WHEN ?=1 THEN datetime('now', 'localtime') ELSE '' END
     WHERE id=?`,
    [absent, absent, req.params.id]
  );
  const student = await queryOne<any>(
    `SELECT rst.id AS run_student_id, rst.run_id, rst.student_num, rst.class_num, rst.seat_num,
            rst.name, rst.is_absent, rst.absent_at, cfg.year, cfg.semester, cfg.grade,
            cfg.subject, cfg.domain_name, ac.room
     FROM assignment_run_students rst
     JOIN assignment_runs run ON run.id=rst.run_id
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     WHERE rst.id=?`,
    [req.params.id]
  );
  if (!student) return res.status(404).json({ error: '수행 대상 학생을 찾을 수 없습니다.' });
  writeAssignmentLog(absent ? 'run_student_absent_checked' : 'run_student_absent_unchecked', student);
  res.json({ ok: true });
}

app.patch('/api/admin/students/:id/absent', requireLocal, setStudentAbsent);
app.patch('/api/admin/run-students/:id/absent', requireLocal, setRunStudentAbsent);

teacherApp.patch('/api/students/:id/absent', requireTeacherAuth, async (req, res) => {
  const run = await currentOpenRun();
  if (!run) return res.status(404).json({ error: '진행 중인 수행이 없습니다.' });
  const student = await queryOne<{ id: number }>(
    'SELECT id FROM assignment_run_students WHERE id=? AND run_id=?',
    [req.params.id, run.id]
  );
  if (!student) return res.status(404).json({ error: '현재 수행의 학생을 찾을 수 없습니다.' });
  await setRunStudentAbsent(req, res);
});

type ExistingArtifactFile = {
  id: number;
  filepath: string;
  source: 'submission' | 'artifact';
  assessmentStudentId: number;
};

async function existingArtifactFilesForStudents(configId: number, assignmentClassId: number, students: any[]) {
  const config = await queryOne<{ domain_name: string }>('SELECT domain_name FROM assignment_configs WHERE id=?', [configId]);
  if (!config) return { files: [] as ExistingArtifactFile[], affectedStudentIds: new Set<number>() };

  const byAssignmentStudentId = new Map(students.map(student => [Number(student.id), student]));
  const byIdentity = new Map(students.map(student => [`${Number(student.student_num)}\u0000${student.name}`, student]));
  const submissions = await queryAll<any>(
    `SELECT sub.id, sub.filepath, sub.assignment_student_id, sub.student_num, sub.name
     FROM assignment_submissions sub
     JOIN assignment_runs run ON run.id=sub.run_id
     WHERE run.config_id=? AND run.assignment_class_id=? AND sub.status='accepted'`,
    [configId, assignmentClassId]
  );
  const files: ExistingArtifactFile[] = [];
  for (const submission of submissions) {
    const student = byAssignmentStudentId.get(Number(submission.assignment_student_id))
      || byIdentity.get(`${Number(submission.student_num)}\u0000${submission.name}`);
    if (student) {
      files.push({
        id: Number(submission.id),
        filepath: String(submission.filepath || ''),
        source: 'submission',
        assessmentStudentId: Number(student.assessment_student_id),
      });
    }
  }

  const assessmentStudentIds = [...new Set(students.map(student => Number(student.assessment_student_id)).filter(Boolean))];
  if (assessmentStudentIds.length) {
    const artifacts = await queryAll<any>(
      `SELECT id, filepath, assessment_student_id
       FROM assignment_artifacts
       WHERE domain=? AND assessment_student_id IN (${assessmentStudentIds.map(() => '?').join(',')})`,
      [config.domain_name, ...assessmentStudentIds]
    );
    for (const artifact of artifacts) {
      files.push({
        id: Number(artifact.id),
        filepath: String(artifact.filepath || ''),
        source: 'artifact',
        assessmentStudentId: Number(artifact.assessment_student_id),
      });
    }
  }

  return {
    files,
    affectedStudentIds: new Set(files.map(file => file.assessmentStudentId)),
  };
}

app.post('/api/admin/runs', requireLocal, async (req, res) => {
  const configId = Number(req.body.configId);
  const assignmentClassId = Number(req.body.assignmentClassId);
  const requestedStudentIds = Array.isArray(req.body.studentIds)
    ? req.body.studentIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  if (!configId || !assignmentClassId) return res.status(400).json({ error: '설정과 강의실을 선택하세요.' });
  const students = await queryAll<any>(
    `SELECT id, assessment_student_id, student_num, class_num, seat_num, name, is_absent, absent_at
     FROM assignment_students
     WHERE assignment_class_id=? ${requestedStudentIds.length ? `AND id IN (${requestedStudentIds.map(() => '?').join(',')})` : ''}
     ORDER BY id`,
    [assignmentClassId, ...requestedStudentIds]
  );
  if (!students.length) return res.status(400).json({ error: '수행 대상 학생이 없습니다.' });
  const existing = await existingArtifactFilesForStudents(configId, assignmentClassId, students);
  if (existing.files.length && req.body?.replaceExistingArtifacts !== true) {
    return res.status(409).json({
      conflict: 'existing_artifacts',
      affectedStudentCount: existing.affectedStudentIds.size,
      affectedArtifactCount: existing.files.length,
    });
  }

  const movedFiles: Array<{ trashPath: string; originalFilepath: string }> = [];
  try {
    for (const file of existing.files) {
      const trashPath = moveFileToTrash(file.filepath, 'retest-replaced-artifacts');
      if (trashPath) movedFiles.push({ trashPath, originalFilepath: file.filepath });
    }

    const share = runCode();
    const viewer = runCode();
    let runId = 0;
    await transaction(async () => {
      const submissionIds = existing.files.filter(file => file.source === 'submission').map(file => file.id);
      const artifactIds = existing.files.filter(file => file.source === 'artifact').map(file => file.id);
      if (submissionIds.length) {
        await execute(
          `DELETE FROM assignment_submissions WHERE id IN (${submissionIds.map(() => '?').join(',')})`,
          submissionIds
        );
      }
      if (artifactIds.length) {
        await execute(
          `DELETE FROM assignment_artifacts WHERE id IN (${artifactIds.map(() => '?').join(',')})`,
          artifactIds
        );
      }
      await execute('UPDATE assignment_runs SET is_open=0, ended_at=datetime(\'now\', \'localtime\') WHERE is_open=1');
      await execute('UPDATE assignment_configs SET is_open=0');
      const r = await execute('INSERT INTO assignment_runs(config_id, assignment_class_id, share_code, viewer_code, is_open) VALUES(?,?,?,?,1)', [configId, assignmentClassId, share, viewer]);
      runId = Number(r.lastInsertRowid);
      for (const [index, student] of students.entries()) {
        await execute(
          `INSERT INTO assignment_run_students(
             run_id, assignment_student_id, assessment_student_id, student_num, class_num, seat_num,
             name, is_absent, absent_at, sort_order
           ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [runId, student.id, student.assessment_student_id, student.student_num, student.class_num, student.seat_num, student.name, student.is_absent, student.absent_at || '', index]
        );
      }
      await execute('UPDATE assignment_configs SET is_open=1, share_code=?, viewer_code=? WHERE id=?', [share, viewer, configId]);
    });

    try {
      const run = await queryOne<any>(
        `SELECT run.id, run.started_at, cfg.year, cfg.semester, cfg.grade, cfg.subject, cfg.domain_name, ac.room
         FROM assignment_runs run
         JOIN assignment_configs cfg ON cfg.id=run.config_id
         JOIN assignment_classes ac ON ac.id=run.assignment_class_id
         WHERE run.id=?`,
        [runId]
      );
      if (run) {
        if (existing.files.length) writeAssignmentLog('artifacts_replaced_for_retest', { ...run, affected_student_count: existing.affectedStudentIds.size, artifact_count: existing.files.length });
        writeAssignmentLog('run_started', { ...run, target_student_count: students.length });
      }
    } catch (logError) {
      console.error('Failed to write assignment start log:', logError);
    }
    return res.json({ id: runId, share_code: share, viewer_code: viewer, target_student_count: students.length });
  } catch (error) {
    for (const moved of movedFiles.reverse()) {
      try { restoreTrashedFile(moved.trashPath, moved.originalFilepath); } catch {}
    }
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/admin/runs/:id/end', requireLocal, async (req, res) => {
  const run = await queryOne<any>(
    `SELECT run.id, run.config_id, run.assignment_class_id, run.started_at, cfg.year, cfg.semester, cfg.grade, cfg.subject, cfg.domain_name, ac.room
     FROM assignment_runs run
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     WHERE run.id=?`,
    [req.params.id]
  );
  if (!run) return res.status(404).json({ error: '실행 정보를 찾을 수 없습니다.' });
  await execute('UPDATE assignment_runs SET is_open=0, ended_at=datetime(\'now\', \'localtime\') WHERE id=?', [req.params.id]);
  await execute('UPDATE assignment_configs SET is_open=0 WHERE id=?', [run.config_id]);
  await execute('UPDATE assignment_students SET is_absent=0, absent_at=\'\' WHERE assignment_class_id=?', [run.assignment_class_id]);
  writeAssignmentLog('run_ended', { ...run, ended_at: new Date().toLocaleString('sv-SE') });
  res.json({ ok: true });
});

app.get('/api/admin/runs', requireLocal, async (_req, res) => {
  res.json(await queryAll(`SELECT run.*, cfg.title, ac.room FROM assignment_runs run JOIN assignment_configs cfg ON cfg.id=run.config_id JOIN assignment_classes ac ON ac.id=run.assignment_class_id ORDER BY run.started_at DESC`));
});

async function sendStudentResource(req: any, res: any) {
  const resource = await queryOne<any>(
    `SELECT resource.filename, resource.filepath, resource.mime_type, config.grade
     FROM assignment_resources resource
     JOIN assignment_configs config ON config.id=resource.config_id
     WHERE resource.id=?`,
    [req.params.id]
  );
  const filepath = resource ? resolveStoredPath(resource.filepath) : '';
  if (!resource || !fs.existsSync(filepath)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const classNum = Number(req.query.classNum);
  const seatNum = Number(req.query.seatNum);
  const name = String(req.query.name || '').trim();
  if (!Number.isInteger(classNum) || classNum < 1 || !Number.isInteger(seatNum) || seatNum < 1 || !name) {
    return res.status(400).json({ error: '학년, 반, 번호, 이름을 먼저 입력하세요.' });
  }
  res.setHeader('Content-Type', resource.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(studentDownloadFilename(Number(resource.grade), classNum, seatNum, name, resource.filename))}`);
  res.sendFile(path.resolve(filepath));
}

app.get('/api/public/resources/:id/file', sendStudentResource);

function cleanupTempFiles(files: any[] = []) {
  for (const file of files) {
    try {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch {}
  }
}

async function recordRejectedSubmission(req: any, run: any, student: any, studentNum: number, classNum: number, seatNum: number, name: string, file: any | null, reason: string) {
  const original = file ? decodeUploadFilename(file.originalname) : '';
  const inserted = await execute(
    `INSERT INTO assignment_submissions(
       run_id, assignment_student_id, student_num, class_num, seat_num, name, ip_address,
       original_filename, stored_filename, filepath, mime_type, size, status, reject_reason,
       user_agent, teacher_checked, teacher_checked_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'')`,
    [
      run.id,
      student?.id || null,
      studentNum,
      classNum,
      seatNum,
      name,
      clientIp(req),
      original,
      '',
      '',
      file?.mimetype || '',
      file?.size || 0,
      'rejected',
      reason,
      String(req.headers['user-agent'] || '')
    ]
  );
  writeAssignmentLog('submission_failed', {
    run_id: run.id,
    submission_id: Number(inserted.lastInsertRowid),
    year: run.year,
    semester: run.semester,
    grade: run.grade,
    subject: run.subject,
    domain_name: run.domain_name,
    room: run.room,
    student_num: studentNum,
    class_num: classNum,
    seat_num: seatNum,
    name,
    ip_address: clientIp(req),
    original_filename: original,
    size: file?.size || 0,
    reject_reason: reason,
    user_agent: String(req.headers['user-agent'] || '')
  });
}

async function recordNoFileSubmission(req: any, run: any, student: any, studentNum: number, classNum: number, seatNum: number, name: string) {
  const inserted = await execute(
    `INSERT INTO assignment_submissions(
       run_id, assignment_student_id, student_num, class_num, seat_num, name, ip_address,
       original_filename, stored_filename, filepath, mime_type, size, status, reject_reason,
       user_agent, teacher_checked, teacher_checked_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'')`,
    [
      run.id,
      student?.id || null,
      studentNum,
      classNum,
      seatNum,
      name,
      clientIp(req),
      '',
      '',
      '',
      '',
      0,
      'no_file',
      '',
      String(req.headers['user-agent'] || '')
    ]
  );
  writeAssignmentLog('submission_no_file', {
    run_id: run.id,
    submission_id: Number(inserted.lastInsertRowid),
    year: run.year,
    semester: run.semester,
    grade: run.grade,
    subject: run.subject,
    domain_name: run.domain_name,
    room: run.room,
    student_num: studentNum,
    class_num: classNum,
    seat_num: seatNum,
    name,
    ip_address: clientIp(req),
    user_agent: String(req.headers['user-agent'] || '')
  });
}

async function handleSubmission(req: any, res: any, run: any) {
  const files = req.files as any[];
  if (!run || !run.is_open) return res.status(403).json({ error: '제출이 열려 있지 않습니다.' });
  const classNum = Number(req.body.classNum);
  const seatNum = Number(req.body.seatNum);
  const name = String(req.body.name || '').trim();
  if (!classNum || !seatNum || !name) return res.status(400).json({ error: '반, 번호, 이름을 입력하세요.' });
  const studentNum = Number(run.grade) * 10000 + classNum * 100 + seatNum;
  const student = await queryOne<any>('SELECT id FROM assignment_students WHERE assignment_class_id=? AND student_num=? AND name=?', [run.ac_id, studentNum, name]);
  const runStudent = student
    ? await queryOne<{ id: number }>(
        `SELECT id FROM assignment_run_students
         WHERE run_id=? AND (assignment_student_id=? OR (student_num=? AND name=?))`,
        [run.id, student.id, studentNum, name]
      )
    : null;
  if (!runStudent) {
    cleanupTempFiles(files);
    return res.status(403).json({ error: '현재 수행 대상 학생이 아닙니다.' });
  }
  const checkedSubmission = await queryOne(
    `SELECT 1 FROM assignment_submissions
     WHERE run_id=? AND teacher_checked=1
       AND (assignment_student_id=? OR (student_num=? AND name=?))
     LIMIT 1`,
    [run.id, student.id, studentNum, name]
  );
  if (checkedSubmission) {
    cleanupTempFiles(files);
    return res.status(409).json({ error: '교사가 제출을 확인하여 추가로 제출할 수 없습니다.' });
  }
  const noFile = ['1', 'true', 'on'].includes(String(req.body.noFile || '').toLowerCase());
  if (noFile) {
    cleanupTempFiles(files);
    await recordNoFileSubmission(req, run, student, studentNum, classNum, seatNum, name);
    return res.json({ message: '파일 미제출로 기록했습니다.' });
  }
  if (!files?.length) {
    await recordRejectedSubmission(req, run, student, studentNum, classNum, seatNum, name, null, '파일이 없습니다.');
    return res.status(400).json({ error: '파일이 없습니다.' });
  }
  const rules = submissionRules(run.allowed_extensions, Number(run.max_file_size_mb || 50), Number(run.max_files || 1));
  if (!rules.length && files.length > Number(run.max_files || 1)) {
    const reason = `최대 ${run.max_files}개까지 제출할 수 있습니다.`;
    await recordRejectedSubmission(req, run, student, studentNum, classNum, seatNum, name, files[0], reason);
    cleanupTempFiles(files);
    return res.status(400).json({ error: reason });
  }
  const ruleByExtension = new Map(rules.map(rule => [rule.extension, rule]));
  const counts = new Map<string, number>();
  for (const file of files) {
    const original = decodeUploadFilename(file.originalname);
    const ext = path.extname(original).toLowerCase().replace(/^\./, '');
    const rule = rules.length ? ruleByExtension.get(ext) : { extension: ext, max_file_size_mb: Number(run.max_file_size_mb || 50), max_files: Number(run.max_files || 1) };
    if (!rule) {
      const reason = ext ? `허용되지 않은 확장자입니다: .${ext}` : '확장자가 없는 파일은 제출할 수 없습니다.';
      await recordRejectedSubmission(req, run, student, studentNum, classNum, seatNum, name, file, reason);
      cleanupTempFiles(files);
      return res.status(400).json({ error: reason });
    }
    const count = (counts.get(ext) || 0) + 1;
    counts.set(ext, count);
    if (count > rule.max_files) {
      const reason = `.${ext} 파일은 최대 ${rule.max_files}개까지 제출할 수 있습니다.`;
      await recordRejectedSubmission(req, run, student, studentNum, classNum, seatNum, name, file, reason);
      cleanupTempFiles(files);
      return res.status(400).json({ error: reason });
    }
    if (file.size > rule.max_file_size_mb * 1024 * 1024) {
      const reason = `${original} 파일이 ${rule.max_file_size_mb}MB 제한을 초과했습니다.`;
      await recordRejectedSubmission(req, run, student, studentNum, classNum, seatNum, name, file, reason);
      cleanupTempFiles(files);
      return res.status(400).json({ error: reason });
    }
  }
  const baseDir = path.join(SUBMISSIONS_DIR, String(run.year), String(run.semester), String(run.grade), safeSegment(run.subject), safeSegment(run.room), safeSegment(run.domain_name));
  fs.mkdirSync(baseDir, { recursive: true });
  for (const [index, file] of files.entries()) {
    const original = decodeUploadFilename(file.originalname);
    const ext = path.extname(original).toLowerCase();
    const stored = `${studentNum}_${safeSegment(name)}${files.length > 1 ? `_${index + 1}` : ''}${ext}`;
    const finalPath = path.join(baseDir, `${Date.now()}_${stored}`);
    fs.renameSync(file.path, finalPath);
    const inserted = await execute(
      `INSERT INTO assignment_submissions(
         run_id, assignment_student_id, student_num, class_num, seat_num, name, ip_address,
         original_filename, stored_filename, filepath, mime_type, size, status, reject_reason,
         user_agent, teacher_checked, teacher_checked_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'')`,
      [run.id, student?.id || null, studentNum, classNum, seatNum, name, clientIp(req), original, stored, toStoredPath(finalPath), file.mimetype || '', file.size || 0, 'accepted', '', String(req.headers['user-agent'] || '')]
    );
    writeAssignmentLog('submission_created', {
      run_id: run.id,
      submission_id: Number(inserted.lastInsertRowid),
      year: run.year,
      semester: run.semester,
      grade: run.grade,
      subject: run.subject,
      domain_name: run.domain_name,
      room: run.room,
      student_num: studentNum,
      class_num: classNum,
      seat_num: seatNum,
      name,
      ip_address: clientIp(req),
      original_filename: original,
      stored_filename: stored,
      size: file.size || 0,
      user_agent: String(req.headers['user-agent'] || '')
    });
  }
  res.json({ message: `${files.length}개 파일을 제출했습니다.` });
}

studentApp.post('/api/public/submissions', upload.array('files', 20), async (req, res) => {
  const run = await currentOpenRun();
  await handleSubmission(req, res, run);
});

studentApp.get('/api/public/resources/:id/file', sendStudentResource);

app.post('/api/public/runs/:shareCode/submissions', upload.array('files', 20), async (req, res) => {
  const run = await runByShareCode(req.params.shareCode);
  await handleSubmission(req, res, run);
});

async function submissionsForRun(runId: string | number, sort: string) {
  return submissionStatusForRun(runId, sort);
}

app.get('/api/teacher/runs/id/:runId/submissions', requireLocal, async (req, res) => {
  res.json(await submissionsForRun(req.params.runId, String(req.query.sort || 'recent')));
});

teacherApp.get('/api/submissions', requireTeacherAuth, async (req, res) => {
  const run = await currentOpenRun();
  if (!run) return res.status(404).json({ error: '진행 중인 수행이 없습니다.' });
  res.json(await submissionsForRun(run.id, String(req.query.sort || 'recent')));
});

async function checkSubmission(req: any, res: any) {
  const checked = req.body?.checked ? 1 : 0;
  const existing = await queryOne<any>('SELECT teacher_checked, status FROM assignment_submissions WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: '제출 정보를 찾을 수 없습니다.' });
  if (existing.status === 'rejected') return res.status(400).json({ error: '실패한 제출은 확인할 수 없습니다.' });
  if (Number(existing.teacher_checked || 0) === 1) return res.status(409).json({ error: '이미 확인 완료된 제출은 수정할 수 없습니다.' });
  if (!checked) return res.status(400).json({ error: '확인 해제는 할 수 없습니다.' });
  await execute(
    `UPDATE assignment_submissions
     SET teacher_checked=?, teacher_checked_at=CASE WHEN ?=1 THEN datetime('now', 'localtime') ELSE '' END
     WHERE id=?`,
    [checked, checked, req.params.id]
  );
  const sub = await queryOne<any>(
    `SELECT sub.id AS submission_id, sub.run_id, sub.student_num, sub.class_num, sub.seat_num, sub.name,
            sub.original_filename, sub.teacher_checked, sub.teacher_checked_at,
            cfg.year, cfg.semester, cfg.grade, cfg.subject, cfg.domain_name, ac.room
     FROM assignment_submissions sub
     JOIN assignment_runs run ON run.id=sub.run_id
     JOIN assignment_configs cfg ON cfg.id=run.config_id
     JOIN assignment_classes ac ON ac.id=run.assignment_class_id
     WHERE sub.id=?`,
    [req.params.id]
  );
  if (sub) writeAssignmentLog('teacher_checked', sub);
  res.json({ ok: true });
}

app.patch('/api/teacher/submissions/:id/check', requireTeacherAuth, checkSubmission);
teacherApp.patch('/api/submissions/:id/check', requireTeacherAuth, checkSubmission);

async function sendSubmissionFile(req: any, res: any) {
  const sub = await queryOne<any>('SELECT original_filename, filepath, mime_type FROM assignment_submissions WHERE id=?', [req.params.id]);
  const filepath = sub ? resolveStoredPath(sub.filepath) : '';
  if (!sub || !fs.existsSync(filepath)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.setHeader('Content-Type', sub.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(sub.original_filename)}`);
  res.sendFile(path.resolve(filepath));
}

app.get('/api/teacher/submissions/:id/file', requireTeacherAuth, sendSubmissionFile);
teacherApp.get('/api/submissions/:id/file', requireTeacherAuth, sendSubmissionFile);

function sendArtifactViewer(_req: any, res: any) {
  const indexPath = path.join(ASSESSMENT_CLIENT_DIST, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(503).send('산출물 뷰어가 준비되지 않았습니다. 평가 관리 화면을 먼저 빌드하세요.');
  }
  res.sendFile(indexPath);
}

// 평가 관리 뷰어는 이 API 경로로 평가 실시 제출 파일을 읽는다.
app.get('/api/assignment-configs/submissions/:id/file', requireLocal, sendSubmissionFile);
teacherApp.get('/api/assignment-configs/submissions/:id/file', requireTeacherAuth, sendSubmissionFile);
app.get('/file-preview/assignment/:id', requireLocal, sendArtifactViewer);
teacherApp.get('/file-preview/assignment/:id', requireTeacherAuth, sendArtifactViewer);

initDb().then(() => {
  app.listen(ADMIN_PORT, ADMIN_HOST, () => {
    console.log(`Assignment admin server running at http://${ADMIN_HOST}:${ADMIN_PORT}`);
  });
  teacherApp.listen(TEACHER_PORT, PUBLIC_HOST, () => {
    console.log(`Assignment teacher viewer running at http://${PUBLIC_HOST}:${TEACHER_PORT}`);
  });
  studentApp.listen(STUDENT_PORT, PUBLIC_HOST, () => {
    console.log(`Assignment student server running at http://${PUBLIC_HOST}:${STUDENT_PORT}`);
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
