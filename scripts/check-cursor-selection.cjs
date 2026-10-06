// Production UI regression with native pointer input and the real import/selection handlers.
// Run after npm run build: electron scripts/check-cursor-selection.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = path.join(__dirname, '../build', process.argv[2] ? 'cursor-regression-baseline-profile' : 'cursor-regression-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 50));
  const wait = async code => {
    const deadline = Date.now() + 15000;
    while (!await run(code)) { if (Date.now() > deadline) throw Error(`Timed out: ${code}`); await pause(); }
  };
  try {
    const rate = 48000, frames = rate * 20 + 1;
    const wav = Buffer.alloc(44 + frames * 4);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40);
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) wav.writeInt16LE(Math.round(10000 * Math.sin(i * (c ? 0.12 : 0.08))), 44 + i * 4 + c * 2);
    const file = path.join(app.getPath('temp'), 'cursor-selection-regression.wav'); fs.writeFileSync(file, wav);
    await win.loadFile(process.argv[2] || path.join(__dirname, '../dist/index.html'));
    win.webContents.debugger.attach('1.3');
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file] });
    await wait(`!!document.querySelector('[aria-label="Edit waveform"]') && !document.querySelector('main').inert`);
    await run(`
      window.wave = () => document.querySelector('[aria-label="Edit waveform"]');
      window.component = () => {
        let fiber = wave()[Object.keys(wave()).find(key => key.startsWith('__reactFiber'))];
        while (fiber.return) fiber = fiber.return;
        const queue = [fiber.stateNode.current];
        while (queue.length) { const next = queue.shift(); const p = next.memoizedProps;
          if (p?.onSelectionChange && p?.onZoomChange && p?.audioBuffer) return next;
          if (next.child) queue.push(next.child); if (next.sibling) queue.push(next.sibling);
        }
        throw Error('Waveform component missing');
      };
      window.currentSelection = () => component().memoizedProps.selection;
      window.audioDuration = component().memoizedProps.audioBuffer.duration;
      window.clearSelection = () => component().memoizedProps.onSelectionChange(null);
      void 0;
    `);
    const bounds = () => run('wave().getBoundingClientRect().toJSON()');
    let pressed = false;
    const mouse = async (type, x, y) => {
      if (type === 'mousePressed') pressed = true;
      if (type === 'mouseReleased') pressed = false;
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !pressed ? 'none' : 'left', buttons: pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
      await pause();
    };
    const drag = async (start, end, y) => { await mouse('mouseMoved', start, y); await mouse('mousePressed', start, y); await mouse('mouseMoved', end, y); await mouse('mouseReleased', end, y); };
    const rect = await bounds();
    // Native hit testing: controls must sit outside every selectable right-edge pixel.
    for (const ratio of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      assert.equal(await run(`document.elementFromPoint(${rect.right - 12}, ${rect.top + rect.height * ratio}) === wave()`), true, `Right-edge hit test at ${ratio}`);
    }
    await mouse('mouseMoved', rect.left + rect.width / 2, rect.top + rect.height * 0.7);
    await wait(`!!document.querySelector('[aria-label="Cursor time readout"]')`);
    const tooltip = await run(`(() => { const t = document.querySelector('[aria-label="Cursor time readout"]'), r = t.getBoundingClientRect(); return { centre: r.top + r.height / 2, x: r.left + r.width / 2, pointerEvents: getComputedStyle(t).pointerEvents }; })()`);
    assert.ok(Math.abs(tooltip.centre - (rect.top + rect.height / 2)) <= 1, 'Readout centres in stereo gap');
    assert.ok(Math.abs(tooltip.x - (rect.left + rect.width / 2)) <= 1, 'Readout follows cursor horizontally');
    assert.equal(tooltip.pointerEvents, 'none');
    // Start near the end at the former vertical-control position and drag past audio into the gutter.
    await drag(rect.right - 30, rect.right + 10, rect.top + rect.height / 2);
    let selected = await run('currentSelection()');
    const duration = await run('audioDuration');
    assert.equal(selected.end, duration, 'Creation reaches exact final sample boundary after overshoot');
    assert.ok(selected.start < duration && selected.start > duration * 0.9, 'Can start selection in trailing audio');
    // Extend an existing selection bracket past the final audio pixel.
    await run('component().memoizedProps.onSelectionChange({ start: 4, end: 15 })'); await pause();
    await drag(rect.left + rect.width * 15 / duration, rect.right + 8, rect.top + rect.height / 2);
    selected = await run('currentSelection()');
    assert.equal(selected.start, 4); assert.equal(selected.end, duration, 'Bracket drag clamps at exact end');
    // Moving the selection bar preserves its span at the boundary.
    await run('component().memoizedProps.onSelectionChange({ start: 4, end: 6 })'); await pause();
    await drag(rect.left + rect.width * 5 / duration, rect.right + 8, rect.top + 4);
    selected = await run('currentSelection()');
    assert.equal(selected.end, duration); assert.ok(Math.abs(selected.end - selected.start - 2) < 1e-9);
    // Exact endpoint works in a zoomed view ending at the recording boundary.
    await run('clearSelection(); component().memoizedProps.onZoomChange(2); component().memoizedProps.onViewOffsetChange(audioDuration / 2)'); await pause();
    const zoomRect = await bounds();
    await drag(zoomRect.right - 40, zoomRect.right + 10, zoomRect.top + zoomRect.height * 0.7);
    assert.equal((await run('currentSelection()')).end, duration);
    await run(`document.querySelector('[aria-label="Reset horizontal zoom"]').click(); clearSelection()`); await wait('component().memoizedProps.zoom === 1');
    const before = await run('wave().toDataURL()');
    await run(`document.querySelector('[aria-label="Zoom waveform vertically in"]').click()`); await pause();
    assert.notEqual(await run('wave().toDataURL()'), before, 'Vertical zoom still works');
    assert.deepEqual(await bounds(), rect, 'Zoom controls do not move/resize waveform');
    await run(`document.querySelector('[aria-label="Reset vertical zoom"]').click()`); await pause();
    assert.equal(await run('wave().toDataURL()'), before, 'Vertical reset still works');
    await mouse('mouseMoved', rect.left + rect.width * 0.6, rect.top + rect.height * 0.7);
    fs.mkdirSync(path.join(__dirname, '../build'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '../build/cursor-selection-review.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS: centred pointer-transparent readout; native right-edge selection, exact end, captured overshoot, bracket extension, region move, zoomed end and working zoom controls');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
