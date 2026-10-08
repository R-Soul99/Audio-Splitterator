// Loop memory regression using real imported audio and native Web Audio sources.
// Run after npm run build: electron scripts/check-loop-memory.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = path.join(__dirname, '../build', 'loop-memory-regression-profile');
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
    const setRegion = async (start, end) => { await run(`component().memoizedProps.onSelectionChange({start:${start},end:${end}})`); await pause(); };
    const rect = await run('wave().getBoundingClientRect().toJSON()');
    await click('Loop / Sample');
    assert.equal(await run(`document.querySelector('[aria-label="Halve selection"]').disabled`), true);
    const snapshot = async name => { await win.webContents.capturePage(); await pause(); fs.writeFileSync(path.join(__dirname, `../build/loop-memory-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
    const state = () => run(`({selection:currentSelection(),beat:component().memoizedProps.startBeat,custom:component().memoizedProps.customStartBeat,loop:component().memoizedProps.isLooping,playing:component().memoizedProps.isPlaying,slots:component().memoizedProps.loopMemory})`);
    const slot = i => `[aria-label="Loop memory ${i}"]`;
    const press = async (i, modifiers={}) => { await run(`document.querySelector('${slot(i)}').dispatchEvent(new MouseEvent('click',{bubbles:true,...${JSON.stringify(modifiers)}}))`); await pause(); };
    const key = async (key, options={}) => { await run(`(document.activeElement||window).dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:${JSON.stringify(key)},...${JSON.stringify(options)}}))`); await pause(); await run(`window.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(key)}}))`);await pause(); };
    const exact = {start:48001/48000,end:144007/48000};
    assert.equal(await run(`document.querySelector('${slot(7)}').disabled`),true);
    await key('7'); assert.equal((await state()).slots.filter(Boolean).length,0);
    await setRegion(exact.start,exact.end);await run('component().memoizedProps.onStartBeatChange(72013)');await pause();
    await press(7);let saved=(await state()).slots[7];assert.deepEqual({...saved,used:0},{start:48001,end:144007,beat:72013,custom:true,used:0});
    assert.equal(await run(`document.querySelector('${slot(7)}').getAttribute('aria-pressed')`),'true');
    await press(8);assert.equal(await run(`document.querySelector('${slot(8)}').getAttribute('aria-pressed')`),'true');
    await run('clearSelection()');await pause();const unchanged=(await state()).slots[8];await press(8,{shiftKey:true});assert.deepEqual((await state()).slots[8],unchanged);await press(8);assert.deepEqual((await state()).selection,exact);
    await setRegion(4,5);assert.equal(await run(`document.querySelector('${slot(8)}').getAttribute('aria-pressed')`),'false');assert.deepEqual((await state()).slots[7],saved);
    await run(`component().memoizedProps.onPlacementChange(true)`);await pause();await press(7);
    let restored=await state();assert.deepEqual(restored.selection,exact);assert.equal(restored.beat,72013);assert.equal(restored.custom,true);assert.equal(restored.loop,true);assert.equal(restored.playing,false);assert.equal(await run('component().memoizedProps.placingStartBeat'),false);
    await click('Clear 1st Beat');await press(0);assert.equal((await state()).slots[0].custom,false);
    await press(7);await press(0);assert.equal((await state()).custom,false);assert.equal((await state()).beat,48001);
    await setRegion(4,5);await run('component().memoizedProps.onStartBeatChange(216003)');await pause();await press(8,{shiftKey:true});assert.equal((await state()).slots[8].beat,216003);
    // Text-entry exclusions, modifiers, repeat and number-pad semantics.
    await run(`document.querySelector('[aria-label="Loop Start"]').focus()`);await key('1');assert.equal((await state()).slots[1],null);await run('document.activeElement.blur()');
    for(const type of ['input','textarea','select','contenteditable','textbox','searchbox','combobox']) {
      await run(`(()=>{let e=document.createElement(${JSON.stringify('div')});if(['input','textarea','select'].includes('${type}'))e=document.createElement('${type}');else if('${type}'==='contenteditable')e.contentEditable='true';else {e.setAttribute('role','${type}');e.tabIndex=0;}document.body.append(e);e.focus();window.entry=e;})()`);
      await key('1');assert.equal((await state()).slots[1],null,type);await run('entry.remove()');
    }
    for(const option of [{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true},{repeat:true}]) {await key('1',option);assert.equal((await state()).slots[1],null);}
    await key('1',{code:'Numpad1'});assert.ok((await state()).slots[1]);await key('2',{code:'Numpad2'});assert.ok((await state()).slots[2]);
    await key('End',{code:'Numpad1'});assert.equal((await state()).slots.filter(Boolean).length,5);
    await click('Auto-Split');await key('3');assert.equal((await state()).slots[3],null);await click('Loop / Sample');
    await click('Show sample save');await key('3');assert.equal((await state()).slots[3],null);await click('Show loop controls');
    // Leaving Edit unmounts its controls; memory is still recording-owned.
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='RECORD').click()`);await pause();await key('3');await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='EDIT').click()`);await wait(`!!document.querySelector('[aria-label="Edit waveform"]') && !document.querySelector('main').inert`);await click('Loop / Sample');assert.ok((await state()).slots[7]);assert.equal((await state()).slots[3],null);
    await run(`document.querySelector('${slot(1)}').focus()`);await key('Delete');assert.equal((await state()).slots[1],null);
    await press(7);const beforeClear=await state();await run(`document.querySelector('${slot(7)}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);await pause();assert.equal((await state()).slots[7],null);assert.deepEqual((await state()).selection,beforeClear.selection);
    await press(7);await snapshot('stopped');
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await run(`document.querySelector('${slot(7)}').focus()`);await pause();assert.equal(await run(`getComputedStyle(document.querySelector('${slot(7)}')).outlineStyle`),'dashed');await snapshot('focused');
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',shiftKey:true}))`);await pause();await snapshot('replace');await run(`window.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift'}))`);await pause();
    // A recalled final one-frame loop must bypass transport's crop-end reset heuristic.
    await setRegion((frames-1)/rate,frames/rate);await click('Clear 1st Beat');await press(9);await press(7);await press(9);await run('component().memoizedProps.onPlayPause()');await pause();assert.equal(await run('sources.at(-1).offset'),(frames-1)/rate);await run('component().memoizedProps.onPlayPause()');await pause();await press(7);

    await run('component().memoizedProps.onPlayPause()');await pause();assert.equal(await run('sources.at(-1).offset'),72013/48000);
    await run('component().memoizedProps.onPlayPause()');await pause();await press(8);assert.equal((await state()).playing,false);await run('component().memoizedProps.onPlayPause()');await pause();assert.equal(await run('sources.at(-1).offset'),216003/48000);
    await press(7);assert.equal(await run('sources.at(-1).offset'),72013/48000);
    // Observe actual rendered PCM, independently of the cursor formula.
    await run(`(async()=>{
      const code="class Tap extends AudioWorkletProcessor {process(inputs){if(inputs[0]?.[0])this.port.postMessage({clock:currentFrame/sampleRate,rate:sampleRate,data:Array.from(inputs[0][0])});return true}}registerProcessor('tap',Tap)";
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await audioClock.audioWorklet.addModule(url);URL.revokeObjectURL(url);
      window.tap=new AudioWorkletNode(audioClock,'tap');tap.port.onmessage=e=>{blocks.push(e.data);if(blocks.length>1000)blocks.shift();};tap.connect(audioClock.destination);sources.at(-1).node.connect(tap);
      window.alignment=()=>{const clock=lastHeard;const latest=sources.at(-1),prior=sources.at(-2);if(clock<latest.when&&(!prior||prior.until<latest.when-1e-8))return null;const block=[...blocks].reverse().find(b=>b.clock<=clock&&b.clock+b.data.length/b.rate>clock);if(!block)return null;const sample=block.data[Math.floor((clock-block.clock)*block.rate)];if(sample===0)return null;const index=(sample*32768-2000)/20000*${frames};return {cursor:component().memoizedProps.currentTime,pcm:index/${rate},clock};};
    })()`);
    let observed=0,maxError=0;
    const repeats = async () => {
      for (let i=0;i<12;i++) { await new Promise(r=>setTimeout(r,80)); const state=await run(`new Promise(resolve=>setTimeout(()=>resolve({playing:component().memoizedProps.isPlaying, looping:component().memoizedProps.isLooping, time:component().memoizedProps.currentTime, selection:currentSelection(), active:sources.filter(s=>s.active&&s.when<=s.ctx.currentTime&&(!s.until||s.until>s.ctx.currentTime)).length,alignment:alignment()}),5))`); assert.equal(state.playing,true); assert.equal(state.looping,true); assert.equal(state.active,1);
        if(state.alignment){const error=Math.abs(state.alignment.cursor-state.alignment.pcm);maxError=Math.max(maxError,error);observed++;assert.ok(error<.004,'Cursor vs actual PCM '+JSON.stringify(state.alignment));}
      }
    };
    await repeats();
    for(let i=0;i<8;i++){await press(i%2?7:8);await repeats();}
    // Rapid recalls in a single renderer turn exercise scheduled, not yet audible sources.
    await run(`for(let i=0;i<30;i++)component().memoizedProps.onMemoryAction(i%2?7:8,'activate');void 0`);await pause();await repeats();
    assert.equal(await run(`sources.some((a,i)=>sources.slice(i+1).some(b=>Math.max(a.when,b.when)<Math.min(a.until??(a.when+(a.duration??Infinity)),b.until??(b.when+(b.duration??Infinity)))-1e-8))`),false,'No scheduled source overlap');
    const playingBefore=await state();await run(`document.querySelector('${slot(2)}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);await pause();assert.equal((await state()).playing,true);assert.deepEqual((await state()).selection,playingBefore.selection);
    for(const release of ['pointerup','pointercancel','blur']) {await run(`document.querySelector('${slot(7)}').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,shiftKey:true}));window.dispatchEvent(new Event('${release}'))`);await pause();assert.equal(await run(`document.querySelector('${slot(7)}').dataset.pressed`),'false');assert.equal(await run(`document.querySelector('${slot(7)}').dataset.replace`),'false');}
    const geometry=await run(`(()=>{const p=document.querySelector('[aria-label="Tools"]').getBoundingClientRect();return {panel:p.toJSON(),groups:[...document.querySelectorAll('.loop-section')].map(e=>e.getBoundingClientRect().toJSON()),controls:[...document.querySelectorAll('.loop-section button,.loop-section input,.loop-section output,.slide-encoder')].map(e=>({label:e.getAttribute('aria-label'),rect:e.getBoundingClientRect().toJSON()})),scroll:document.documentElement.scrollHeight>innerHeight};})()`);
    for(const c of geometry.controls)assert.ok(c.rect.right<=geometry.panel.right+1&&c.rect.bottom<=geometry.panel.bottom+1,JSON.stringify(c));assert.equal(geometry.scroll,false);assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'),rect);await snapshot('playing');
    await run('component().memoizedProps.onStop()');await pause();
    // Replacing the buffer through an existing edit path clears every slot.
    await run('component().memoizedProps.onApplyDePop(component().memoizedProps.audioBuffer, "same buffer")');await pause();assert.ok((await state()).slots[7]);
    await run(`(()=>{const p=component().memoizedProps,b=p.audioBuffer,c=new AudioContext(),copy=c.createBuffer(b.numberOfChannels,b.length,b.sampleRate);for(let i=0;i<b.numberOfChannels;i++)copy.copyToChannel(b.getChannelData(i),i);p.onApplyDePop(copy,'replacement');c.close();})()`);await pause();assert.equal((await state()).slots.filter(Boolean).length,0);
    // A newly imported recording also clears memory, even when samples are identical.
    await wait(`!document.querySelector('main').inert`);await press(4);assert.ok((await state()).slots[4]);
    const doc=await win.webContents.debugger.sendCommand('DOM.getDocument');const input=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type=file]'});await run(`document.querySelector('input[type=file]').value=''`);await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[file]});await pause();await wait(`!document.querySelector('main').inert && component().memoizedProps.selection===null`);assert.equal((await state()).slots.filter(Boolean).length,0);
    console.log('PASS: exact memory actions, stopped/paused/live recall, shortcuts/exclusions, buffer ownership, contained fixed groups, PCM checks',observed,'maximum error ms',maxError*1000);app.exit(0);
  } catch(error){console.error(error);app.exit(1);}
});
