const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
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
