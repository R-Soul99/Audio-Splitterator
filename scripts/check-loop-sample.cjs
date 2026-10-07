// Loop / Sample regression using real imported audio and native Web Audio sources.
// Run after npm run build: electron scripts/check-loop-sample.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = path.join(__dirname, '../build', 'loop-sample-regression-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
  const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(e) { console.error('Failed renderer code:', code); throw e; } };
  win.webContents.on('console-message', event => { if (event.level === 'error') console.log('Renderer:', event.message); });
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
    const file = path.join(app.getPath('temp'), 'loop-sample-regression.wav'); fs.writeFileSync(file, wav);
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
    win.webContents.setAudioMuted(true);
    await run(`window.sources = []; const create = AudioContext.prototype.createBufferSource; AudioContext.prototype.createBufferSource = function() { const node = create.call(this); const entry = {node, active:false}; sources.push(entry); const start = node.start.bind(node), stop = node.stop.bind(node); node.start = (...args) => { entry.active = true; return start(...args); }; node.stop = (...args) => { entry.active = false; return stop(...args); }; return node; }; void 0;`);
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
    const click = async label => { await run(`(document.querySelector('[aria-label="${label}"]') || [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${label}')).click()`); await pause(); };
    const select = async (label, value) => { await run(`(() => { const el = document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '${value}'); el.dispatchEvent(new Event('change', {bubbles:true})); })()`); await pause(); };
    const setRegion = async (start, end) => { await run(`component().memoizedProps.onSelectionChange({start:${start},end:${end}})`); await pause(); };
    const rect = await run('wave().getBoundingClientRect().toJSON()');
    await click('Loop / Sample');
    assert.equal(await run(`document.querySelector('[aria-label="Halve selection"]').disabled`), true);
    const typeTime = async (label, value, key) => {
      await run(`(() => { const el=document.querySelector('[aria-label="${label}"]'); el.focus(); el.select(); })()`); await pause();
      await win.webContents.debugger.sendCommand('Input.insertText', {text:value}); await pause();
      if (key) { await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key,code:key,windowsVirtualKeyCode:key==='Enter'?13:27}); await pause(); }
      else { await run(`document.querySelector('[aria-label="${label}"]').blur()`); await pause(); }
    };
    const snapshot = async name => { await win.webContents.capturePage(); await pause(); fs.writeFileSync(path.join(__dirname, `../build/loop-sample-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
    await snapshot('no-selection');
    await setRegion(1, 3);
    await typeTime('Loop Start','1.5','Enter'); assert.deepEqual(await run('currentSelection()'), {start:1.5,end:3});
    await typeTime('Loop End','3.25'); assert.deepEqual(await run('currentSelection()'), {start:1.5,end:3.25});
    await typeTime('Loop Start','2','Escape'); assert.deepEqual(await run('currentSelection()'), {start:1.5,end:3.25});
    await typeTime('Loop Start','5','Enter'); assert.deepEqual(await run('currentSelection()'), {start:1.5,end:3.25});
    assert.equal(await run(`document.querySelector('[aria-label="Loop Start"]').getAttribute('aria-invalid')`),'true');
    await typeTime('Loop Start','1.5','Escape');
    await setRegion(1, 3);
    await click('Halve selection'); assert.deepEqual(await run('currentSelection()'), {start:1,end:2});
    await click('Double selection'); assert.deepEqual(await run('currentSelection()'), {start:1,end:3});
    await select('Fixed selection edge', 'end'); await click('Halve selection'); assert.deepEqual(await run('currentSelection()'), {start:2,end:3});
    await click('Double selection'); assert.deepEqual(await run('currentSelection()'), {start:1,end:3});
    await click('Next selection'); assert.deepEqual(await run('currentSelection()'), {start:3,end:5});
    await click('Previous selection'); assert.deepEqual(await run('currentSelection()'), {start:1,end:3});
    await select('Nudge target', 'start'); await select('Nudge amount', '1'); await click('Nudge right');
    assert.deepEqual(await run('currentSelection()'), {start:1.001,end:3});
    await select('Nudge target', 'end'); await click('Nudge left'); assert.deepEqual(await run('currentSelection()'), {start:1.001,end:2.999});
    await setRegion(0, 2); assert.equal(await run(`document.querySelector('[aria-label="Previous selection"]').disabled`), true);
    await select('Nudge target', 'whole'); assert.equal(await run(`document.querySelector('[aria-label="Nudge left"]').disabled`), true);
    await setRegion(1, 3);
    await select('Nudge target', 'whole'); await select('Nudge amount', '100');
    const knob = await run(`document.querySelector('[aria-label="Nudge"]').getBoundingClientRect().toJSON()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:knob.x+11,y:knob.y+11,button:'left',buttons:1,clickCount:1});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:knob.x+11,y:knob.y-5,button:'left',buttons:1});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:knob.x+11,y:knob.y-5,button:'left',buttons:0,clickCount:1}); await pause();
    assert.deepEqual(await run('currentSelection()'),{start:1.2,end:3.2},'Two native knob steps');
    await snapshot('stopped');
    await setRegion(1, 1 + 1/48000); assert.equal(await run(`document.querySelector('[aria-label="Halve selection"]').disabled`),true);
    await click('Selection loop'); assert.equal(await run('sources.at(-1).node.loopEnd - sources.at(-1).node.loopStart > 0'),true);
    await setRegion(1, 1.1);
    const repeats = async () => {
      for (let i=0;i<8;i++) { await new Promise(r=>setTimeout(r,80)); const state=await run(`({playing:component().memoizedProps.isPlaying, looping:component().memoizedProps.isLooping, time:component().memoizedProps.currentTime, selection:currentSelection(), active:sources.filter(s=>s.active).length})`); assert.equal(state.playing,true); assert.equal(state.looping,true); assert.equal(state.active,1); assert.ok(state.time>=state.selection.start && state.time<state.selection.end, JSON.stringify(state)); }
    };
    await repeats();
    const count = await run('sources.length'); await setRegion(.9, 1.2); assert.equal(await run('sources.length'), count, 'Inside edit keeps native source');
    await repeats(); await setRegion(2, 2.1); assert.equal(await run('sources.length'), count+1, 'Outside edit safely replaces source'); await repeats();
    for (const label of ['Auto-Split','Peak Tamer','Normalise','Loop / Sample']) { await click(label); assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'), rect); assert.equal(await run('component().memoizedProps.isLooping'),true); }
    await repeats();
    const geometry = await run(`(() => { const p=document.querySelector('[aria-label="Tools"]'), r=p.getBoundingClientRect(); return {panel:r.toJSON(), controls:[...document.querySelectorAll('.loop-sample-controls button, .loop-sample-controls input, .loop-sample-controls select, .loop-sample-controls output, .loop-hint')].filter(e=>e.getClientRects().length).map(e=>({label:e.getAttribute('aria-label')||e.textContent, rect:e.getBoundingClientRect().toJSON()})), bodyScroll:document.documentElement.scrollHeight>innerHeight}; })()`);

    for (const control of geometry.controls) { assert.ok(control.rect.right <= geometry.panel.right+1 && control.rect.bottom <= geometry.panel.bottom+1 && control.rect.left >= geometry.panel.left-1, JSON.stringify(control)); }
    assert.equal(geometry.bodyScroll,false);
    fs.writeFileSync(path.join(__dirname, '../build/loop-sample-review.png'), (await win.webContents.capturePage()).toPNG());
    await snapshot('playing');
    console.log('Fixed layout: 980x650; Tools controls contained; no document scrolling');
    await click('Selection loop'); assert.equal(await run('component().memoizedProps.isLooping'),false);
    await snapshot('loop-off');
    await run('clearSelection()'); await pause(); assert.equal(await run('component().memoizedProps.isLooping'),false);
    console.log('PASS: loop controls, sample nudges, boundary disabling, several real native repeats after inside/outside edits, one active source, tabs preserve loop, stable waveform and contained controls at 980x650');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
