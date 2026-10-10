// Focused native renderer/audio regressions for Volume analysis, controls and peak meters.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(__dirname, '../build/volume-workflow-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, autoHideMenuBar: true, webPreferences: { backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code).catch(e=>{console.error('Renderer code:',code.slice(0,400));throw e;});
  win.webContents.on('console-message',event=>{if(event.level==='error')console.log('Renderer:',event.message)});
  const pause = (ms = 100) => new Promise(r => setTimeout(r, ms));
  const wait = async code => { const deadline = Date.now() + 15000; while (!await run(code)) { if (Date.now() > deadline) throw Error(code); await pause(25); } };
  const shot = async name => { await pause(40);await win.webContents.capturePage();await pause(80); fs.mkdirSync(path.join(__dirname, '../build'), { recursive: true }); fs.writeFileSync(path.join(__dirname, `../build/volume-workflow-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadFile(process.env.VOLUME_TEST_ENTRY || path.join(__dirname, '../dist/index.html'));
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='EDIT').click()`);
    await pause();
    await run(`
      window.button = text => [...document.querySelectorAll('button')].find(b=>b.textContent.trim().replace(/\\s+/g,' ')===text);
      window.wave = () => document.querySelector('[aria-label="Edit waveform"]');
      window.props = () => {let f=wave()[Object.keys(wave()).find(k=>k.startsWith('__reactFiber'))];while(f.return)f=f.return;const q=[f.stateNode.current];while(q.length){const n=q.shift();if(n.memoizedProps?.onApplyVolume)return n.memoizedProps;if(n.child)q.push(n.child);if(n.sibling)q.push(n.sibling);}throw Error('Missing waveform');};
      window.meter = () => props().playbackPeakMeter;
      window.peak = () => document.querySelector('[aria-label="Highest peak in dBFS"]').textContent;
      window.vstatus = () => document.querySelector('.volume-status').textContent;
      window.knob = label => [...document.querySelectorAll('.tools-volume [role=slider]')].find(e=>e.getAttribute('aria-label').startsWith(label));
      window.originalGeometry=JSON.stringify(wave().getBoundingClientRect().toJSON());
      window.sources=[];
      const create = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource=function(){const node=create.call(this),ctx=this,connect=node.connect.bind(node);const entry={node,ctx,connections:[],active:false};sources.push(entry);node.connect=(...args)=>{entry.connections.push(args[0]);return connect(...args)};const start=node.start.bind(node);node.start=(...args)=>{entry.active=true;return start(...args)};node.addEventListener('ended',()=>entry.active=false);return node;};
      window.FileReader=class{readAsArrayBuffer(){this.result=new ArrayBuffer(8);this.onload();}};
      window.fixtureSeconds=10;
      AudioContext.prototype.decodeAudioData=function(){const b=new AudioBuffer({length:48000*fixtureSeconds,sampleRate:48000,numberOfChannels:2});b.getChannelData(0).fill(.25);b.getChannelData(1).fill(.5);b.getChannelData(1)[4800]=.9;if(window.finalSpike)b.getChannelData(1)[b.length-1]=.99;return Promise.resolve(b);};
      window.load=()=>{const i=document.querySelector('input[type=file]'),d=new DataTransfer();d.items.add(new File(['audio'+(window.n=(window.n||0)+1)],'test'+window.n+'.wav'));i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));};
      document.querySelector('[aria-label="Volume"]').click();load();void 0;
    `);
    await wait(`!!props().audioBuffer&&!document.querySelector('main').inert`); await pause(500);
    assert.equal(await run('sources.length'), 0, 'opening Volume never starts playback');
    await run(`props().onSelectionChange({start:0,end:.2})`); await pause();
    await run(`button('Selection').click()`);await pause();await run(`button('Detect').click()`);
    await wait(`!button('Detect').disabled&&peak().includes('-0.9')`);
    await shot('selection');
    assert.equal(await run(`button('Detect').title.includes('Affected frames: 1.')`), true, 'right-channel-only affected frame');
    await run(`window.originalBuffer=props().audioBuffer`);for(let i=0;i<8;i++){await run(`knob('Threshold').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);await pause(5);}
    assert.equal(await run(`button('Reduce Peaks').disabled`), true, 'count marked stale immediately');
    await pause(180);
    assert.equal(await run(`button('Reduce Peaks').disabled`), false, 'automatic cached refresh, no Detect needed');
    assert.equal(await run('props().audioBuffer===originalBuffer'), true, 'knob changes never process');
    assert.equal(await run(`knob('Threshold').getAttribute('aria-valuenow')`), '-7');
    assert.equal(await run(`button('Detect').title.includes('Affected frames: 1.')`), true, 'ceiling excludes unchanged frames');
    // Validated entry, unchanged blur, invalid value and Escape cancellation.
    const entry = async (label, text, key = 'Enter') => {
      await run(`window.edit=document.querySelector('[aria-label="${label}"]');edit.focus();edit.select()`);
      await win.webContents.debugger.sendCommand('Input.insertText',{text});
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:key==='Enter'?13:27});
      await pause(140);
    };
    win.webContents.debugger.attach('1.3');
    await entry('Threshold value in dB','-7.3'); assert.equal(await run(`knob('Threshold').getAttribute('aria-valuenow')`), '-7'); assert.match(await run('vstatus()'), /0.5 dB steps/); await shot('invalid-entry');
    await entry('Threshold value in dB','-12','Escape'); assert.equal(await run(`knob('Threshold').getAttribute('aria-valuenow')`), '-7');
    await entry('Threshold value in dB','-24');await entry('Ceiling value in dB','-24');await shot('minimum-values');assert.equal(await run(`document.querySelector('[aria-label="Threshold value in dB"]').value`),'-24.0');
    await entry('Ceiling value in dB','-12'); await entry('Threshold value in dB','-9');
    assert.equal(await run(`button('Detect').title.includes('Affected frames: 9600.')`), true, 'one frame per sample even when stereo both exceed threshold');
    await run(`window.before=props().audioBuffer;button('Reduce Peaks').click()`);await shot('processing');
    await wait(`props().audioBuffer!==before&&!button('Detect').disabled`);
    assert.equal(await run(`props().audioBuffer.getChannelData(1)[9600]===before.getChannelData(1)[9600]`), true, 'exclusive selection end and outside exact');
    assert.equal(await run(`props().audioBuffer.getChannelData(0)[100]===before.getChannelData(0)[100]`), true, 'lower channel not attenuated by clamp');
    assert.ok(await run(`Math.abs(props().audioBuffer.getChannelData(1)[4800]-Math.pow(10,-12/20))<1e-6`));
    await run(`document.querySelector('[aria-label="Undo last audio edit"]').click()`);await wait(`props().audioBuffer===before`);
    // Exact-scope invalidation and cancellation of stale work.
    await run(`props().onSelectionChange({start:.2,end:.4})`);await pause();assert.equal(await run(`button('Reduce Peaks').disabled`),true);assert.match(await run('peak()'), /—/);
    await run(`button('Detect').click();props().onSelectionChange({start:.4,end:.6})`);await wait(`!button('Detect').disabled`);assert.match(await run('peak()'), /—/, 'stale scan not shown');
    await run(`props().onSelectionChange(null)`);await pause();assert.equal(await run(`button('Detect').disabled`),true);assert.equal(await run(`button('Normalise').disabled`),true);assert.match(await run('vstatus()'),/Select a region/);
    await run(`button('All').click()`);await pause();await run(`button('Detect').click()`);await shot('detecting');await wait(`!button('Detect').disabled&&peak().includes('-0.9')`);await shot('entire');
    // Pointer capture / Shift fine / release / cancellation / blur.
    const rect = await run(`knob('Normalise target').getBoundingClientRect().toJSON()`);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await run(`button('Normalise').focus()`);await shot('focus');
    const press = async fine => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x+13,y:rect.y+13,button:'left',buttons:1,clickCount:1,modifiers:fine?8:0});
    const release = async () => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+13,y:rect.y+13,button:'left',buttons:0,clickCount:1});
    await press(true);await pause();await shot('fine-pressed');assert.match(await run(`knob('Normalise target').className`), /border-amber/);
    const targetBefore=await run(`Number(knob('Normalise target').getAttribute('aria-valuenow'))`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+13,y:rect.y-7,button:'left',buttons:1,modifiers:8});await pause();
    const targetAfter=await run(`Number(knob('Normalise target').getAttribute('aria-valuenow'))`);assert.ok(Math.abs(targetAfter-targetBefore)<=.11);assert.ok(Math.abs(targetAfter*10-Math.round(targetAfter*10))<1e-6);
    await release();await pause();assert.doesNotMatch(await run(`knob('Normalise target').className`), /border-amber|border-sky-500/);
    await press(true);await run(`window.dispatchEvent(new Event('blur'))`);await pause();assert.doesNotMatch(await run(`knob('Normalise target').className`), /border-amber|border-sky-500/);await release();
    await press(true);await run(`knob('Normalise target').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}))`);await pause();assert.doesNotMatch(await run(`knob('Normalise target').className`), /border-amber|border-sky-500/);await release();
    // Real render-thread meters: actual stereo source, accurate held peak and one audible connection.
    await run(`document.querySelector('[aria-label="Play"]').click()`);await wait(`meter().levels.held[1]>.89`);await wait(`meter().levels.live[1]>.49&&meter().levels.live[1]<.51`);
    const levels=await run('meter().levels');console.log('actual playback peaks',JSON.stringify(levels));assert.ok(Math.abs(levels.held[0]-.25)<1e-6);assert.ok(Math.abs(levels.held[1]-.9)<1e-6);
    assert.ok(await run(`sources.every(e=>e.connections.filter(n=>n===e.ctx.destination).length===1)`),'one audible route');
    assert.ok(await run(`sources.every(e=>e.connections.filter(n=>n instanceof AudioWorkletNode).length<=1)`),'one meter connection per source');
    assert.equal(await run(`sources.filter(e=>e.active).length`),1);await shot('playing');
    await run(`document.querySelector('[aria-label="Pause"]').click()`);await pause(150);assert.deepEqual(await run('meter().levels.live'),[0,0]);assert.ok(await run('meter().levels.held[1]>.89'));await shot('paused');
    await run(`button('Reset').click()`);assert.deepEqual(await run('meter().levels.held'),[0,0]);
    await run(`document.querySelector('[aria-label="Play"]').click()`);await wait(`meter().levels.held[1]>.49`);
    const starts=await run('sources.length');await run(`document.querySelector('[aria-label="Volume"]').click()`);await pause();assert.equal(await run('meter().node'),null);assert.equal(await run('props().isPlaying'),true);
    await run(`document.querySelector('[aria-label="Volume"]').click()`);await wait(`!!meter().node&&meter().attached.size===1`);assert.equal(await run('sources.length'),starts,'tab navigation never restarts');
    await run(`document.querySelector('[aria-label="Stop"]').click()`);await pause();assert.deepEqual(await run('meter().levels.live'),[0,0]);assert.ok(await run('meter().levels.held[1]>.49'));await shot('stopped-held');
    await run(`button('Normalise').click()`);await wait(`props().audioBuffer!==before&&!button('Normalise').disabled`);await run(`document.querySelector('[aria-label="Play"]').click()`);await wait(`meter().levels.held[1]>.93`);assert.equal(await run('meter().attached.size'),1);await run(`document.querySelector('[aria-label="Stop"]').click()`);
    await run('load()');await wait(`!document.querySelector('main').inert&&meter().levels.held[1]===0`);assert.deepEqual(await run('meter().levels.live'),[0,0]);
    // Natural completion still holds the final included sample, before visual stop cleanup.
    await run('window.fixtureSeconds=.25;window.finalSpike=true;load()');await wait(`!document.querySelector('main').inert&&props().audioBuffer.length===12000`);await pause(250);
    await run(`props().onLoopChange(false)`);await pause();await run(`document.querySelector('[aria-label="Play"]').click()`);await wait(`!props().isPlaying&&meter().levels.held[1]>.98`);assert.deepEqual(await run('meter().levels.live'),[0,0]);
    assert.equal(await run('JSON.stringify(wave().getBoundingClientRect().toJSON())'),await run('originalGeometry'));
    // Long fixture keeps genuine detection/processing feedback visible for actual-size capture.
    await run('window.fixtureSeconds=180;load()');await wait(`!document.querySelector('main').inert&&props().audioBuffer.length===8640000&&!document.body.textContent.includes('Building waveform')`);await pause(150);
    await run(`window.volumeHeartbeats=0;window.volumeHeartbeat=setInterval(()=>volumeHeartbeats++,10);button('Detect').click()`);await shot('detecting');assert.equal(await run(`button('Detect').disabled`),true);await wait(`!button('Detect').disabled`);assert.ok(await run('volumeHeartbeats>10'),'actual UI continues handling tasks during scan');
    await run(`window.longBefore=props().audioBuffer;button('Reduce & Normalise').click()`);await shot('processing');assert.equal(await run(`button('Normalise').disabled`),true);await wait(`props().audioBuffer!==longBefore&&!button('Normalise').disabled`);await run('clearInterval(volumeHeartbeat)');
    await run(`document.querySelector('[aria-label="Undo last audio edit"]').click()`);await wait(`props().audioBuffer===longBefore`);
    console.log('PASS selection / stereo frame counts / cached refresh / entry / stale cancellation / scoped reduction / undo / knob cleanup / actual playback peaks / pause / Reset / tab lifecycle / replacement / fixed geometry');
    win.destroy();app.quit();
  } catch(e) { console.error(e);try{console.log(await run(`({peak:peak(),status:vstatus(),scope:document.querySelector('[role=switch][aria-label="Selection / All range"]').getAttribute('aria-checked')})`));}catch{} try { await shot('failure'); } catch {} win.destroy();app.exit(1); }
});
