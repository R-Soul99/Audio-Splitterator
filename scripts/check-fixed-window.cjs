// Real main process regression: electron scripts/check-fixed-window.cjs [1|2].
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const scale = process.argv[2] || '1';
app.commandLine.appendSwitch('force-device-scale-factor', scale);
app.setPath('userData', path.join(__dirname, '../build/fixed-window-profile-' + scale));
process.env.NODE_ENV = 'production';
delete process.env.VITE_DEV_SERVER_URL;
require('../electron/main.cjs');
app.whenReady().then(async () => {
  const pause = () => new Promise(r => setTimeout(r, 100));
  try {
    while (!BrowserWindow.getAllWindows().length) await pause();
    const win = BrowserWindow.getAllWindows()[0];
    while (win.webContents.isLoading()) await pause();
    const size = win.getSize();
    assert.equal(size[0], 980);
    assert.ok(size[1] >= 650 && size[1] <= 651, "Windows high-DPI frame rounding is at most one DIP");
    assert.deepEqual(win.getMinimumSize(), [980, 650]);
    assert.deepEqual(win.getMaximumSize(), [980, 650]);
    assert.equal(win.isResizable(), false);
    assert.equal(win.isMaximizable(), false);
    assert.equal(win.isFullScreenable(), false);
    assert.equal(await win.webContents.executeJavaScript('devicePixelRatio'), Number(scale));
    const original = win.getContentSize();
    for (const tab of ['RECORD', 'EDIT', 'EXPORT']) {
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${tab}').click()`);
      await pause();
      assert.deepEqual(win.getContentSize(), original);
      assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollHeight>innerHeight||document.documentElement.scrollWidth>innerWidth'), false);
    }
    console.log(`PASS: real window fixed at ${size.join("x")} DIP (980x650 configured), resize/maximise/fullscreen disabled, ${scale}x DPI, all workspaces fit`);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
