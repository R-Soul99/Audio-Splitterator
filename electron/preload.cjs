// Preload script for secure desktop integration
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  getExportFolder: () => ipcRenderer.invoke('export:get-folder'),
  chooseExportFolder: () => ipcRenderer.invoke('export:choose-folder'),
  saveExportFile: (file) => ipcRenderer.invoke('export:save-file', file),
});
