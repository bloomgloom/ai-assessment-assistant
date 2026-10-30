const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assessmentDesktop', {
  setDisplaySleepPrevention: (enabled) => ipcRenderer.invoke('display-sleep-prevention', Boolean(enabled)),
  saveFile: (filename, data) => ipcRenderer.invoke('save-file', { filename, data }),
  openFiles: (options) => ipcRenderer.invoke('open-files', options),
  openDirectory: () => ipcRenderer.invoke('open-directory'),
});
