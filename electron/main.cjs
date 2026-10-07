const { app, BrowserWindow, shell, session, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const settingsPath = () => path.join(app.getPath('userData'), 'export-settings.json');
async function getExportFolder() {
  try { return JSON.parse(await fs.readFile(settingsPath(), 'utf8')).folder || ''; }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
const safeComponent = (value) => typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value);
async function setExportFolder(folder) {
  if (typeof folder !== 'string' || !folder.trim() || !path.isAbsolute(folder) || folder.includes(String.fromCharCode(0))) {
    throw new Error('Invalid destination: enter a full folder path.');
  }
  try {
    if (!(await fs.stat(folder)).isDirectory()) throw new Error('Not a folder');
    await fs.access(folder, require('fs').constants.W_OK);
  } catch {
    throw new Error('Invalid destination: choose an existing writable folder.');
  }
  await fs.writeFile(settingsPath(), JSON.stringify({ folder }), 'utf8');
  return folder;
}
ipcMain.handle('export:get-folder', () => getExportFolder());
ipcMain.handle('export:set-folder', (_event, folder) => setExportFolder(folder));
ipcMain.handle('export:choose-folder', async () => {
  const previous = await getExportFolder();
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose default export folder', defaultPath: previous || app.getPath('music'), properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return previous;
  const folder = result.filePaths[0];
  return setExportFolder(folder);
});
ipcMain.handle('export:open-folder', async (_event, folder) => {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Invalid exported folder.');
  if (!(await fs.stat(folder)).isDirectory()) throw new Error('Invalid exported folder.');
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
});
ipcMain.handle('export:save-file', async (_event, { name, data, segments }) => {
  const folder = await getExportFolder();
  if (!folder) throw new Error('Choose an export folder first.');
  if (!safeComponent(name) || !Array.isArray(segments) || segments.length > 2 || !segments.every(safeComponent) || !(data instanceof Uint8Array)) throw new Error('Invalid export file or folder name.');
  await fs.access(folder);
  const destination = path.join(folder, ...segments);
  await fs.mkdir(destination, { recursive: true });
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  for (let index = 0; index < 10000; index++) {
    const filePath = path.join(destination, index ? `${stem} (${index + 1})${extension}` : name);
    try { await fs.writeFile(filePath, data, { flag: 'wx' }); return filePath; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Too many files with the same name.');
});

const sampleStore = require('./sample-export.cjs').createSampleExportStore(path.join(app.getPath('userData'), 'sample-export-settings.json'));
ipcMain.handle('sample:get-folder', () => sampleStore.getFolder());
ipcMain.handle('sample:set-folder', (_event, folder) => sampleStore.setFolder(folder));
ipcMain.handle('sample:choose-folder', async () => {
  const previous = await sampleStore.getFolder();
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose sample export folder', defaultPath: previous || app.getPath('music'), properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return null;
  return sampleStore.setFolder(result.filePaths[0]);
});
ipcMain.handle('sample:save', (_event, request) => sampleStore.save(request));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 650,
    minWidth: 980,
    minHeight: 650,
    title: 'Audiophonic Recordinator',
    backgroundColor: '#020617', // slate-950 to prevent white flash
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    autoHideMenuBar: true, // Clean studio look; press Alt to show menu
  });

  // Automatically approve microphone/soundcard permissions for recording in desktop app
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
      return;
    }
    callback(false);
  });

  // Open external links (e.g. documentation or web links) in user's default browser, not in the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Determine if running in dev mode or production build
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null);

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    // Optionally open DevTools in dev mode if requested:
    if (process.env.ELECTRON_OPEN_DEVTOOLS === 'true') {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
