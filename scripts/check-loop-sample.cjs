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
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) wav.writeInt16LE(c ? (i % (rate / 4) < 80 ? 20000 : 0) : Math.round(2000 + i / frames * 20000), 44 + i * 4 + c * 2);
    const file = path.join(__dirname, '../build/loop-sample-sync-transients.wav'); fs.writeFileSync(file, wav);
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
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
    assert.equal(await run(`document.querySelector('[aria-label="Decrease Start"]').textContent`),String.fromCodePoint(0x25c0));
    assert.equal(await run(`document.querySelector('[aria-label="Next selection"]').textContent`),String.fromCodePoint(0x25b6).repeat(2));
    const readouts=await run(`([...document.querySelectorAll('.loop-readout-frame')]).map(e=>({arrows:e.querySelectorAll('button').length,inputs:e.querySelectorAll('input').length}))`);assert.deepEqual(readouts,[{arrows:2,inputs:1},{arrows:2,inputs:1},{arrows:2,inputs:1}]);
    await setRegion(48001/48000,144003/48000);await run('component().memoizedProps.onStartBeatChange(72001)');await pause();
    const exact=await run('({selection:currentSelection(),beat:component().memoizedProps.startBeat})');
    for(const label of ['Loop Start','Loop End','Loop Start Beat']) {
      assert.match(await run(`document.querySelector('[aria-label="${label}"]').value`),/^\d+\.\d{3}$/);
      await run(`document.querySelector('[aria-label="${label}"]').focus()`);await pause();
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause();
      await run(`document.querySelector('[aria-label="${label}"]').blur()`);await pause();
      assert.deepEqual(await run('({selection:currentSelection(),beat:component().memoizedProps.startBeat})'),exact,'Unedited rounded readout keeps exact sample');
    }
    await typeTime('Loop Start Beat','1.625','Enter');assert.equal(await run('component().memoizedProps.startBeat'),78000);assert.equal(await run('component().memoizedProps.customStartBeat'),true);
    await click('Clear Start Beat');assert.equal(await run('component().memoizedProps.customStartBeat'),false);assert.equal(await run('component().memoizedProps.startBeat'),48001);
    await run(`document.querySelector('[aria-label="Loop Start Beat"]').focus();document.querySelector('[aria-label="Loop Start Beat"]').blur()`);await pause();assert.equal(await run('component().memoizedProps.customStartBeat'),false);
    await click('Increase Start Beat');assert.equal(await run('component().memoizedProps.customStartBeat'),true);assert.equal(await run('component().memoizedProps.startBeat'),48481);
    await click('Slide right');assert.deepEqual(await run('currentSelection()'),{start:48481/48000,end:144483/48000});assert.equal(await run('component().memoizedProps.startBeat'),48961);
    await click('Slide left');assert.deepEqual(await run('currentSelection()'),exact.selection);assert.equal(await run('component().memoizedProps.startBeat'),48481);
    await setRegion(0,2);assert.equal(await run(`document.querySelector('[aria-label="Slide left"]').disabled`),true);
    const boundaryDuration=await run('audioDuration');await setRegion(boundaryDuration-2,boundaryDuration);assert.equal(await run(`document.querySelector('[aria-label="Slide right"]').disabled`),true);
    await setRegion(1,3);
    await typeTime('Loop Start','100000.000','Enter');await typeTime('Loop End','100002.000','Enter');await typeTime('Loop Start Beat','100001.000','Enter');
    for(const label of ['Loop Start','Loop End','Loop Start Beat']) {
      const fit=await run(`(()=>{const input=document.querySelector('[aria-label="${label}"]'),c=document.createElement('canvas').getContext('2d');c.font=getComputedStyle(input).font;return {text:c.measureText(input.value).width,available:input.clientWidth-4};})()`);assert.ok(fit.text<=fit.available,JSON.stringify({label,...fit}));
    }
    await snapshot('long-values');
    for(const label of ['Loop Start','Loop End','Loop Start Beat']) await typeTime(label,'0','Escape');
    const rows=await run(`[...document.querySelectorAll('.loop-time-row,.loop-adjust-row')].map(e=>e.getBoundingClientRect().toJSON())`);assert.equal(rows.length,2);assert.ok(rows[1].top>=rows[0].bottom);
    assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'),rect,'Compact rows keep waveform geometry');
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
    assert.equal(await run('component().memoizedProps.isLooping'),true,'Entering mode arms selection loop');
    assert.equal(await run('sources.length'),0,'Default looping never starts playback');
    await run(`document.querySelector('[aria-label="Selection loop"]').focus()`);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});await pause();assert.equal(await run('sources.length'),0,'Keyboard loop switch never triggers playback');assert.equal(await run('component().memoizedProps.isLooping'),false);
    await click('Loop / Sample');assert.equal(await run('component().memoizedProps.isLooping'),true);assert.equal(await run('sources.length'),0);
    await run('component().memoizedProps.onStartBeatChange(72000)');await pause();
    await click('Next selection'); assert.deepEqual(await run('currentSelection()'), {start:3,end:5});
    assert.equal(await run('component().memoizedProps.startBeat'),168000);
    await click('Previous selection'); assert.deepEqual(await run('currentSelection()'), {start:1,end:3});
    await click('Increase Start');assert.deepEqual(await run('currentSelection()'),{start:1.01,end:3});
    const fineClick=async label=>{
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16,modifiers:8});await pause();
      await run(`document.querySelector('[aria-label="${label}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))`);await pause();
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16});await pause();
    };
    await fineClick('Slide right');assert.deepEqual(await run('currentSelection()'),{start:1.011,end:3.001});assert.equal(await run('component().memoizedProps.startBeat'),72048);await fineClick('Slide left');
    await fineClick('Decrease End');assert.deepEqual(await run('currentSelection()'),{start:1.01,end:2.999});
    await click('Increase Start Beat');assert.equal(await run('component().memoizedProps.startBeat'),72480);
    await fineClick('Decrease Start Beat');assert.equal(await run('component().memoizedProps.startBeat'),72432);
    await setRegion(0,2);assert.equal(await run(`document.querySelector('[aria-label="Previous selection"]').disabled`),true);
    assert.equal(await run(`document.querySelector('[aria-label="Decrease Start"]').disabled`),true);
    await setRegion(0,.005);assert.equal(await run(`document.querySelector('[aria-label="Increase Start"]').disabled`),true,'10ms cannot cross End');
    await fineClick('Increase Start');assert.deepEqual(await run('currentSelection()'),{start:.001,end:.005});
    await setRegion(1,3);
    const shift = async held => {await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:held?'keyDown':'keyUp',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16,modifiers:held?8:0});await pause();};
    const fineState = async () => run(`[...document.querySelectorAll('.loop-adjust-button[data-fine]')].map(b=>b.dataset.fine)`);
    for (const label of ['Increase Start','Decrease Start','Increase End','Decrease End','Increase Start Beat','Decrease Start Beat']) {
      await shift(true);assert.ok((await fineState()).every(v=>v==='true'));
      const r=await run(`document.querySelector('[aria-label="${label}"]').getBoundingClientRect().toJSON()`);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:r.x+r.width/2,y:r.y+r.height/2,button:'left',buttons:1,clickCount:1,modifiers:8});await pause();
      assert.equal(await run(`document.querySelector('[aria-label="${label}"]').matches(':active')`),true);
      await snapshot('fine-pressed');
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x+r.width/2,y:r.y+r.height/2,button:'left',buttons:0,clickCount:1,modifiers:8});await pause();
      assert.equal(await run(`document.querySelector('[aria-label="${label}"]').matches(':active')`),false);
      await shift(false);assert.ok((await fineState()).every(v=>v==='false'));
      const style=await run(`(()=>{const s=getComputedStyle(document.querySelector('[aria-label="${label}"]'));return {border:s.borderTopColor,shadow:s.boxShadow,background:s.backgroundColor};})()`);
      assert.equal(style.border,'rgb(51, 65, 85)');assert.equal(style.shadow,'none');assert.equal(style.background,'rgb(2, 6, 23)');
    }
    await snapshot('fine-released');
    await shift(true);await run(`window.dispatchEvent(new Event('blur'))`);await pause();assert.ok((await fineState()).every(v=>v==='false'));await shift(false);
    await shift(true);await click('Auto-Split');await click('Loop / Sample');assert.ok((await fineState()).every(v=>v==='false'));await shift(false);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await pause();
    await run(`document.querySelector('[aria-label="Increase Start"]').focus()`);await pause();
    assert.equal(await run(`getComputedStyle(document.querySelector('[aria-label="Increase Start"]')).outlineStyle`),'dashed');await snapshot('keyboard-focus');
    await click('Auto-Split');
    const knob=await run(`document.querySelector('[aria-label="Noise floor"]').getBoundingClientRect().toJSON()`);
    await shift(true);await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:knob.x+knob.width/2,y:knob.y+knob.height/2,button:'left',buttons:1,clickCount:1,modifiers:8});await pause();
    assert.ok(await run(`document.querySelector('[aria-label="Noise floor"]').className.includes('border-amber-400')`));
    await shift(false);assert.equal(await run(`document.querySelector('[aria-label="Noise floor"]').className.includes('border-amber-400')`),false,'Shared knob clears on Shift release without movement');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:knob.x+knob.width/2,y:knob.y+knob.height/2,button:'left',buttons:0,clickCount:1});await pause();
    await shift(true);await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:knob.x+knob.width/2,y:knob.y+knob.height/2,button:'left',buttons:1,clickCount:1,modifiers:8});await pause();
    await click('Loop / Sample');await click('Auto-Split');assert.equal(await run(`document.querySelector('[aria-label="Noise floor"]').className.includes('border-amber-400')`),false,'Tab change cancels shared knob fine state');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:knob.x+knob.width/2,y:knob.y+knob.height/2,button:'left',buttons:0,clickCount:1});await shift(false);
    await click('Loop / Sample');await setRegion(1,3);
    console.log('PASS: all six arrows release pressed/fine styling, blur/tab clear, distinct keyboard focus, shared knob Shift release');
    await snapshot('stopped');
    await setRegion(1,1+1/48000);const oneFrame=await run('currentSelection()');
    for(const label of ['Loop Start','Loop End']) {await run(`document.querySelector('[aria-label="${label}"]').focus();document.querySelector('[aria-label="${label}"]').blur()`);await pause();assert.deepEqual(await run('currentSelection()'),oneFrame,'Rounded identical endpoints retain one sample');}
    await setRegion(1, 1 + 1/48000); assert.equal(await run(`document.querySelector('[aria-label="Halve selection"]').disabled`),true);
    await click('Loop and play the selected region'); assert.equal(await run('sources.at(-1).node.loopEnd - sources.at(-1).node.loopStart > 0'),true);
    await setRegion(1, 1.1);
    // Observe actual rendered PCM, independently of the cursor formula.
    await run(`(async()=>{
      const code="class Tap extends AudioWorkletProcessor {process(inputs){if(inputs[0]?.[0])this.port.postMessage({clock:currentFrame/sampleRate,rate:sampleRate,data:Array.from(inputs[0][0])});return true}}registerProcessor('tap',Tap)";
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await audioClock.audioWorklet.addModule(url);URL.revokeObjectURL(url);
      window.tap=new AudioWorkletNode(audioClock,'tap');tap.port.onmessage=e=>{blocks.push(e.data);if(blocks.length>1000)blocks.shift();};tap.connect(audioClock.destination);sources.at(-1).node.connect(tap);
      window.alignment=()=>{const clock=lastHeard;const block=[...blocks].reverse().find(b=>b.clock<=clock&&b.clock+b.data.length/b.rate>clock);if(!block)return null;const sample=block.data[Math.floor((clock-block.clock)*block.rate)];if(sample===0)return null;const index=(sample*32768-2000)/20000*${frames};return {cursor:component().memoizedProps.currentTime,pcm:index/${rate},clock};};
    })()`);
    let observed=0,maxError=0;
    const repeats = async () => {
      for (let i=0;i<12;i++) { await new Promise(r=>setTimeout(r,80)); const state=await run(`new Promise(resolve=>setTimeout(()=>resolve({playing:component().memoizedProps.isPlaying, looping:component().memoizedProps.isLooping, time:component().memoizedProps.currentTime, selection:currentSelection(), active:sources.filter(s=>s.active&&s.when<=s.ctx.currentTime&&(!s.until||s.until>s.ctx.currentTime)).length,alignment:alignment()}),5))`); assert.equal(state.playing,true); assert.equal(state.looping,true); assert.equal(state.active,1);
        if(state.alignment){const error=Math.abs(state.alignment.cursor-state.alignment.pcm);maxError=Math.max(maxError,error);observed++;assert.ok(error<.004,'Cursor vs actual PCM '+JSON.stringify(state.alignment));}
      }
    };
    await repeats();

    const count = await run('sources.length'); await setRegion(.9, 1.2); assert.equal(await run('sources.length'), count+1, 'Inside edit schedules one replacement');

    await repeats(); await setRegion(2, 2.1); assert.equal(await run('sources.length'), count+2, 'Outside edit safely replaces source'); await repeats();
    await click('Slide right');await repeats();await click('Slide left');await repeats();
    await click('Increase Start');await repeats();await click('Decrease End');await repeats();
    const markerSource=await run('sources.length');await click('Increase Start Beat');assert.equal(await run('sources.length'),markerSource);await repeats();
    await click('Next selection');await repeats();await click('Previous selection');await repeats();
    await click('Halve selection');await repeats();await click('Double selection');await repeats();
    await run('component().memoizedProps.onPlayPause()');await pause();assert.equal(await run('component().memoizedProps.isPlaying'),false);assert.equal(await run('component().memoizedProps.isLooping'),true);await snapshot('paused');
    await run('component().memoizedProps.onPlayPause()');await pause();await repeats();
    await click('Loop and play the selected region');await repeats();
    await run(`component().memoizedProps.onSelectionChange({start:2,end:2.2});component().memoizedProps.onPlayPause();component().memoizedProps.onPlayPause();void 0`);await pause();await repeats();
    await run('window.originalRAF=requestAnimationFrame;window.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),400);void 0');
    await click('Loop and play the selected region');await new Promise(r=>setTimeout(r,200));await click('Decrease Start');await new Promise(r=>setTimeout(r,450));
    const stalled=await run('alignment()');assert.ok(stalled&&Math.abs(stalled.cursor-stalled.pcm)<.004,JSON.stringify(stalled));
    await run('window.requestAnimationFrame=originalRAF;void 0');
    for (const label of ['Auto-Split','Peak Tamer','Normalise','Loop / Sample']) { await click(label); assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'), rect); assert.equal(await run('component().memoizedProps.isLooping'),true); }
    await repeats();
    const geometry = await run(`(() => { const p=document.querySelector('[aria-label="Tools"]'), r=p.getBoundingClientRect(); return {panel:r.toJSON(), controls:[...document.querySelectorAll('[aria-label="Tools"] > div:first-child button, .loop-sample-controls button, .loop-sample-controls input, .loop-sample-controls select, .loop-sample-controls output, .loop-hint')].filter(e=>e.getClientRects().length).map(e=>({label:e.getAttribute('aria-label')||e.textContent, rect:e.getBoundingClientRect().toJSON()})), bodyScroll:document.documentElement.scrollHeight>innerHeight}; })()`);

    for (const control of geometry.controls) { assert.ok(control.rect.right <= geometry.panel.right+1 && control.rect.bottom <= geometry.panel.bottom+1 && control.rect.left >= geometry.panel.left-1, JSON.stringify(control)); }
    assert.equal(geometry.bodyScroll,false);
    fs.writeFileSync(path.join(__dirname, '../build/loop-sample-review.png'), (await win.webContents.capturePage()).toPNG());
    await snapshot('playing');
    const overlap=await run(`sources.some((a,i)=>sources.slice(i+1).some(b=>Math.max(a.when,b.when)<Math.min(a.until??(a.when+(a.duration??Infinity)),b.until??(b.when+(b.duration??Infinity)))-1e-8))`);assert.equal(overlap,false,'Source schedule intervals never overlap');
    assert.ok(observed>60);console.log('PCM alignment checks',observed,'maximum error ms',maxError*1000);
    console.log('Fixed layout: 980x650; Tools controls contained; no document scrolling');
    await click('Selection loop'); assert.equal(await run('component().memoizedProps.isLooping'),false);
    await new Promise(r=>setTimeout(r,1200));assert.equal(await run('component().memoizedProps.isPlaying'),false,'Non-loop playback completes');
    await click('Loop and play the selected region');await run('component().memoizedProps.onPlayPause()');await pause();
    await run('component().memoizedProps.onStop()');await pause();assert.equal(await run('component().memoizedProps.isPlaying'),false);assert.equal(await run('component().memoizedProps.isLooping'),false);
    await snapshot('loop-off');
    await run('component().memoizedProps.onStop()');await pause();
    await run('clearSelection()'); await pause(); assert.equal(await run('component().memoizedProps.isLooping'),false);
    console.log('PASS: loop controls, sample nudges, boundary disabling, several real native repeats after inside/outside edits, one active source, tabs preserve loop, stable waveform and contained controls at 980x650');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
