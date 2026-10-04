// Run with Vite running: electron scripts/check-import-loading.cjs [URL]
// Exercises real React/canvas effects with controlled pending reads and decodes.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { backgroundThrottling: false } });
  const run = (code) => win.webContents.executeJavaScript(code);
  const wait = async (code) => {
    const deadline = Date.now() + 15000;
    while (!await run(code)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await win.loadURL(process.argv[2] || 'http://localhost:3000/?standby=1');
    await wait("!!document.querySelector('input[type=file]')");
    await run(`
      window.reads = []; window.closedContexts = 0; window.decodes = [];
      window.NativeContext = window.AudioContext;
      window.FileReader = class {
        readAsArrayBuffer() { reads.push(this); }
      };
      window.AudioContext = class {
        decodeAudioData() { this.decoding = true; return new Promise((resolve, reject) => decodes.push({resolve, reject})); }
        close() { if (this.decoding) closedContexts++; return Promise.resolve(); }
      };
      window.selectFile = (name = 'test.wav') => {
        const input = document.querySelector('input[type=file]');
        const transfer = new DataTransfer(); transfer.items.add(new File(['test'], name));
        input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles: true}));
      };
      window.statusText = () => document.querySelector('[role=status]')?.textContent || '';
      window.importButton = () => [...document.querySelectorAll('button')].find(b => b.title === 'Import an audio file');
      window.tab = label => [...document.querySelectorAll('header button')].find(b => b.textContent.trim() === label);
      window.finishRead = () => { reads.at(-1).result = new ArrayBuffer(8); reads.at(-1).onload(); };
      window.makeBuffer = (length = 4000000) => new AudioBuffer({length, numberOfChannels: 2, sampleRate: 48000});
      window.heldFrames = []; window.holdFrames = false;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = fn => holdFrames ? (heldFrames.push(fn), -heldFrames.length) : raf(fn);
      window.releaseFrames = () => { holdFrames = false; heldFrames.splice(0).forEach(fn => raf(fn)); };
      void 0;
    `);
    await run("selectFile()");
    await wait("statusText().includes('Reading test.wav')");
    assert.equal(await run("importButton().disabled && document.querySelector('main').inert"), true);
    await run("selectFile('blocked.wav')");
    assert.equal(await run('reads.length'), 1, 'repeat selection blocked immediately');
    await run("reads[0].onprogress({lengthComputable: true, loaded: 3, total: 4})");
    await wait("statusText().includes('75%')");
    await run('finishRead()');
    await wait("statusText().includes('Decoding')");
    assert.equal(await run("statusText().includes('%')"), false, 'decode remains indeterminate');
    await run("tab('EXPORT').click()");
    assert.equal(await run("document.querySelector('main').inert && importButton().disabled"), true);
    assert.equal(await run("!window.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', code: 'Space', cancelable: true}))"), true, 'shortcuts blocked across tabs');
    await run("tab('EDIT').click(); holdFrames = true; decodes[0].resolve(makeBuffer())");
    await wait("statusText().includes('Building waveform')");
    assert.equal(await run('importButton().disabled'), true, 'decode-to-analysis handover stays busy');
    await wait("statusText().includes('100%') && heldFrames.length > 0");
    assert.equal(await run('importButton().disabled'), true, 'completed analysis waits for initial draw/paint');
    await run('releaseFrames()');
    await wait('!importButton().disabled');
    assert.equal(await run("statusText() === '' && !document.querySelector('main').inert"), true);
    assert.equal(await run('closedContexts'), 1);
    // Read and decode failure preserve the loaded waveform, reset input, and allow retry.
    const canvasSize = await run("document.querySelector('canvas').width");
    await run("selectFile('read-failure.wav'); reads.at(-1).error = new Error('read failed'); reads.at(-1).onerror()");
    await wait("statusText().includes('Could not load') && !importButton().disabled");
    assert.equal(await run("document.querySelector('canvas').width"), canvasSize);
    await run("selectFile('invalid.wav'); finishRead()");
    await wait('decodes.length === 2');
    await run("decodes[1].reject(new Error('invalid audio'))");
    await wait("statusText().includes('Could not load') && !importButton().disabled");
    assert.equal(await run('closedContexts'), 2);
    assert.equal(await run("document.querySelector('input[type=file]').value"), '');
    await run("selectFile('retry.wav'); finishRead()");
    await wait('decodes.length === 3');
    await run('decodes[2].resolve(makeBuffer(140003))');
    await wait('!importButton().disabled && statusText() === ""');
    assert.equal(await run('closedContexts'), 3);
    console.log('PASS: pending read/decode, real progress, blocking across tabs, handover, draw readiness, failure preservation, retry');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
