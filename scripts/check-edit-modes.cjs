// Native mode switching regression. Run after npm run build with Electron.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(__dirname, '../build/edit-modes-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, autoHideMenuBar: true, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code).catch(e => { console.error(code); throw e; });
  const pause = () => new Promise(resolve => setTimeout(resolve, 60));
  const wait = async code => { const end = Date.now() + 20000; while (!await run(code)) { if (Date.now() > end) throw Error(code); await pause(); } };
  const click = async label => { await run(`document.querySelector('[aria-label="${label}"]').click()`); await pause(); };
  try {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='EDIT').click();
      window.wave=()=>document.querySelector('[aria-label="Edit waveform"]');
      window.props=()=>{let f=wave()[Object.keys(wave()).find(k=>k.startsWith('__reactFiber'))];while(f.return)f=f.return;const queue=[f.stateNode.current];while(queue.length){const n=queue.shift();if(n.memoizedProps?.onAutoSplit&&n.memoizedProps?.onSelectionChange)return n.memoizedProps;if(n.child)queue.push(n.child);if(n.sibling)queue.push(n.sibling);}};
      window.FileReader=class{readAsArrayBuffer(){this.result=new ArrayBuffer(8);this.onload();}};
      AudioContext.prototype.decodeAudioData=function(){const b=new AudioBuffer({length:48000*20,sampleRate:48000,numberOfChannels:2});for(let c=0;c<2;c++){b.getChannelData(c).fill(.1);b.getChannelData(c).fill(.001,48000*5,48000*7);}return Promise.resolve(b);};
      var input=document.querySelector('input[type=file]'),data=new DataTransfer();data.items.add(new File(['fixture'],'mode-review.wav'));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));void 0;`);
    await wait(`props().audioBuffer && !document.querySelector('main').inert && !document.body.textContent.includes('Building waveform')`);
    await pause();
    await click('Auto-Chop');
    await run(`['Noise floor','Minimum silence','Sensitivity'].forEach(label=>{const k=document.querySelector('[aria-label="'+label+'"]');k[Object.keys(k).find(x=>x.startsWith('__reactProps'))].onKeyDown({key:'ArrowDown',shiftKey:true,preventDefault(){}});});props().onAddMarker(4);props().onSelectionChange({start:14,end:15});void 0;`);
    await pause();
    const knobs = () => run(`['Noise floor','Minimum silence','Sensitivity'].map(label=>document.querySelector('[aria-label="'+label+'"]').getAttribute('aria-valuenow'))`);
    const detection = await knobs();
    const geometry = () => run(`['Edit waveform','Waveform overview','Waveform editing toolbar','Tools'].map(label=>(label==='Tools'?document.querySelector('[aria-label="Tools"]').parentElement:document.querySelector('[aria-label="'+label+'"]')).getBoundingClientRect().toJSON())`);
    const footprint = await geometry();
    await run(`window.source=props().audioBuffer;window.originalSamples=Array.from({length:source.numberOfChannels},(_,c)=>source.getChannelData(c).slice());void 0;`);
    const unchangedAudio = async () => assert.equal(await run(`props().audioBuffer===source && originalSamples.every((samples,c)=>samples.every((sample,i)=>sample===source.getChannelData(c)[i]))`), true, 'Switching does not process or replace source audio');
    const snapshot = () => run(`({markers:props().markers,selection:props().selection,time:props().currentTime,playing:props().isPlaying,undo:props().canUndo,markerUndo:props().canUndoMarkers})`);
    const mode = async selected => {
      const status = await run(`({buttons:['Chop','Auto-Chop','Volume'].map(label=>document.querySelector('[aria-label="'+label+'"]').getAttribute('aria-pressed')==='true'),auto:!!document.querySelector('[aria-label="Active tool controls"]'),volume:!document.querySelector('.volume-host').hidden,chop:wave().title.startsWith('Chop:'),cursor:getComputedStyle(wave()).cursor})`);
      assert.deepEqual(status.buttons, ['Chop','Auto-Chop','Volume'].map(label=>label===selected));
      assert.equal(status.auto, selected==='Auto-Chop');
      assert.equal(status.volume, selected==='Volume');
      assert.equal(status.chop, selected==='Chop');
      assert.notEqual(status.cursor, 'grabbing');
      if (selected==='Chop') assert.equal(status.cursor,'crosshair');
      else assert.notEqual(status.cursor,'crosshair');
      assert.deepEqual(await geometry(), footprint, 'Layout remains fixed');
    };
    const switchTo = async selected => { const before = await snapshot(); await click(selected); await mode(selected); assert.deepEqual(await snapshot(), before, 'Switch preserves markers, selection, position, playback and undo'); await unchangedAudio(); };
    await switchTo('Chop');
    win.webContents.debugger.attach('1.3');
    let pressed = false;
    const pointer = async (type, t) => {
      const r = await run('wave().getBoundingClientRect().toJSON()');
      if (type==='mousePressed') pressed=true;
      if (type==='mouseReleased') pressed=false;
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:r.left+r.width*t/20,y:r.top+r.height*.7,button:type==='mouseMoved'&&!pressed?'none':'left',buttons:pressed?1:0,clickCount:type==='mouseMoved'?0:1}); await pause();
    };
    const waveformClick = async t => { await pointer('mouseMoved',t); await pointer('mousePressed',t); await pointer('mouseReleased',t); };
    const drag = async (from,to) => { await pointer('mouseMoved',from); await pointer('mousePressed',from); await pointer('mouseMoved',to); await pointer('mouseReleased',to); };
    for (const [index, target] of ['Auto-Chop','Volume'].entries()) {
      await switchTo(target);
      const markers = await run('props().markers');
      await waveformClick(8);
      assert.deepEqual(await run('props().markers'),markers,'Normal click never creates a split in '+target);
      assert.equal(await run('props().selection'),null,'Normal click clears selection');
      assert.ok(Math.abs(await run('props().currentTime')-8)<.02,'Normal click positions transport');
      await drag(2,3);
      await wait('props().selection && props().selection.end-props().selection.start>.8');
      assert.deepEqual(await run('props().markers'),markers,'Normal selection never creates a split in '+target);
      if (await run('props().isPlaying')) await click('Pause');
      await switchTo('Chop');
      const selection = await run('props().selection');
      await waveformClick(9+index);
      await wait(`props().markers.length===${markers.length+1}`);
      assert.deepEqual(await run('props().selection'),selection,'Chop preserves existing selection');
      await unchangedAudio();
    }
    await switchTo('Auto-Chop'); assert.deepEqual(await knobs(),detection,'Detection settings survive all mode switches');
    await click('Auto-Chop'); await mode(null); // Closing a panel must never resurrect Chop.
    await switchTo('Volume'); await click('Volume'); await mode(null);
    await unchangedAudio(); assert.deepEqual(errors,[],'No renderer errors');
    console.log('PASS: Chop -> Auto-Chop / Volume restores normal clicks and native selection; explicit Chop return restores split creation; exclusive buttons/panels/cursor; splits, selection, settings, source audio and fixed layout preserved; no processing or renderer errors');
    app.exit(0);
  } catch (e) { console.error(e,errors); app.exit(1); }
});
