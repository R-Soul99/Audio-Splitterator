// Preload script for secure desktop integration
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  openExportFolder: (folder) => ipcRenderer.invoke('export:open-folder', folder),
  getExportFolder: () => ipcRenderer.invoke('export:get-folder'),
  setExportFolder: (folder) => ipcRenderer.invoke('export:set-folder', folder),
  chooseExportFolder: () => ipcRenderer.invoke('export:choose-folder'),
  saveExportFile: (file) => ipcRenderer.invoke('export:save-file', file),
  setUnsavedWork: (value) => ipcRenderer.send('app:set-unsaved-work', value === true),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:close-requested', listener);
    return () => ipcRenderer.removeListener('app:close-requested', listener);
  },
});
