// Loop / Sample regression using real imported audio and native Web Audio sources.
// Run after npm run build: electron scripts/check-loop-sample.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = path.join(__dirname, '../build', 'start-beat-regression-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const output = path.join(__dirname, '../build/start-beat-samples'); fs.mkdirSync(output, {recursive:true});
  const store = require('../electron/sample-export.cjs').createSampleExportStore(path.join(output,'settings.json'));
  let failSave = false, writeDelay = 0, folderDelay = 0, cancelChooser = false;
  ipcMain.handle('sample:get-folder',()=>store.getFolder());
  ipcMain.handle('sample:set-folder',async (_event,folder)=>{if(folderDelay)await new Promise(r=>setTimeout(r,folderDelay));return store.setFolder(folder);});
  ipcMain.handle('sample:choose-folder',()=>cancelChooser?null:store.setFolder(output));
  ipcMain.handle('sample:save',async (_event,request)=> { if(writeDelay)await new Promise(r=>setTimeout(r,writeDelay)); if(failSave)throw Error('Simulated save failure'); return store.save(request); });
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false, preload:path.join(__dirname,'../electron/preload.cjs') } });
  const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(e) { console.error('Failed renderer code:', code.slice(0,180)); throw e; } };
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
    await win.webContents.session.clearStorageData({storages:['localstorage']});
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
    win.webContents.setAudioMuted(true);
    await run(`window.sources = []; const create = AudioContext.prototype.createBufferSource; AudioContext.prototype.createBufferSource = function() { const node = create.call(this); const entry = {node, active:false}; sources.push(entry); const start = node.start.bind(node), stop = node.stop.bind(node); node.start = (...args) => { entry.active = true; entry.offset = args[1]; return start(...args); }; node.stop = (...args) => { entry.active = false; return stop(...args); }; return node; }; void 0;`);
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
    const region = async (start,end,kind='edge') => { await run(`component().memoizedProps.onSelectionChange({start:${start},end:${end}}, '${kind}')`); await pause(); };
    const mouseClick = async (time,yRatio=.75) => {
      const r=await run('wave().getBoundingClientRect().toJSON()'), d=await run('audioDuration');
      const x=r.left+r.width*time/d,y=r.top+r.height*yRatio;
      for(const type of ['mouseMoved','mousePressed','mouseReleased']) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',buttons:type==='mousePressed'?1:0,clickCount:type==='mouseMoved'?0:1}); await pause(); }
    };
    const type = async (label,text) => {
      await run(`(() => { const el=document.querySelector('[aria-label="${label}"]');el.focus();el.select(); })()`); await pause();
      await win.webContents.debugger.sendCommand('Input.insertText',{text}); await pause();
    };
    const select = async (label,value) => { await run(`(() => { const el=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'${value}');el.dispatchEvent(new Event('change',{bubbles:true})); })()`); await pause(); };
    const rect=await run('wave().getBoundingClientRect().toJSON()');
    let panels;
    const stable = async () => {
      if(await run(`document.querySelector('[aria-label="Show sample save"]').getClientRects().length>0`)) { const current=await run(`[...document.querySelectorAll('.loop-section')].map(e=>e.getBoundingClientRect().toJSON())`); panels ??= current; assert.deepEqual(current,panels,'Placement and Save feedback preserve panel geometry'); }
      assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'),rect);
      const result=await run(`(() => {const p=document.querySelector('[aria-label="Tools"]').getBoundingClientRect();return {scroll:document.documentElement.scrollHeight>innerHeight,overflow:[...document.querySelectorAll('.loop-sample-controls button,.loop-sample-controls input,.loop-sample-controls select,.start-beat-readout,.sample-save-feedback')].filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect();return r.left<p.left-1||r.right>p.right+1||r.bottom>p.bottom+1}).map(e=>e.outerHTML)};})()`);
      assert.equal(result.scroll,false);assert.deepEqual(result.overflow,[]);
    };
    const shot=async name=>{await stable();await win.webContents.capturePage();await pause();fs.writeFileSync(path.join(__dirname,`../build/start-beat-${name}.png`),(await win.webContents.capturePage()).toPNG());};
    const saved = async () => {
      await wait(`document.querySelector('[aria-label="Show sample save"]').getClientRects().length>0 && document.querySelector('.loop-control-status').textContent.includes('Saved:')`);
      await shot('returned-controls');
      await click('Show sample save');
    };
    await click('Loop / Sample');await click('Show sample save');
    assert.equal(await run(`document.querySelector('[aria-label="Sample format"]').value`),'flac');
    assert.equal(await run(`document.querySelector('[aria-label="Sample bit depth"]').value`),'16');
    await select('Sample format','wav');await select('Sample bit depth','24');await click('Cancel sample export');
    await region(1,3,'new');assert.equal(await run('component().memoizedProps.startBeat'),48000);
    await run('component().memoizedProps.onLoopChange(true)');await pause();
    const assertLoop=async()=>{assert.deepEqual(await run('currentSelection()'),{start:1,end:3});assert.equal(await run('component().memoizedProps.isLooping'),true);};
    let seekSources=await run('sources.length');await mouseClick(2.25);await assertLoop();assert.equal(await run('component().memoizedProps.isPlaying'),false);assert.equal(await run('sources.length'),seekSources);assert.ok(Math.abs(await run('component().memoizedProps.currentTime')-2.25)<.04);await shot('inactive');
    await mouseClick(3-.25/48000);await assertLoop();assert.equal(await run('component().memoizedProps.currentTime'),143999/48000,'Inside click rounds safely to last included sample');
    await click('Loop and play the selected region');seekSources=await run('sources.length');await mouseClick(2.25);await assertLoop();assert.equal(await run('component().memoizedProps.isPlaying'),true);assert.equal(await run('sources.length'),seekSources+1);assert.ok(Math.abs(await run('sources.at(-1).offset')-2.25)<.04);assert.equal(await run('sources.filter(s=>s.active).length'),1);
    await run('component().memoizedProps.onPlayPause()');await pause();seekSources=await run('sources.length');await mouseClick(1.75);await assertLoop();assert.equal(await run('component().memoizedProps.isPlaying'),false);assert.equal(await run('sources.length'),seekSources);assert.ok(Math.abs(await run('component().memoizedProps.currentTime')-1.75)<.04);
    await click('Clear selection');assert.equal(await run('currentSelection()'),null);assert.equal(await run('component().memoizedProps.isLooping'),false);assert.equal(await run('component().memoizedProps.isPlaying'),false);
    await region(1,3,'new');await click('Auto-Split');await mouseClick(2);assert.equal(await run('currentSelection()'),null,'Outside Loop / Sample an inside click retains legacy clearing');await click('Loop / Sample');await region(1,3,'new');

    await click('Set 1st Beat');await shot('placement');await mouseClick(4);assert.deepEqual(await run('currentSelection()'),{start:1,end:3});assert.equal(await run('component().memoizedProps.placingStartBeat'),true);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause();assert.equal(await run('component().memoizedProps.placingStartBeat'),false);assert.deepEqual(await run('currentSelection()'),{start:1,end:3});
    await click('Set 1st Beat');await click('Set 1st Beat');assert.equal(await run('component().memoizedProps.placingStartBeat'),false);
    await click('Set 1st Beat');await mouseClick(1.5);let beat=await run('component().memoizedProps.startBeat');assert.ok(Math.abs(beat-72000)<1500);assert.equal(await run('component().memoizedProps.placingStartBeat'),true);assert.equal(await run('component().memoizedProps.isPlaying'),false);await mouseClick(2);assert.equal(await run('component().memoizedProps.placingStartBeat'),true);beat=await run('component().memoizedProps.startBeat');
    await click('Set 1st Beat');
    await region(48001/48000,144003/48000,'new');
    await click('Increase 1st Beat');assert.equal(await run('component().memoizedProps.startBeat'),48481);assert.equal(await run('component().memoizedProps.placingStartBeat'),false);
    await run(`document.querySelector('[aria-label="Decrease 1st Beat"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))`);await pause();assert.equal(await run('component().memoizedProps.startBeat'),48433);assert.equal(await run('component().memoizedProps.placingStartBeat'),false,'Fine Move stays inactive');
    await click('Set 1st Beat');await mouseClick(2);assert.deepEqual(await run('currentSelection()'),{start:48001/48000,end:144003/48000});assert.equal(await run('component().memoizedProps.placingStartBeat'),true);
    await region(1,3,'new');await run('component().memoizedProps.onStartBeatChange(72013)');await pause();await click('Set 1st Beat');
    await type('Loop 1st Beat','1.500');await run(`document.querySelector('[aria-label="Loop 1st Beat"]').blur()`);await pause();assert.equal(await run('component().memoizedProps.startBeat'),72013);assert.equal(await run('component().memoizedProps.placingStartBeat'),false,'Unchanged rounded text preserves samples and mode');
    await type('Loop 1st Beat','1.750');await run(`document.querySelector('[aria-label="Loop 1st Beat"]').blur()`);await pause();assert.equal(await run('component().memoizedProps.startBeat'),84000);assert.equal(await run('component().memoizedProps.placingStartBeat'),false);beat=84000;await click('Set 1st Beat');
    await click('Increase 1st Beat');assert.equal(await run('component().memoizedProps.placingStartBeat'),true);await click('Decrease 1st Beat');
    await type('Loop 1st Beat','2.500');await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause();await run(`document.querySelector('[aria-label="Loop 1st Beat"]').blur()`);await pause();assert.equal(await run('component().memoizedProps.startBeat'),84000,'Escape cancels typed edits even in placement mode');assert.equal(await run('component().memoizedProps.placingStartBeat'),false);await click('Set 1st Beat');
    const controlsGeometry=await run(`[...document.querySelectorAll('.loop-section,.loop-section input,.loop-section button,.slide-control')].map(e=>e.getBoundingClientRect().toJSON())`);
    assert.equal(await run(`document.querySelector('.beat-placement-hint').textContent`),'Click inside loop');await shot('persistent');
    for(const view of ['Auto-Split','Show sample save']){await click(view);assert.equal(await run('component().memoizedProps.placingStartBeat'),false);await click(view==='Auto-Split'?'Loop / Sample':'Cancel sample export');await click('Set 1st Beat');}
    assert.deepEqual(await run(`[...document.querySelectorAll('.loop-section,.loop-section input,.loop-section button,.slide-control')].map(e=>e.getBoundingClientRect().toJSON())`),controlsGeometry);
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='RECORD').click()`);await pause();await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='EDIT').click()`);await pause();await wait(`!!document.querySelector('[aria-label="Edit waveform"]') && !document.querySelector('main').inert`);assert.equal(await run('component().memoizedProps.placingStartBeat'),false);await click('Loop / Sample');await click('Set 1st Beat');
    const dragCanvas=async(from,to,yRatio)=>{const r=await run('wave().getBoundingClientRect().toJSON()'),d=await run('audioDuration');for(const [type,time]of[['mouseMoved',from],['mousePressed',from],['mouseMoved',to],['mouseReleased',to]]){await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:r.left+r.width*time/d,y:r.top+r.height*yRatio,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:1});await pause();}};
    await dragCanvas(1,1.2,.5);assert.ok(Math.abs((await run('currentSelection()')).start-1.2)<.04);assert.equal(await run('component().memoizedProps.startBeat'),84000);assert.equal(await run('component().memoizedProps.placingStartBeat'),true);
    await region(1,3,'new');await run(`component().memoizedProps.onStartBeatChange(84000);component().memoizedProps.onFadeSettingsChange({...component().memoizedProps.fadeSettings,fadeInEnabled:true,fadeInMs:1000})`);await pause();
    const fadeRect=await run('wave().getBoundingClientRect().toJSON()');await dragCanvas(1,1.5,10/fadeRect.height);assert.ok((await run('component().memoizedProps.fadeSettings.fadeInMs'))>1400);assert.deepEqual(await run('currentSelection()'),{start:1,end:3});assert.equal(await run('component().memoizedProps.startBeat'),84000);await run(`component().memoizedProps.onFadeSettingsChange({...component().memoizedProps.fadeSettings,fadeInEnabled:false})`);await pause();
    await click('Loop and play the selected region');assert.equal(await run('sources.at(-1).offset'),beat/48000);
    const count=await run('sources.length');await mouseClick(2);assert.equal(await run('sources.length'),count,'Placement does not replace source');assert.equal(await run('component().memoizedProps.isPlaying'),true);assert.equal(await run('sources.filter(s=>s.active).length'),1);
    const dragBeat = async target => {
      const r=await run('wave().getBoundingClientRect().toJSON()'), d=await run('audioDuration'), sample=await run('component().memoizedProps.startBeat');
      const h=await run(`document.querySelector('[aria-label="Drag 1st Beat"]').getBoundingClientRect().toJSON()`);const y=h.top+h.height/2, from=h.left+h.width/2, to=r.left+r.width*target/d;
      for (const [type,x] of [['mouseMoved',from],['mousePressed',from],['mouseMoved',to],['mouseReleased',to]]) {
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'&&x===from?'none':'left',buttons:type==='mouseReleased'||(type==='mouseMoved'&&x===from)?0:1,clickCount:type==='mouseMoved'?0:1}); await pause();if(type==='mousePressed')assert.equal(await run(`document.querySelector('[aria-label="Drag 1st Beat"]').hasPointerCapture(1)`),true);
      }
    };
    await run(`window.beatEvents=[];for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture','dragstart','pointercancel'])document.addEventListener(type,e=>beatEvents.push({type,x:e.clientX,target:e.target.getAttribute('aria-label'),buttons:e.buttons}),true);void 0`);
    const dragSources=await run('sources.length');await click('Increase 1st Beat');await mouseClick(1.75);await mouseClick(2.25);await mouseClick(4);assert.deepEqual(await run('currentSelection()'),{start:1,end:3});assert.equal(await run('sources.length'),dragSources);assert.equal(await run('component().memoizedProps.placingStartBeat'),true);
    await dragBeat(2.5);assert.ok(await run(`beatEvents.some(e=>e.type==='gotpointercapture'&&e.target==='Drag 1st Beat')`));assert.equal(await run('component().memoizedProps.startBeat'),120000);
    assert.deepEqual(await run('currentSelection()'),{start:1,end:3});assert.equal(await run('sources.length'),dragSources,'Dragging beat leaves current source uninterrupted');
    await dragBeat(4);assert.equal(await run('component().memoizedProps.startBeat'),143999,'Clamp before exclusive end');
    await dragBeat(.5);assert.equal(await run('component().memoizedProps.startBeat'),48000,'Clamp to selection start');
    await dragBeat(2.5);await shot('dragged');const keySources=await run('sources.length');await run(`document.querySelector('[aria-label="Drag 1st Beat"]').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowLeft',shiftKey:true}))`);await pause();assert.equal(await run('component().memoizedProps.startBeat'),119952);assert.equal(await run('sources.length'),keySources);await dragBeat(2.5);
    beat=await run('component().memoizedProps.startBeat');await region(2,4,'move');assert.equal(await run('component().memoizedProps.startBeat'),beat+48000);
    await region(2.1,4,'edge');assert.equal(await run('component().memoizedProps.startBeat'),beat+48000);
    await region(3.9,4,'edge');assert.equal(await run('component().memoizedProps.startBeat'),187200);
    await click('Clear 1st Beat');assert.equal(await run('component().memoizedProps.placingStartBeat'),false);assert.equal(await run('component().memoizedProps.customStartBeat'),false);assert.equal(await run('component().memoizedProps.startBeat'),187200);
    await region(1,1.1,'new');await run('component().memoizedProps.onStartBeatChange(50400)');await pause();await click('Loop and play the selected region');assert.equal(await run('sources.at(-1).offset'),1.05);
    const clearSourceCount=await run('sources.length');await click('Clear 1st Beat');assert.equal(await run('component().memoizedProps.placingStartBeat'),false);assert.equal(await run('component().memoizedProps.startBeat'),48000);assert.equal(await run('component().memoizedProps.customStartBeat'),false);assert.equal(await run('sources.length'),clearSourceCount,'Clear leaves playback uninterrupted');assert.deepEqual(await run('currentSelection()'),{start:1,end:1.1});assert.equal(await run('component().memoizedProps.isPlaying'),true);
    await type('Loop 1st Beat','1.025');await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause();assert.equal(await run('component().memoizedProps.startBeat'),49200);assert.equal(await run('component().memoizedProps.customStartBeat'),true);assert.equal(await run('sources.length'),clearSourceCount,'Typed beat is passive until audition');assert.equal(await run('component().memoizedProps.placingStartBeat'),false);await click('Loop and play the selected region');assert.equal(await run('sources.at(-1).offset'),1.025);
    for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,80));const state=await run(`({time:component().memoizedProps.currentTime,playing:component().memoizedProps.isPlaying,active:sources.filter(s=>s.active).length})`);assert.equal(state.playing,true);assert.equal(state.active,1);assert.ok(state.time>=1&&state.time<1.1);}
    assert.equal(await run('component().memoizedProps.placingStartBeat'),false);await mouseClick(4);assert.equal(await run('currentSelection()'),null,'Outside normal click clears');assert.equal(await run('component().memoizedProps.isLooping'),false);
    await region(1,3,'new');await run('component().memoizedProps.onStartBeatChange(60000)');await pause();await click('Loop memory 9');await region(4,5,'new');await click('Set 1st Beat');await click('Loop memory 9');assert.equal(await run('component().memoizedProps.placingStartBeat'),false);assert.deepEqual(await run('currentSelection()'),{start:1,end:3});assert.equal(await run('component().memoizedProps.startBeat'),60000);await click('Show sample save');
    await click('Browse sample folder');assert.equal(await run(`document.querySelector('[aria-label="Sample destination"]').value`),output);
    await click('Cancel sample export');
    console.log('PASS: existing selection/seek, persistent placement, passive Move/edit, dragging, audition and playback tests; export scenarios covered by check-preset-batch.cjs');app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
