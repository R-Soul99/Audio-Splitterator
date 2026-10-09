// Loop / Sample regression using real imported audio and native Web Audio sources.
// Run after npm run build: electron scripts/check-loop-sample.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = path.join(__dirname, '../build', 'preset-batch-regression-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const output = path.join(__dirname, '../build/preset-batch-samples'); fs.mkdirSync(output, {recursive:true});
  const store = require('../electron/sample-export.cjs').createSampleExportStore(path.join(output,'settings.json'));
  let failSave = false, failSlot = null, requests = [], writeDelay = 0, folderDelay = 0, cancelChooser = false;
  ipcMain.handle('sample:get-folder',()=>store.getFolder());
  ipcMain.handle('sample:set-folder',async (_event,folder)=>{if(folderDelay)await new Promise(r=>setTimeout(r,folderDelay));return store.setFolder(folder);});
  ipcMain.handle('sample:choose-folder',()=>cancelChooser?null:store.setFolder(output));
  ipcMain.handle('sample:save',async (_event,request)=> { if(writeDelay)await new Promise(r=>setTimeout(r,writeDelay)); requests.push(request.name); if(failSave || request.name.includes(failSlot || 'NOT_A_SLOT'))throw Error('Simulated save failure'); return store.save(request); });
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

    const rect = await run('wave().getBoundingClientRect().toJSON()');
    const shot = async name => {
      assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'), rect);
      const layout = await run(`(()=>{const d=document.querySelector('dialog[open]');if(!d)return null;const r=d.getBoundingClientRect();return {scroll:d.scrollHeight>d.clientHeight,list:document.querySelector('.sample-export-items').scrollHeight>document.querySelector('.sample-export-items').clientHeight,off:[...d.querySelectorAll('button,input,select,label')].filter(e=>e.getClientRects().length).filter(e=>{const c=e.getBoundingClientRect();return c.bottom>r.bottom-5||c.right>r.right-5||c.top<r.top}).map(e=>e.outerHTML),rows:document.querySelectorAll('.sample-export-item').length};})()`);
      if(layout){assert.equal(layout.scroll,false);assert.equal(layout.list,false);assert.deepEqual(layout.off,[]);}
      await win.webContents.capturePage(); await pause();
      fs.writeFileSync(path.join(__dirname,`../build/preset-batch-${name}.png`),(await win.webContents.capturePage()).toPNG());
    };
    const done = () => wait(`!document.querySelector('dialog[open]')`);
    const busyDone = () => wait(`document.querySelector('.sample-export-status').getAttribute('aria-busy')==='false'`);
    const open = async () => {await click('Show sample save');await wait(`!!document.querySelector('dialog[open]')`);};
    const key = async (key,code=key,shift=false) => {await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers:shift?8:0,windowsVirtualKeyCode:key==='Escape'?27:key==='Tab'?9:key===' '?32:0});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:key==='Escape'?27:key==='Tab'?9:0});await pause();};
    await click('Loop / Sample');await open();assert.equal(await run(`document.querySelector('[aria-label="Sample format"]').value`),'flac');assert.equal(await run(`document.querySelector('[aria-label="Sample bit depth"]').value`),'16');assert.equal(await run(`document.querySelector('[aria-label="Save Sample"]').disabled`),true);await shot('unavailable');await key('Escape');await done();
    await region(1,1.1,'new');await run('component().memoizedProps.onStartBeatChange(50400)');await pause();await click('Loop and play the selected region');
    const before=await run(`({selection:currentSelection(),beat:component().memoizedProps.startBeat,count:sources.length,playing:component().memoizedProps.isPlaying})`);
    await open();await shot('current');await key('3','Digit3');await key(' ','Space');await key('Home');assert.deepEqual(await run(`({selection:currentSelection(),beat:component().memoizedProps.startBeat,count:sources.length,playing:component().memoizedProps.isPlaying})`),before);
    for(let i=0;i<25;i++){await key('Tab','Tab',i%2===1);assert.equal(await run(`document.querySelector('dialog').contains(document.activeElement)`),true);}
    await click('Browse sample folder');await select('Sample format','wav');await select('Sample bit depth','24');const base='Batch '+Date.now();await type('Sample filename',base);await click('Save Sample');await done();assert.deepEqual(await run(`({selection:currentSelection(),beat:component().memoizedProps.startBeat,count:sources.length,playing:component().memoizedProps.isPlaying})`),before);
    const verify=async (bytes,start=48000,end=144000,beat=60000,depth=24)=>run(`(async()=>{const bytes=Uint8Array.from(${JSON.stringify([...bytes])});const original=component().memoizedProps.audioBuffer;const decoded=await new OfflineAudioContext(2,1,original.sampleRate).decodeAudioData(bytes.buffer);if(decoded.length!==${end-start}||decoded.numberOfChannels!==2||decoded.sampleRate!==48000)throw Error('Decoded stream properties differ');for(let c=0;c<2;c++)for(let i=0;i<decoded.length;i++){const index=i<${end-beat}?${beat}+i:${start}+i-${end-beat};const sample=original.getChannelData(c)[index];const integer=${depth}===24?Math.floor(sample<0?sample*0x800000:sample*0x7fffff):Math.trunc(sample<0?sample*0x8000:sample*0x7fff);const scale=${depth}===24?0x800000:0x8000;const quantized=integer/(integer>=0?scale-1:scale);if(Math.round(decoded.getChannelData(c)[i]*(integer>=0?scale-1:scale))!==integer)throw Error('Decoded sample order differs at '+i+' channel '+c+' actual='+decoded.getChannelData(c)[i]+' expected='+quantized+' source='+sample);}return true;})()`);
    assert.equal(await verify(fs.readFileSync(path.join(output,base+'.wav')),48000,52800,50400,24),true);
    await open();assert.equal(await run(`document.querySelector('[aria-label="Sample destination"]').value`),output);assert.equal(await run(`document.querySelector('[aria-label="Sample format"]').value`),'wav');await click('Cancel sample export');await pause();assert.equal(await run(`document.activeElement.getAttribute('aria-label')`),'Show sample save');
    await run('component().memoizedProps.onStop()');await pause();

    // Default beat, one-sample end region, and both formats/depths still export exact raw cycles.
    for(const format of ['wav','flac']) for(const depth of [16,24]) {
      const start=depth===16?48000:frames-1,end=depth===16?48032:frames;
      await region(start/rate,end/rate,'new');await open();await select('Sample format',format);await select('Sample bit depth',String(depth));
      const name=base+' '+format+' '+depth;await type('Sample filename',name);await click('Save Sample');await done();
      assert.equal(await verify(fs.readFileSync(path.join(output,name+'.'+format)),start,end,start,depth),true);
    }
    // Ten stored, overlapping regions. Current edits must never alter these.
    const regions=[];
    for(const id of [1,2,3,4,5,6,7,8,9,0]){const start=48000+id*96,end=start+1920,beat=start+480;regions.push({id,start,end,beat});await region(start/rate,end/rate,'new');await run(`component().memoizedProps.onStartBeatChange(${beat})`);await pause();await click('Loop memory '+id);}
    await region(.5,.8,'new');await open();await click('Presets');assert.equal(await run(`document.querySelectorAll('.sample-export-item').length`),10);assert.equal(await run(`document.querySelectorAll('.sample-export-item input:checked').length`),10);await shot('ten-presets');
    await click('Select none');assert.equal(await run(`document.querySelector('[aria-label="Save Sample"]').disabled`),true);await click('Select all');
    await type('Sample filename',base+' presets');await select('Sample format','flac');await select('Sample bit depth','16');writeDelay=200;await click('Save Sample');await shot('progress');await key('Escape');assert.equal(await run(`!!document.querySelector('dialog[open]')`),true);await done();writeDelay=0;
    for(const r of regions){const suffix=String(r.id||10).padStart(2,'0');assert.equal(await verify(fs.readFileSync(path.join(output,base+' presets_'+suffix+'.flac')),r.start,r.end,r.beat,16),true);}
    assert.deepEqual(await run('currentSelection()'),{start:.5,end:.8});

    await open();await click('Presets');await click('Select none');await click('Export preset 7');await click('Export preset 0');await select('Sample format','wav');await select('Sample bit depth','24');await type('Sample filename',base+' subset');await click('Save Sample');await done();
    for(const id of [7,0]){const r=regions.find(r=>r.id===id);assert.equal(await verify(fs.readFileSync(path.join(output,base+' subset_'+String(id||10).padStart(2,'0')+'.wav')),r.start,r.end,r.beat,24),true);}
    // Explicit collision choices remain inside the modal. Subsets preserve slot numbers.
    await open();await click('Presets');await click('Select none');await click('Export preset 0');await type('Sample filename',base+' presets');await select('Sample format','flac');await select('Sample bit depth','16');await click('Save Sample');await wait(`!!document.querySelector('[aria-label="Replace existing sample"]')`);await shot('collision');await click('Numbered');await done();assert.ok(fs.existsSync(path.join(output,base+' presets_10 (2).flac')));
    await open();await click('Presets');await click('Select none');await click('Export preset 0');await type('Sample filename',base+' presets');await select('Sample format','flac');await select('Sample bit depth','16');await click('Save Sample');await wait(`!!document.querySelector('[aria-label="Replace existing sample"]')`);await click('Replace existing sample');await done();
    // Failure is per-item, reports retained results, and retry skips already saved items.
    await open();await click('Presets');await type('Sample filename',base+' retry');failSlot='_03';await click('Save Sample');await busyDone();await shot('partial-failure');assert.equal(await run(`document.querySelectorAll('[data-state="saved"]').length`),9);assert.equal(await run(`document.querySelectorAll('[data-state="failed"]').length`),1);const count=requests.length;failSlot=null;await click('Save Sample');await done();assert.equal(requests.length-count,1);
    // Cancel an in-flight write: finish that complete file, stop scheduling new files.
    await open();await click('Presets');await type('Sample filename',base+' cancelled');writeDelay=700;const previous=requests.length;await click('Save Sample');await wait(`document.querySelector('.sample-export-status').textContent.includes('Saving 1')`);await new Promise(r=>setTimeout(r,100));await click('Cancel sample export');await busyDone();await shot('cancelled');assert.equal(requests.length-previous,1);assert.equal(await run(`document.querySelectorAll('[data-state="saved"]').length`),1);writeDelay=0;await click('Save Sample');await done();assert.equal(requests.length-previous,10);
    // Invalid input cannot write, and closing an idle overlay preserves the loop.
    await open();await type('Sample filename','../invalid');await click('Save Sample');await wait(`document.querySelector('.sample-export-status').textContent.includes('valid sample filename')`);await type('Sample filename','Valid');await type('Sample destination','relative');await click('Save Sample');await busyDone();assert.ok(await run(`document.querySelector('.sample-export-status').textContent.includes('full sample destination')`));await click('Cancel sample export');
    await run(`component().memoizedProps.onZoomChange(10);component().memoizedProps.onViewOffsetChange(.95)`);await wait(`component().memoizedProps.zoom===10`);await pause();await shot('strip-overlap');

    const pixels=()=>run(`(()=>{const canvas=document.querySelector('[aria-label="Waveform indicators"]');return [...canvas.getContext('2d').getImageData(0,0,canvas.width,44).data];})()`);
    const barsBefore=await pixels();await region(.6,.9,'new');await pause();assert.deepEqual(await pixels(),barsBefore,'Editing selection never moves stored bars');
    const waveRect=await run('wave().getBoundingClientRect().toJSON()');
    const stripHover=async x=>{await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:waveRect.top+3});await pause();};
    await stripHover(waveRect.left+waveRect.width*(1.01-.95)/2);await wait(`!!document.querySelector('.preset-strip-tooltip')`);assert.ok(await run(`document.querySelector('.preset-strip-tooltip').textContent.includes('Start 1.002')`));await shot('strip-hover');
    await click('Loop memory 1');await shot('strip-visible-active');
    await run(`document.querySelector('[aria-label="Loop memory 1"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);await pause();assert.notDeepEqual(await pixels(),barsBefore,'Clearing updates strip immediately');
    await region(1.3,1.4,'new');await run(`document.querySelector('[aria-label="Loop memory 2"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))`);await pause();await stripHover(waveRect.left+waveRect.width*(1.35-.95)/2);await wait(`document.querySelector('.preset-strip-tooltip')?.textContent.includes('Start 1.300')`);await shot('strip-replaced');
    const savedSelection=await run('currentSelection()');
    for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:waveRect.left+waveRect.width*(1.35-.95)/2,y:waveRect.top+3,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});await pause();assert.deepEqual(await run('currentSelection()'),savedSelection,'Clicking a bar uses normal inside-loop seeking, not recall');

    await run(`component().memoizedProps.onViewOffsetChange(5)`);await pause();await shot('strip-clipped');assert.equal(await run(`!!document.querySelector('.preset-strip-tooltip')`),false);
    await run(`component().memoizedProps.onViewOffsetChange(.95)`);await pause();
    // Strip interactions use the waveform hit targets, never separate indicator nodes.
    assert.equal(await run(`document.querySelectorAll('.preset-strip-tooltip button').length`),0);await click('Loop memory 0');await shot('strip-active');
    assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'),rect);
    console.log('PASS: modal geometry/focus/keyboard isolation, current and ten/subset preset decoded exports, naming, preferences, collisions, cancellation, retained partial results and retry, stable waveform');app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
