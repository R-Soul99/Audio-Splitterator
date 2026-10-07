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

    const click = async label => { await run(`document.querySelector('[aria-label="${label}"]').click()`); await pause(); };
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
    const stable = async () => {
      assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'),rect);
      const result=await run(`(() => {const p=document.querySelector('[aria-label="Tools"]').getBoundingClientRect();return {scroll:document.documentElement.scrollHeight>innerHeight,overflow:[...document.querySelectorAll('.loop-sample-controls button,.loop-sample-controls input,.loop-sample-controls select,.start-beat-readout,.sample-save-feedback')].filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect();return r.left<p.left-1||r.right>p.right+1||r.bottom>p.bottom+1}).map(e=>e.outerHTML)};})()`);
      assert.equal(result.scroll,false);assert.deepEqual(result.overflow,[]);
    };
    const shot=async name=>{await stable();await win.webContents.capturePage();await pause();fs.writeFileSync(path.join(__dirname,`../build/start-beat-${name}.png`),(await win.webContents.capturePage()).toPNG());};
    await click('Loop / Sample');await region(1,3,'new');assert.equal(await run('component().memoizedProps.startBeat'),48000);
    await click('Set Start Beat');await shot('placement');await mouseClick(4);assert.deepEqual(await run('currentSelection()'),{start:1,end:3});assert.equal(await run('component().memoizedProps.placingStartBeat'),true);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause();assert.equal(await run('component().memoizedProps.placingStartBeat'),false);assert.deepEqual(await run('currentSelection()'),{start:1,end:3});
    await click('Set Start Beat');await click('Set Start Beat');assert.equal(await run('component().memoizedProps.placingStartBeat'),false);
    await click('Set Start Beat');await mouseClick(1.5);let beat=await run('component().memoizedProps.startBeat');assert.ok(Math.abs(beat-72000)<1500);assert.equal(await run('component().memoizedProps.placingStartBeat'),false);assert.equal(await run('component().memoizedProps.isPlaying'),false);
    await click('Selection loop');assert.equal(await run('sources.at(-1).offset'),beat/48000);
    const count=await run('sources.length');await click('Set Start Beat');await mouseClick(2);assert.equal(await run('sources.length'),count,'Placement does not replace source');assert.equal(await run('component().memoizedProps.isPlaying'),true);assert.equal(await run('sources.filter(s=>s.active).length'),1);
    beat=await run('component().memoizedProps.startBeat');await region(2,4,'move');assert.equal(await run('component().memoizedProps.startBeat'),beat+48000);
    await region(2.1,4,'edge');assert.equal(await run('component().memoizedProps.startBeat'),beat+48000);
    await region(3.9,4,'edge');assert.equal(await run('component().memoizedProps.startBeat'),187200);
    await click('Reset Start Beat');assert.equal(await run('component().memoizedProps.startBeat'),187200);
    await region(1,1.1,'new');await run('component().memoizedProps.onStartBeatChange(50400)');await pause();await click('Loop and play the selected region');assert.equal(await run('sources.at(-1).offset'),1.05);
    for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,80));const state=await run(`({time:component().memoizedProps.currentTime,playing:component().memoizedProps.isPlaying,active:sources.filter(s=>s.active).length})`);assert.equal(state.playing,true);assert.equal(state.active,1);assert.ok(state.time>=1&&state.time<1.1);}
    await mouseClick(4);assert.equal(await run('currentSelection()'),null,'Normal click clears');assert.equal(await run('component().memoizedProps.isLooping'),false);
    await region(1,3,'new');await run('component().memoizedProps.onStartBeatChange(60000)');await pause();await click('Show sample save');
    await click('Browse sample folder');assert.equal(await run(`document.querySelector('[aria-label="Sample destination"]').value`),output);
    const savedBase='Sample Regression '+Date.now();await type('Sample filename',savedBase);
    await select('Sample bit depth','24');await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Saved:')`);await shot('success');
    const wavPath=path.join(output,savedBase+'.wav'),savedWav=fs.readFileSync(wavPath);
    const verify=async (bytes,start=48000,end=144000,beat=60000,depth=24)=>run(`(async()=>{const bytes=Uint8Array.from(${JSON.stringify([...bytes])});const original=component().memoizedProps.audioBuffer;const decoded=await new OfflineAudioContext(2,1,original.sampleRate).decodeAudioData(bytes.buffer);if(decoded.length!==${end-start}||decoded.numberOfChannels!==2||decoded.sampleRate!==48000)throw Error('Decoded stream properties differ');for(let c=0;c<2;c++)for(let i=0;i<decoded.length;i++){const index=i<${end-beat}?${beat}+i:${start}+i-${end-beat};const sample=original.getChannelData(c)[index];const integer=${depth}===24?Math.floor(sample<0?sample*0x800000:sample*0x7fffff):Math.trunc(sample<0?sample*0x8000:sample*0x7fff);const scale=${depth}===24?0x800000:0x8000;const quantized=integer/(integer>=0?scale-1:scale);if(Math.round(decoded.getChannelData(c)[i]*(integer>=0?scale-1:scale))!==integer)throw Error('Decoded sample order differs at '+i+' channel '+c+' actual='+decoded.getChannelData(c)[i]+' expected='+quantized+' source='+sample);}return true;})()`);
    assert.equal(await verify(savedWav),true);
    await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Filename exists')`);await stable();
    await run(`([...document.querySelectorAll('.sample-save-feedback button')].find(b=>b.textContent==='Numbered')).click()`);await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Saved:')`);assert.ok(fs.existsSync(path.join(output,savedBase+' (2).wav')));
    await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Filename exists')`);await run(`([...document.querySelectorAll('.sample-save-feedback button')].find(b=>b.textContent==='Replace')).click()`);await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Saved:')`);
    await select('Sample format','flac');await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Saved:')`);assert.equal(await verify(fs.readFileSync(path.join(output,savedBase+'.flac'))),true);
    // Default Start Beat and both supported bit depths.
    await run('component().memoizedProps.onStartBeatChange(48000)');await pause();await select('Sample bit depth','16');
    for(const format of ['wav','flac']){await select('Sample format',format);await type('Sample filename',savedBase+' default');await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Saved:')`);assert.equal(await verify(fs.readFileSync(path.join(output,savedBase+' default.'+format)),48000,144000,48000,16),true);}
    // The smallest possible selection exports one frame, including the final recording frame.
    const last=await run('component().memoizedProps.audioBuffer.length-1');await region(last/48000,(last+1)/48000,'new');await select('Sample bit depth','24');
    for(const format of ['wav','flac']){await select('Sample format',format);await type('Sample filename',savedBase+' one');await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Saved:')`);assert.equal(await verify(fs.readFileSync(path.join(output,savedBase+' one.'+format)),last,last+1,last),true);}
    await region(1,3,'new');await run('component().memoizedProps.onStartBeatChange(60000)');await pause();
    // Encode a snapshot, then alter selection, marker and settings during the save.
    await select('Sample format','wav');await type('Sample filename',savedBase+' immutable');writeDelay=1500;
    await click('Save Sample');await region(4,5,'new');await select('Sample format','flac');await type('Sample filename','changed');await shot('saving');
    assert.equal(await run(`document.querySelector('[aria-label="Save Sample"]').disabled`),true);await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Saved:')`);writeDelay=0;
    assert.equal(await verify(fs.readFileSync(path.join(output,savedBase+' immutable.wav'))),true);
    // Cancellation before publication must create no file and no success message.
    await select('Sample format','wav');await type('Sample filename',savedBase+' cancel');folderDelay=250;await click('Save Sample');
    await run(`document.querySelector('.sample-save-feedback button').click()`);await wait(`!document.querySelector('[aria-label="Save Sample"]').disabled`);folderDelay=0;
    assert.ok(await run(`document.querySelector('.sample-save-feedback').textContent.includes('cancelled')`));assert.equal(fs.existsSync(path.join(output,savedBase+' cancel.wav')),false);await stable();
    cancelChooser=true;await click('Browse sample folder');assert.equal(await run(`document.querySelector('[aria-label="Sample destination"]').value`),output);cancelChooser=false;
    failSave=true;await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('Error:')`);await shot('error');failSave=false;
    await type('Sample filename','../invalid');await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('valid sample filename')`);await stable();
    await type('Sample filename','valid');await type('Sample destination','relative');await click('Save Sample');await wait(`document.querySelector('.sample-save-feedback').textContent.includes('full sample destination')`);await stable();
    await click('Show loop controls');await click('Set Start Beat');assert.equal(await run('component().memoizedProps.placingStartBeat'),true);
    await run('clearSelection()');await pause();assert.equal(await run('component().memoizedProps.placingStartBeat'),false);
    await region(1,3,'new');await click('Set Start Beat');
    await run(`document.querySelector('input[type=file]').value=''`);
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[file]});await wait(`!document.querySelector('main').inert && currentSelection()===null`);
    assert.equal(await run('component().memoizedProps.placingStartBeat'),false);assert.equal(await run('component().memoizedProps.startBeat'),null);
    await win.reload();await wait(`!!document.querySelector('[aria-label="Edit waveform"]') || !!document.querySelector('main')`);
    await win.webContents.debugger.sendCommand('DOM.getDocument').then(async ({root})=>{const {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'});await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[file]});});
    await wait(`!!document.querySelector('[aria-label="Edit waveform"]') && !document.querySelector('main').inert`);await click('Loop / Sample');await click('Show sample save');await wait(`document.querySelector('[aria-label="Sample destination"]').value===${JSON.stringify(output)}`);
    assert.equal(await store.getFolder(),output);
    console.log('PASS: placement consumes native clicks; outside/Escape/toggle/normal clear; marker move/reset; audition offset and repeated native loops; WAV/FLAC 16/24-bit default/rotated/one-frame decoded sample order/rate/channels/count; immutable snapshot; collision choices; invalid name/path; failure/cancellation; remembered destination; stable 980x650 layout and feedback');app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
