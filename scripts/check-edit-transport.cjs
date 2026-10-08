// Edit Transport regression using native renderer buttons and imported audio.
// Run after npm run build: electron scripts/check-edit-transport.cjs
// Optional prior-build geometry capture: --baseline <relative dist/index.html>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = path.join(__dirname, '../build', 'edit-transport-regression-profile');
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
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) wav.writeInt16LE(c ? (i % (rate / 4) < 80 ? 20000 : 0) : Math.round(2000 + i / frames * 20000), 44 + i * 4 + c * 2);
    const file = path.join(__dirname, '../build/loop-sample-sync-transients.wav'); fs.writeFileSync(file, wav);
    await win.loadFile(path.join(__dirname, process.argv.includes('--baseline') ? (process.argv[process.argv.indexOf('--baseline')+1] ?? '../dist/index.html') : '../dist/index.html'));
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='EDIT').click()`);await pause();await pause();
    if(!process.argv.includes('--baseline')){assert.equal(await run(`document.querySelector('[aria-label="Edit transport"]').querySelectorAll('button').length`),3);assert.equal(await run(`[...document.querySelector('[aria-label="Edit transport"]').querySelectorAll('button')].every(b=>b.disabled)`),true);await win.webContents.capturePage();fs.writeFileSync(path.join(__dirname,'../build/transport-no-audio.png'),(await win.webContents.capturePage()).toPNG());}
    win.webContents.setAudioMuted(true);
    await run(`
      window.sources=[]; window.blocks=[]; window.audioClock=null;
      const create=AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource=function(){
        const node=create.call(this),ctx=this,entry={node,ctx,active:false};sources.push(entry);
        const start=node.start.bind(node),stop=node.stop.bind(node),connect=node.connect.bind(node);
        node.start=(...args)=>{entry.active=true;entry.when=args[0]||ctx.currentTime;entry.offset=args[1];entry.duration=args[2];return start(...args)};
        node.stop=(...args)=>{entry.until=Math.min(entry.until??Infinity,args[0]||ctx.currentTime);return stop(...args)};
        node.connect=(...args)=>{if(window.tap)connect(window.tap);return connect(...args)};
        node.addEventListener('ended',()=>{entry.active=false});window.audioClock=ctx;return node;
      };
      const timestamp=AudioContext.prototype.getOutputTimestamp;
      AudioContext.prototype.getOutputTimestamp=function(){const stamp=timestamp.call(this);window.lastHeard=Math.max(0,Math.min(this.currentTime,stamp.contextTime>0?stamp.contextTime+Math.max(0,performance.now()-stamp.performanceTime)/1000:this.currentTime-this.baseLatency-this.outputLatency));return stamp;};
      void 0;
    `);
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
    await click('Loop / Sample');await setRegion(1,3);await run('component().memoizedProps.onStartBeatChange(96000)');await pause();
    const geometry=()=>run(`(()=>{const r=e=>e?.getBoundingClientRect().toJSON()??null;return {wave:r(wave()),ruler:r(document.querySelector('[aria-label="Waveform time ruler"]')),toolbar:r(document.querySelector('[aria-label="Waveform editing toolbar"]')),bottom:r(document.querySelector('[aria-label="Tools"]').parentElement),tools:r(document.querySelector('[aria-label="Tools"]')),readouts:[...document.querySelectorAll('.loop-readout input,.loop-length output,.loop-memory-slot')].map(e=>({width:r(e).width,height:r(e).height})),handle:r(document.querySelector('[aria-label="Drag 1st Beat"]')),panels:[...document.querySelectorAll('.loop-section')].map(r),save:r(document.querySelector('[aria-label="Show sample save"]')),transport:document.querySelector('[aria-label="Edit transport"]')?r(document.querySelector('[aria-label="Edit transport"]')):null};})()`);
    const baselinePath=path.join(__dirname,'../build/transport-baseline.json');
    if(process.argv.includes('--baseline')){fs.writeFileSync(baselinePath,JSON.stringify(await geometry()));console.log('Captured previous toolbar / waveform / bottom geometry');app.exit(0);return;}
    const expected=await geometry();if(fs.existsSync(baselinePath)){const baseline=JSON.parse(fs.readFileSync(baselinePath));
    assert.deepEqual(expected.wave,baseline.wave);assert.deepEqual(expected.ruler,baseline.ruler);assert.deepEqual(expected.toolbar,baseline.toolbar);assert.deepEqual(expected.handle,baseline.handle);assert.deepEqual(expected.readouts,baseline.readouts);
    assert.equal(expected.bottom.height,baseline.bottom.height);assert.equal(expected.bottom.y,baseline.bottom.y);assert.equal(expected.bottom.x,expected.toolbar.x);assert.equal(expected.bottom.width,expected.toolbar.width);if(process.argv.includes('--preserve-tools')) { assert.deepEqual(expected.tools,baseline.tools); assert.deepEqual(expected.transport,baseline.transport); if(process.argv.includes('--refine-grid')) expected.panels.forEach((p,i)=>{assert.equal(p.top,baseline.panels[i].top);assert.equal(p.bottom,baseline.panels[i].bottom);}); else assert.deepEqual(expected.panels,baseline.panels); for(const k of ['x','y','left','right','top','bottom','width','height']) assert.ok(Math.abs(expected.save[k]-baseline.save[k])<.05,'Save geometry '+k); } else assert.ok(expected.tools.width>baseline.tools.width);assert.equal(expected.tools.right,baseline.tools.right);}
    assert.equal(await run(`[...document.querySelectorAll('h2')].some(e=>e.textContent==='Transport')`),false);
    const stable=async()=>{const g=await geometry();assert.deepEqual(g.wave,expected.wave);assert.deepEqual(g.ruler,expected.ruler);assert.equal(g.toolbar.height,expected.toolbar.height);assert.equal(g.toolbar.y,expected.toolbar.y);assert.deepEqual(g.readouts,expected.readouts);
      const layout=await run(`(()=>{const bar=document.querySelector('[aria-label="Waveform editing toolbar"]'),r=bar.getBoundingClientRect();const children=[...bar.children].map(e=>e.getBoundingClientRect().toJSON());const buttons=[...bar.querySelectorAll('button')].map(e=>e.getBoundingClientRect().toJSON());return {children,buttons,rect:r.toJSON(),wrap:getComputedStyle(bar).flexWrap,scroll:document.documentElement.scrollHeight>innerHeight,farRightAction:document.querySelector('[aria-label="Show sample save"]').getBoundingClientRect().right,tools:document.querySelector('[aria-label="Tools"]').getBoundingClientRect().right};})()`);
      assert.equal(layout.wrap,'nowrap');assert.equal(layout.scroll,false);assert.ok(Math.abs(layout.farRightAction-layout.tools)<.05,'Save reaches the inner right margin');for(let i=0;i<layout.children.length;i++){const r=layout.children[i];assert.ok(r.left>=layout.rect.left&&r.right<=layout.rect.right);if(i)assert.ok(r.left>=layout.children[i-1].right,'Toolbar groups cannot overlap');}for(const r of layout.buttons)assert.ok(r.top>=layout.rect.top&&r.bottom<=layout.rect.bottom);};
    const shot=async name=>{await stable();await win.webContents.capturePage();await pause();fs.writeFileSync(path.join(__dirname,`../build/transport-${name}.png`),(await win.webContents.capturePage()).toPNG());};
    await shot('stopped');await run('clearSelection()');await pause();await click('Play');await new Promise(r=>setTimeout(r,450));assert.equal(await run('component().memoizedProps.isPlaying'),true);assert.equal(await run(`document.querySelector('[aria-label="Pause"]').getAttribute('aria-pressed')`),'true');await shot('playing');
    await click('Pause');const paused=await run('component().memoizedProps.currentTime');assert.ok(paused>0);await new Promise(r=>setTimeout(r,200));assert.equal(await run('component().memoizedProps.currentTime'),paused);assert.equal(await run('component().memoizedProps.isPlaying'),false);await shot('paused');await click('Play');assert.ok(Math.abs(await run('sources.at(-1).offset')-paused)<1/48000);await click('Stop');assert.equal(await run('component().memoizedProps.currentTime'),0);assert.equal(await run('component().memoizedProps.isPlaying'),false);
    const key=async(key,code,virtual)=>{await run('document.activeElement.blur()');for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:virtual});await pause();};
    await key(' ','Space',32);assert.equal(await run('component().memoizedProps.isPlaying'),true);await key(' ','Space',32);assert.equal(await run('component().memoizedProps.isPlaying'),false);await run('component().memoizedProps.onCropChange(2,10);component().memoizedProps.onSeek(5)');await pause();await click('Stop');assert.equal(await run('component().memoizedProps.currentTime'),2);await click('Play');await click('Return to start');assert.equal(await run('component().memoizedProps.currentTime'),0);assert.equal(await run('component().memoizedProps.isPlaying'),false);assert.equal(await run('component().memoizedProps.viewOffsetSec'),0);await run('component().memoizedProps.onSeek(5)');await pause();await key('Home','Home',36);assert.equal(await run('component().memoizedProps.currentTime'),0);
    // Long timing strings and every existing Tools view remain in their fixed slots.
    await run(`window.originalDuration=component().memoizedProps.audioBuffer.duration;Object.defineProperty(component().memoizedProps.audioBuffer,'duration',{configurable:true,value:359999.123});component().memoizedProps.onSeek(359998)`);await pause();await shot('long-time');await run(`delete component().memoizedProps.audioBuffer.duration;component().memoizedProps.onCropChange(0,originalDuration);component().memoizedProps.onSeek(0)`);await pause();
    for(const label of ['Auto-Split','Peak Tamer','Normalise','Loop / Sample']){await click(label);assert.deepEqual((await geometry()).wave,expected.wave);assert.equal((await geometry()).toolbar.height,expected.toolbar.height);}await setRegion(1,3);await click('Loop and play the selected region');await shot('looping');await click('Pause');assert.equal(await run('component().memoizedProps.isLooping'),true);await click('Play');assert.equal(await run('component().memoizedProps.isLooping'),true);await click('Stop');
    console.log('PASS: native toolbar Play / Pause / resume / Stop / Return, Space / Home, no-audio disabled states, active styling, unchanged waveform / ruler / toolbar / readout sizes, full-width Tools / right-edge keypad, long values and Tools views');app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
