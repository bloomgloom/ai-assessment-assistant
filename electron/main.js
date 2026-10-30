const { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, screen } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const ASSESSMENT_HOST = '127.0.0.1';
const DEFAULT_ASSESSMENT_PORT = 3201;
const ASSIGNMENT_HOST = '0.0.0.0';
const DEFAULT_ASSIGNMENT_ADMIN_PORT = 3002;
const DEFAULT_ASSIGNMENT_TEACHER_PORT = 3003;
const DEFAULT_ASSIGNMENT_STUDENT_PORT = 10000;

app.setName('ai-assessment-assistant');
app.setPath('userData', path.join(app.getPath('appData'), 'ai-assessment-assistant'));
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow = null;
let serverProcess = null;
let assessmentPort = null;
let assignmentAdminPort = null;
let assignmentTeacherPort = null;
let assignmentStudentPort = null;
let activeMode = null;
let isForceQuit = false;
let isForceWindowClose = false;
let closeConfirmationInProgress = false;
let displaySleepBlockerId = null;
let lastFileDialogDir = null;
let fileDialogPrefsLoaded = false;
let windowStateSaveTimer = null;

const DEFAULT_WINDOW_BOUNDS = {
  width: 1440,
  height: 960,
};

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function normalizeWindowBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    return DEFAULT_WINDOW_BOUNDS;
  }

  const candidate = {
    x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : 0,
    y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : 0,
    width: Math.max(1100, Math.round(bounds.width)),
    height: Math.max(720, Math.round(bounds.height)),
  };
  const workArea = screen.getDisplayMatching(candidate).workArea;
  const width = Math.min(candidate.width, workArea.width);
  const height = Math.min(candidate.height, workArea.height);
  return {
    x: Math.min(Math.max(candidate.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(candidate.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf8'));
    return {
      bounds: normalizeWindowBounds(state.bounds),
      isMaximized: state.isMaximized === true,
    };
  } catch {
    return {
      bounds: DEFAULT_WINDOW_BOUNDS,
      isMaximized: false,
    };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), JSON.stringify({
      bounds: mainWindow.getNormalBounds(),
      isMaximized: mainWindow.isMaximized(),
    }, null, 2));
  } catch {
    // 창 상태 저장 실패는 앱 동작을 막지 않습니다.
  }
}

function scheduleWindowStateSave() {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowState();
  }, 250);
}

function getFileDialogPrefsPath() {
  return path.join(app.getPath('userData'), 'file-dialog-prefs.json');
}

function loadFileDialogPrefs() {
  if (fileDialogPrefsLoaded) return;
  fileDialogPrefsLoaded = true;
  try {
    const prefs = JSON.parse(fs.readFileSync(getFileDialogPrefsPath(), 'utf8'));
    if (typeof prefs.lastDir === 'string' && fs.existsSync(prefs.lastDir)) {
      lastFileDialogDir = prefs.lastDir;
    }
  } catch {
    lastFileDialogDir = null;
  }
}

function saveFileDialogPrefs() {
  if (!lastFileDialogDir) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getFileDialogPrefsPath(), JSON.stringify({ lastDir: lastFileDialogDir }, null, 2));
  } catch {
    // Remembering the last file dialog location is a convenience feature.
  }
}

function getLastFileDialogDir() {
  loadFileDialogPrefs();
  if (lastFileDialogDir && fs.existsSync(lastFileDialogDir)) return lastFileDialogDir;
  return app.getPath('downloads');
}

function rememberFileDialogPath(filePath) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  if (fs.existsSync(dir)) {
    lastFileDialogDir = dir;
    saveFileDialogPrefs();
  }
}

function fileDialogDefaultPath(filename) {
  return path.join(getLastFileDialogDir(), filename || '');
}

function setDisplaySleepPrevention(enabled) {
  if (enabled) {
    if (displaySleepBlockerId === null || !powerSaveBlocker.isStarted(displaySleepBlockerId)) {
      displaySleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    }
    return true;
  }

  if (displaySleepBlockerId !== null && powerSaveBlocker.isStarted(displaySleepBlockerId)) {
    powerSaveBlocker.stop(displaySleepBlockerId);
  }
  displaySleepBlockerId = null;
  return false;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function getAppRoot() {
  return app.getAppPath();
}

function getAssessmentServerEntry() {
  return path.join(getAppRoot(), 'assessment', 'server', 'dist', 'index.js');
}

function getAssignmentServerEntry() {
  return path.join(getAppRoot(), 'assignment', 'server', 'dist', 'index.js');
}

function getAppStorageDir() {
  return path.join(app.getPath('userData'), 'storage');
}

function getBundledPythonPath() {
  const platformPath = process.platform === 'win32'
    ? path.join('Scripts', 'python.exe')
    : path.join('bin', 'python3');
  const relativePath = path.join('assessment', 'python', '.venv', platformPath);
  const candidates = [
    path.join(getAppRoot(), relativePath),
    path.join(process.resourcesPath, 'app.asar.unpacked', relativePath)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function getDesktopProcessPath() {
  const current = process.env.PATH || '';
  if (process.platform !== 'darwin') return current;
  return ['/opt/homebrew/bin', '/usr/local/bin', current].filter(Boolean).join(path.delimiter);
}

function waitForServer(url, timeoutMs = 15000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      fetch(url)
        .then(() => resolve())
        .catch((error) => {
          if (Date.now() - startedAt > timeoutMs) {
            reject(error);
            return;
          }
          setTimeout(check, 300);
        });
    };

    check();
  });
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, ASSESSMENT_HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 3001;
      probe.close(() => resolve(port));
    });
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

async function getAssessmentPort() {
  if (process.env.ASSESSMENT_PORT) return Number(process.env.ASSESSMENT_PORT);
  if (await isPortAvailable(DEFAULT_ASSESSMENT_PORT)) return DEFAULT_ASSESSMENT_PORT;
  return getAvailablePort();
}

async function getAssignmentAdminPort() {
  if (process.env.ASSIGNMENT_ADMIN_PORT) return Number(process.env.ASSIGNMENT_ADMIN_PORT);
  if (process.env.ASSIGNMENT_PORT) return Number(process.env.ASSIGNMENT_PORT);
  if (await isPortAvailable(DEFAULT_ASSIGNMENT_ADMIN_PORT)) return DEFAULT_ASSIGNMENT_ADMIN_PORT;
  return getAvailablePort();
}

async function getAssignmentTeacherPort(adminPort) {
  if (process.env.ASSIGNMENT_TEACHER_PORT) return Number(process.env.ASSIGNMENT_TEACHER_PORT);
  const preferred = adminPort === DEFAULT_ASSIGNMENT_ADMIN_PORT
    ? DEFAULT_ASSIGNMENT_TEACHER_PORT
    : Number(adminPort) + 1;
  if (await isPortAvailable(preferred)) return preferred;
  return getAvailablePort();
}

async function getAssignmentStudentPort(teacherPort) {
  if (process.env.ASSIGNMENT_STUDENT_PORT) return Number(process.env.ASSIGNMENT_STUDENT_PORT);
  const preferred = teacherPort === DEFAULT_ASSIGNMENT_TEACHER_PORT
    ? DEFAULT_ASSIGNMENT_STUDENT_PORT
    : Number(teacherPort) + 1;
  if (await isPortAvailable(preferred)) return preferred;
  return getAvailablePort();
}

async function startAssessmentServer() {
  if (serverProcess && activeMode === 'assessment') return Promise.resolve();
  stopServer();

  const serverEntry = getAssessmentServerEntry();
  if (!fs.existsSync(serverEntry)) {
    throw new Error('Assessment server build not found. Run npm run assessment:build first.');
  }

  const storageDir = getAppStorageDir();
  fs.mkdirSync(storageDir, { recursive: true });
  assessmentPort = await getAssessmentPort();
  const bundledPythonPath = getBundledPythonPath();

  serverProcess = fork(serverEntry, [], {
    cwd: app.getPath('userData'),
    env: {
      ...process.env,
      PATH: getDesktopProcessPath(),
      HOST: ASSESSMENT_HOST,
      PORT: String(assessmentPort),
      APP_STORAGE_DIR: storageDir,
      ...(bundledPythonPath ? { ASSESSMENT_PYTHON: bundledPythonPath } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout?.on('data', (chunk) => console.log(`[assessment] ${chunk}`));
  serverProcess.stderr?.on('data', (chunk) => console.error(`[assessment] ${chunk}`));
  serverProcess.on('exit', () => {
    serverProcess = null;
    activeMode = null;
  });
  activeMode = 'assessment';

  return waitForServer(`http://${ASSESSMENT_HOST}:${assessmentPort}`);
}

async function startAssignmentServer() {
  if (serverProcess && activeMode === 'assignment') return Promise.resolve();
  stopServer();

  const serverEntry = getAssignmentServerEntry();
  if (!fs.existsSync(serverEntry)) {
    throw new Error('Assignment server build not found. Run npm run assignment:build first.');
  }

  const storageDir = getAppStorageDir();
  fs.mkdirSync(storageDir, { recursive: true });
  assignmentAdminPort = await getAssignmentAdminPort();
  assignmentTeacherPort = await getAssignmentTeacherPort(assignmentAdminPort);
  assignmentStudentPort = await getAssignmentStudentPort(assignmentTeacherPort);

  serverProcess = fork(serverEntry, [], {
    cwd: app.getPath('userData'),
    env: {
      ...process.env,
      HOST: ASSIGNMENT_HOST,
      ADMIN_PORT: String(assignmentAdminPort),
      TEACHER_PORT: String(assignmentTeacherPort),
      STUDENT_PORT: String(assignmentStudentPort),
      APP_STORAGE_DIR: storageDir
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout?.on('data', (chunk) => console.log(`[assignment] ${chunk}`));
  serverProcess.stderr?.on('data', (chunk) => console.error(`[assignment] ${chunk}`));
  serverProcess.on('exit', () => {
    serverProcess = null;
    activeMode = null;
  });
  activeMode = 'assignment';

  return waitForServer(`http://127.0.0.1:${assignmentAdminPort}`);
}

function stopServer() {
  setDisplaySleepPrevention(false);
  if (!serverProcess) return;
  serverProcess.kill();
  serverProcess = null;
  activeMode = null;
}

function launcherHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Assessment Assistant</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: #f6f7f9;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px;
  }
  .wrap { width: min(1040px, 100%); }
  h1 {
    margin: 0;
    font-size: 34px;
    letter-spacing: 0;
    color: #111827;
  }
  .lead {
    margin: 12px 0 32px;
    color: #4b5563;
    font-size: 16px;
    line-height: 1.6;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }
  a.card {
    display: block;
    min-height: 260px;
    padding: 28px;
    border: 1px solid #d7dce3;
    border-radius: 8px;
    background: #fff;
    color: inherit;
    text-decoration: none;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  }
  a.card:hover {
    border-color: #2563eb;
    box-shadow: 0 12px 30px rgba(37, 99, 235, 0.16);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    background: #eef2ff;
    color: #3730a3;
    font-size: 12px;
    font-weight: 700;
  }
  .title {
    margin: 26px 0 12px;
    font-size: 28px;
    font-weight: 800;
  }
  .desc {
    min-height: 76px;
    margin: 0;
    color: #4b5563;
    line-height: 1.65;
  }
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 42px;
    margin-top: 28px;
    padding: 0 16px;
    border-radius: 6px;
    background: #2563eb;
    color: #fff;
    font-weight: 700;
  }
  .note {
    margin-top: 20px;
    color: #6b7280;
    font-size: 13px;
  }
  @media (max-width: 760px) {
    main { padding: 24px; }
    .grid { grid-template-columns: 1fr; }
    h1 { font-size: 28px; }
  }
</style>
</head>
<body>
<main>
  <div class="wrap">
    <div class="grid">
      <a class="card" href="app://start/assignment">
        <span class="badge">LAN</span>
        <div class="title">평가 실시</div>
        <p class="desc">수행 평가를 실시합니다. <br>학생들에게 평가 안내 및 관련 자료를 배포하고, 학생 산출물을 취합합니다.</p>
      </a>
      <a class="card" href="app://start/assessment">
        <span class="badge">Local</span>
        <div class="title">평가 관리</div>
        <p class="desc">평가 영역·기준·안내 등을 평가를 준비하고,<br> 채점 및 세특 등의 평과 결과를 관리합니다.</p>
      </a>
    </div>
  </div>
</main>
</body>
</html>`;
}

async function showLauncher() {
  stopServer();
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(launcherHtml())}`);
}

async function startMode(mode) {
  try {
    if (mode === 'assignment') {
      await startAssignmentServer();
      await mainWindow.loadURL(`http://127.0.0.1:${assignmentAdminPort}`);
      return;
    }
    await startAssessmentServer();
    await mainWindow.loadURL(`http://${ASSESSMENT_HOST}:${assessmentPort}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <h1>앱 실행 실패</h1>
      <p>${message}</p>
      <p><a href="app://launcher">선택 화면으로 돌아가기</a></p>
    `)}`);
  }
}

async function createWindow() {
  ipcMain.removeHandler('display-sleep-prevention');
  ipcMain.removeHandler('save-file');
  ipcMain.removeHandler('open-files');
  ipcMain.removeHandler('open-directory');
  ipcMain.handle('display-sleep-prevention', (event, enabled) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    if (enabled && activeMode !== 'assessment') return false;
    return setDisplaySleepPrevention(Boolean(enabled));
  });
  ipcMain.handle('save-file', async (event, { filename, data }) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { canceled: true };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: fileDialogDefaultPath(filename || 'download'),
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, Buffer.from(new Uint8Array(data)));
    rememberFileDialogPath(filePath);
    return { canceled: false, filePath };
  });
  ipcMain.handle('open-files', async (event, options = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { canceled: true, files: [] };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      defaultPath: getLastFileDialogDir(),
      properties: ['openFile', ...(options.multiple ? ['multiSelections'] : [])],
      filters: Array.isArray(options.filters) ? options.filters : undefined,
    });
    if (canceled || !filePaths.length) return { canceled: true, files: [] };
    rememberFileDialogPath(filePaths[0]);
    return {
      canceled: false,
      files: filePaths.map((filePath) => {
        const buffer = fs.readFileSync(filePath);
        const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        return { name: path.basename(filePath), path: filePath, data };
      }),
    };
  });
  ipcMain.handle('open-directory', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { canceled: true };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      defaultPath: getLastFileDialogDir(),
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    rememberFileDialogPath(path.join(filePaths[0], '_selected'));
    return { canceled: false, path: filePaths[0] };
  });

  const windowState = loadWindowState();
  mainWindow = new BrowserWindow({
    ...windowState.bounds,
    minWidth: 1100,
    minHeight: 720,
    title: 'AI Assessment Assistant',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (windowState.isMaximized) mainWindow.maximize();
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);

  mainWindow.on('close', (event) => {
    saveWindowState();
    if (isForceQuit || isForceWindowClose) return;
    event.preventDefault();
    void requestApplicationClose(process.platform !== 'darwin');
  });

  mainWindow.on('closed', () => {
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }
    mainWindow = null;
    isForceWindowClose = false;
  });

  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (isForceQuit || isForceWindowClose) event.preventDefault();
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) return;
    event.preventDefault();
    if (url === 'app://launcher') {
      showLauncher();
      return;
    }
    if (url === 'app://start/assessment') {
      startMode('assessment');
      return;
    }
    if (url === 'app://start/assignment') {
      startMode('assignment');
    }
  });

  mainWindow.webContents.session.on('will-download', async (event, item) => {
    item.pause();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: fileDialogDefaultPath(item.getFilename()),
    });
    if (canceled || !filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
    rememberFileDialogPath(filePath);
    item.resume();
  });

  if (process.env.APP_MODE === 'assignment') {
    await startMode('assignment');
  } else if (process.env.APP_MODE === 'assessment') {
    await startMode('assessment');
  } else {
    await showLauncher();
  }
}

if (!hasSingleInstanceLock) {
  isForceQuit = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  setDisplaySleepPrevention(false);
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

async function confirmApplicationClose() {
  // 평가 실시 중: 열린 수행이 있으면 경고
  if (activeMode === 'assignment' && assignmentAdminPort) {
    try {
      const runs = await fetchJson(`http://127.0.0.1:${assignmentAdminPort}/api/admin/runs`);
      const hasActiveRun = Array.isArray(runs) && runs.some((r) => Number(r.is_open));
      if (hasActiveRun) {
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '수행 진행 중',
          message: '수행평가가 진행 중입니다.',
          detail: '종료하면 학생들의 연결이 즉시 끊어집니다.\n수행 종료 후 앱을 닫는 것을 권장합니다.',
          buttons: ['취소', '그래도 종료'],
          defaultId: 0,
          cancelId: 0,
        });
        if (response === 0) return false;
      }
    } catch {
      // 서버 응답 없으면 그냥 종료
    }
  }

  // 채점 중: 저장 안 된 변경사항 있으면 경고
  if (activeMode === 'assessment' && mainWindow && !mainWindow.isDestroyed()) {
    try {
      const hasUnsaved = await mainWindow.webContents.executeJavaScript('window.__hasUnsavedChanges === true');
      if (hasUnsaved) {
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '저장되지 않은 변경사항',
          message: '저장되지 않은 변경 사항이 있습니다.',
          detail: '종료하면 변경 사항이 손실됩니다. 종료하시겠습니까?',
          buttons: ['취소', '저장 없이 종료'],
          defaultId: 0,
          cancelId: 0,
        });
        if (response === 0) return false;
      }
    } catch {
      // 확인 실패 시 그냥 종료
    }
  }

  return true;
}

async function requestApplicationClose(quitApp) {
  if (closeConfirmationInProgress) return;
  closeConfirmationInProgress = true;
  try {
    if (!await confirmApplicationClose()) return;

    setDisplaySleepPrevention(false);
    stopServer();
    if (quitApp) {
      isForceQuit = true;
      app.quit();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      isForceWindowClose = true;
      mainWindow.close();
    }
  } finally {
    closeConfirmationInProgress = false;
  }
}

app.on('before-quit', (event) => {
  if (isForceQuit) return;
  event.preventDefault();
  void requestApplicationClose(true);
});

app.on('quit', () => {
  if (!isForceQuit) {
    isForceQuit = true;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
