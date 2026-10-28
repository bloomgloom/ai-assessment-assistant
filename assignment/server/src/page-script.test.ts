import { createClient } from '@libsql/client';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function assertPageScripts(html: string, label: string) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  if (!scripts.length) throw new Error(`${label}: 검사할 인라인 스크립트가 없습니다.`);
  scripts.forEach((script, index) => {
    try {
      new Function(script);
    } catch (error) {
      throw new Error(`${label} script ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function main() {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment-page-script-'));
  const [adminPort, teacherPort, studentPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const child = spawn(process.execPath, [path.resolve(__dirname, 'index.js')], {
    env: {
      ...process.env,
      APP_STORAGE_DIR: storageRoot,
      ADMIN_PORT: String(adminPort),
      TEACHER_PORT: String(teacherPort),
      STUDENT_PORT: String(studentPort),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('임시 실시 서버 시작 시간 초과')), 10000);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`임시 실시 서버가 종료되었습니다: ${code}`)));
      child.stdout?.on('data', chunk => {
        if (String(chunk).includes('Assignment student server running')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const db = createClient({ url: `file:${path.join(storageRoot, 'data', 'assignment.db')}` });
    const config = await db.execute({
      sql: `INSERT INTO assignment_configs(year,semester,grade,subject,domain_name,title,allowed_extensions) VALUES(?,?,?,?,?,?,?)`,
      args: [2099, 1, 1, '테스트', '스크립트', '스크립트 테스트', JSON.stringify([{ id: 'test-file', name: '파일', extension: 'txt', required: true, max_file_size_mb: 50, max_files: 1 }])],
    });
    const configId = Number(config.lastInsertRowid);
    const assignmentClass = await db.execute({
      sql: `INSERT INTO assignment_classes(config_id,assessment_class_id,room) VALUES(?,?,?)`,
      args: [configId, 1, '1'],
    });
    await db.execute({
      sql: `INSERT INTO assignment_runs(config_id,assignment_class_id,share_code,viewer_code,is_open,guide_md_snapshot,submission_rules_snapshot) VALUES(?,?,?,?,1,'',?)`,
      args: [configId, Number(assignmentClass.lastInsertRowid), 'script-share', 'script-viewer', JSON.stringify([{ id: 'test-file', name: '파일', extension: 'txt', required: true, max_file_size_mb: 50, max_files: 1 }])],
    });
    db.close();

    for (const [label, url] of [
      ['실시 관리', `http://127.0.0.1:${adminPort}/`],
      ['교사 현황판', `http://127.0.0.1:${teacherPort}/`],
      ['학생 제출', `http://127.0.0.1:${studentPort}/`],
    ] as const) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
      assertPageScripts(await response.text(), label);
    }
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
