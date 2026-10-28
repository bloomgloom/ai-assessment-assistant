// @ts-nocheck
const yearSel=document.querySelector('#year'), semesterSel=document.querySelector('#semester'), gradeSel=document.querySelector('#grade'), subjectSel=document.querySelector('#subject'), domainSel=document.querySelector('#domain'), classSel=document.querySelector('#class');
const pageConfig=JSON.parse(document.getElementById('pageConfig').textContent||'{}');
const teacherBase=pageConfig.teacherBase;
const studentBase=pageConfig.studentBase;
let configs=[], classes=[], currentRun=null, suppressRoster=false, rosterRows=[], runActionPending=false;
async function j(url,opt){const r=await fetch(url,opt);if(!r.ok)throw new Error(await r.text());return r.json();}
function h(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function unique(rows,key){return [...new Set(rows.map(r=>r[key]))].sort((a,b)=>String(a).localeCompare(String(b),'ko',{numeric:true}));}
function selectedConfig(){return configs.find(c=>String(c.year)===yearSel.value&&String(c.semester)===semesterSel.value&&String(c.grade)===gradeSel.value&&c.subject===subjectSel.value&&c.domain_name===domainSel.value);}
function options(sel,items,keep){const old=keep?sel.value:'';sel.innerHTML=items.map(v=>'<option value="'+v+'">'+v+'</option>').join('');if(items.map(String).includes(old))sel.value=old;}
function defaultYear(){return String(new Date().getFullYear());}
function defaultSemester(){const m=new Date().getMonth()+1;return String(m>=3&&m<=8?1:2);}
async function load(){
 configs=await j('/api/admin/configs');
 const guideRefreshFailures=configs.filter(c=>c.guide_fetch_error);
 if(guideRefreshFailures.length)alert('최신 안내문을 불러오지 못한 평가 영역이 있습니다. 저장된 안내문으로 계속합니다.\n\n'+guideRefreshFailures.map(c=>c.domain_name+': '+c.guide_fetch_error).join('\n'));
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
 if(s.pending_approval)return '<span class="danger">확인 필요</span>';
 if(!s.submission_id)return Number(s.separate_artifact_count||0)>0?'<span class="ok">별도 산출물 있음</span>':'<span class="muted">미제출</span>';
 if(s.status==='rejected')return '<span class="danger">제출 실패</span><div class="muted">'+(s.reject_reason||'사유 없음')+'</div>';
 if(s.status==='no_file')return '<span class="muted">파일 미제출</span>';
 return '<span class="ok">'+(Number(s.accepted_count||0)>1?'새로 제출됨':'제출됨')+'</span>';
}
function rowHtml(s){
 const isAbsent=Number(s.is_absent||0)===1;
 const submitted=!!s.submission_id;
 const checked=Number(s.teacher_checked||0)===1;
 const confirmable=!s.pending_approval&&submitted&&(s.status==='accepted'||s.status==='no_file');
 const pending=s.pending_approval?'<div>'+s.pending_approval.files.map(item=>'<div>'+h(item.filename)+' ('+Math.ceil(Number(item.size)/1024/1024)+'MB)</div>').join('')+'<div class="row"><button onclick="decideApproval('+s.pending_approval.id+',&quot;approve&quot;)">승인</button><button class="secondary" onclick="decideApproval('+s.pending_approval.id+',&quot;reject&quot;)">거부</button></div></div>':'';
 const file=pending||(s.status==='accepted'?(Array.isArray(s.active_files)&&s.active_files.length?s.active_files.map(item=>'<div><span class="muted">'+h(item.submission_slot_name||'파일')+'</span> <a target="_blank" rel="noopener" href="/file-preview/assignment/'+item.id+'?filename='+encodeURIComponent(item.original_filename||'')+'">'+h(item.original_filename)+'</a></div>').join(''):'<a target="_blank" rel="noopener" href="/file-preview/assignment/'+s.submission_id+'?filename='+encodeURIComponent(s.original_filename||'')+'">'+h(s.original_filename)+'</a>'):(s.status==='rejected'?'<span class="danger">저장 안 됨</span>':'<span class="muted">-</span>'));
 const check=confirmable&&!isAbsent?'<input type="checkbox" '+(checked?'checked disabled':'')+' onchange="toggleCheck('+s.submission_id+',this.checked)">':'<span class="muted">-</span>';
 const absent='<input type="checkbox" '+(isAbsent?'checked':'')+' onchange="toggleRunAbsent('+s.run_student_id+',this.checked)">';
 return '<tr class="'+(isAbsent?'absent-row':'')+'"><td>'+absent+'</td><td>'+check+'</td><td>'+statusHtml(s)+'</td><td>'+(s.submitted_at||'-')+'</td><td>'+s.class_num+'</td><td>'+s.seat_num+'</td><td>'+s.name+'</td><td>'+(s.ip_address||'-')+'</td><td>'+file+'</td></tr>';
}
async function loadClassRoster(){ if(currentRun||suppressRoster)return; if(!classSel.value){rosterRows=[];summary.innerHTML='';submissions.innerHTML='';return;} rosterRows=await j('/api/admin/classes/'+classSel.value+'/students'); const visible=orderedRows(visibleRows(rosterRows)); renderSummary(visible); submissions.innerHTML='<table><thead><tr><th>결시 여부</th><th>상태</th><th>반</th><th>번호</th><th>이름</th></tr></thead><tbody>'+visible.map(s=>'<tr class="'+(Number(s.is_absent||0)===1?'absent-row':'')+'"><td><input type="checkbox" '+(Number(s.is_absent||0)===1?'checked':'')+' onchange="toggleAbsent('+s.id+',this.checked)"></td><td>'+(Number(s.is_absent||0)===1?'<span class="danger">결시</span>':'<span class="muted">대기</span>')+'</td><td>'+s.class_num+'</td><td>'+s.seat_num+'</td><td>'+s.name+'</td></tr>').join('')+'</tbody></table>'; }
async function loadSubs(){ if(!currentRun){await loadClassRoster();return;} const rows=await j('/api/teacher/runs/id/'+currentRun.id+'/submissions?sort='+sort.value); renderSummary(rows); submissions.innerHTML='<table><thead><tr><th>결시 여부</th><th>제출 확인</th><th>제출 상태</th><th>제출 시간</th><th>반</th><th>번호</th><th>이름</th><th>IP</th><th>파일</th></tr></thead><tbody>'+rows.map(rowHtml).join('')+'</tbody></table>'; }
async function toggleCheck(id,checked){ await j('/api/teacher/submissions/'+id+'/check',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({checked})}); await loadSubs(); }
async function decideApproval(id,decision){await j('/api/admin/submission-approvals/'+id+'/'+decision,{method:'POST'});await loadSubs();}
async function toggleAbsent(id,absent){ await j('/api/admin/students/'+id+'/absent',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({absent})}); await loadSubs(); }
async function toggleRunAbsent(id,absent){ await j('/api/admin/run-students/'+id+'/absent',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({absent})}); await loadSubs(); }
async function startRun(body){
 let response=await fetch('/api/admin/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 let data=await response.json().catch(()=>({error:'평가를 시작하지 못했습니다.'}));
 if(response.status===409&&data.conflict==='existing_artifacts'){
  const message='선택한 학생 중 기존 산출물이 있는 학생 '+data.affectedStudentCount+'명(파일 '+data.affectedArtifactCount+'개)이 포함되어 있습니다.\n\n계속하면 기존 산출물을 휴지통으로 이동하고 해당 학생들도 처음부터 다시 실시합니다. 계속하시겠습니까?';
  if(!confirm(message))return false;
  response=await fetch('/api/admin/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,replaceExistingArtifacts:true})});
  data=await response.json().catch(()=>({error:'평가를 시작하지 못했습니다.'}));
 }
 if(!response.ok)throw new Error(data.error||'평가를 시작하지 못했습니다.');
 if(Array.isArray(data.warnings)&&data.warnings.length)alert(data.warnings.join('\n'));
 return true;
}
yearSel.onchange=()=>{suppressRoster=false;refreshSemester(false);loadClasses();}; semesterSel.onchange=()=>{suppressRoster=false;refreshGrade(false);loadClasses();}; gradeSel.onchange=()=>{suppressRoster=false;refreshSubject(false);loadClasses();}; subjectSel.onchange=()=>{suppressRoster=false;refreshDomain(false);loadClasses();}; domainSel.onchange=()=>{suppressRoster=false;loadClasses();}; classSel.onchange=()=>{suppressRoster=false;loadClassRoster();}; sort.onchange=loadSubs; absentOnly.onchange=loadSubs;
runToggle.onclick=async()=>{
 if(runActionPending)return;
 runActionPending=true;
 runToggle.disabled=true;
 runToggle.textContent=currentRun?'종료 중...':'확인 중...';
 try{
  if(currentRun){await j('/api/admin/runs/'+currentRun.id+'/end',{method:'POST'});currentRun=null;suppressRoster=false;updateLinks(null);await loadClassRoster();return;}
  const cfg=selectedConfig();
  if(!cfg||!classSel.value)return;
  const studentIds=visibleRows(rosterRows).map(s=>Number(s.id));
  if(!studentIds.length)return;
  suppressRoster=false;
  if(await startRun({configId:Number(cfg.id),assignmentClassId:Number(classSel.value),studentIds}))await loadRuns();
 }catch(error){
  alert(error.message||String(error));
 }finally{
  runActionPending=false;
  runToggle.disabled=false;
  updateLinks(currentRun);
 }
};
setInterval(loadSubs,3000); load();
