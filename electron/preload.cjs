// Preload script for secure desktop integration
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSampleFolder: () => ipcRenderer.invoke('sample:get-folder'),
  setSampleFolder: folder => ipcRenderer.invoke('sample:set-folder', folder),
  chooseSampleFolder: () => ipcRenderer.invoke('sample:choose-folder'),
  saveSample: request => ipcRenderer.invoke('sample:save', request),
  isDesktop: true,
  platform: process.platform,
  openExportFolder: (folder) => ipcRenderer.invoke('export:open-folder', folder),
  getExportFolder: () => ipcRenderer.invoke('export:get-folder'),
  setExportFolder: (folder) => ipcRenderer.invoke('export:set-folder', folder),
  chooseExportFolder: () => ipcRenderer.invoke('export:choose-folder'),
  saveExportFile: (file) => ipcRenderer.invoke('export:save-file', file),
});
