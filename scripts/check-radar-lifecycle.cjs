// Run with Vite running: electron scripts/check-radar-lifecycle.cjs [URL]
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
// Real React lifecycle/handlers; inspect the acquisition latch to count ping events.
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false,width:1200,height:800,webPreferences:{backgroundThrottling:false,offscreen:true}});
 const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(e) { console.error(code); throw e; } };
 const wait = async code => { const end=Date.now()+15000; while(!await run(code)) { if(Date.now()>end) throw Error(code); await new Promise(r=>setTimeout(r,30)); } };
 try {
  await win.loadURL(process.argv[2] || 'http://localhost:3000/?standby=1');
  await run(`
   window.wave=()=>[...document.querySelectorAll('canvas')].find(c=>c.title.includes('Click to clear') || c.title.includes('Double-click to add'));
   window.props=e=>e[Object.keys(e).find(k=>k.startsWith('__reactProps'))];
   window.component=()=>{ let f=wave()[Object.keys(wave()).find(k=>k.startsWith('__reactFiber'))]; while(f && f.type?.name!=='WaveformCanvas') f=f.return; return f; };
   window.importAudio=()=>{ const input=document.querySelector('input[type=file]'); const d=new DataTransfer();d.items.add(new File(['test'],'radar.wav'));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true})); };
   window.FileReader=class { readAsArrayBuffer(){ this.result=new ArrayBuffer(8);this.onload(); } };
   window.AudioContext=class { decodeAudioData(){const b=new AudioBuffer({length:48000*20,numberOfChannels:2,sampleRate:48000});for(let c=0;c<2;c++){const a=b.getChannelData(c);a.fill(.1);a.fill(.001,48000*5,48000*7);for(const t of [5.6,5.8,6,6.2])a.fill(.1,Math.round(48000*t),Math.round(48000*(t+.02)));a.fill(.001,48000*12,48000*14);}return Promise.resolve(b);}close(){return Promise.resolve();} };
   window.move=t=>{const c=wave(),r=c.getBoundingClientRect();props(c).onPointerMove({clientX:r.left+t/20*r.width,clientY:r.top+r.height/2});};
   window.detect=()=>document.querySelector('[aria-label="Detect Noise Floor"]');
   window.splitter=()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Splitter');
   window.readout=()=>document.querySelector('[aria-label="Waveform readouts"]');
   window.floorOutput=()=>document.querySelector('[aria-label="Noise floor in dB"]');
   window.closeSplitter=()=>document.querySelector('[aria-label="Close splitter"]');
   window.detectControls=()=>document.querySelectorAll('[aria-label="Detect Noise Floor"]');
   window.pings=0;window.radarTrace=[];void 0;
  `);
  await run('importAudio()');
  await wait('!!wave() && !document.querySelector("main").inert');
  await run(`let h=component().memoizedState;while(h){const v=h.memoizedState?.current;if(v?.constructor?.name==='QuietRadarAcquisition'){const update=v.update.bind(v);v.update=t=>{const acquired=update(t);if(acquired)pings++;radarTrace.push({runStart:t?.runStart??null,zone:t?.zone??null,acquired});return acquired;};break;}h=h.next;} void 0;`);
  await run('move(5.5)');assert.equal(await run('pings'),0);
  await run('component().memoizedProps.onSelectionChange({start:5.2,end:5.4})');
  await wait('readout().textContent.includes("0:05")');
  await run('detect().click()');
  await wait('readout().textContent.includes("-57.0")');
  await run('move(5.5);move(6.5)');assert.equal(await run('pings'),1,'closed Splitter acquires once');
  await run('radarTrace=[];[5.5,5.7,5.9,6.1,6.5,6.1,5.9,5.7,5.5].forEach(move)');
  const trace=await run('radarTrace');
  console.log('Fragmented quiet-area waveform transitions:',JSON.stringify(trace));
  assert.equal(new Set(trace.map(row=>row.runStart)).size,5,'actual handler selects five fine-grained runs');
  assert.equal(trace.filter(row=>row.acquired).length,0,'candidate switches retain existing acquisition');
  assert.equal(new Set(trace.map(row=>JSON.stringify(row.zone))).size,1,'all candidates share one envelope');
  assert.equal(await run('pings'),1,'fragmented area never repeats the ping');
  const before=await run('JSON.stringify(wave().getBoundingClientRect().toJSON())');
  await run('splitter().click()');await wait('splitter().getAttribute("aria-expanded")==="true"');
  assert.equal(await run('floorOutput().textContent'),'-57.0 dB');
  await run('move(6)');assert.equal(await run('pings'),1);
  await run('closeSplitter().click()');await wait('splitter().getAttribute("aria-expanded")==="false"');
  await run('move(6.2)');assert.equal(await run('pings'),1,'close preserves latch');
  assert.equal(await run('JSON.stringify(wave().getBoundingClientRect().toJSON())'),before,'stable waveform geometry');
  await run('move(9);move(6);move(12.5)');assert.equal(await run('pings'),3,'loss/reentry/distinct target');
  await run('importAudio()');await wait('!document.querySelector("main").inert && !document.querySelector("[role=status]") && readout().textContent.includes("-45.0")');
  await run('move(6)');assert.equal(await run('pings'),3,'new recording requires detection');
  assert.equal(await run('detectControls().length'),1);
  await run('component().memoizedProps.onSelectionChange({start:12.2,end:13.8})');
  await wait('readout().textContent.includes("0:12")');
  await run('detect().click()');await wait('readout().textContent.includes("-57.0")');
  await run('move(12.5)');assert.equal(await run('pings'),4,'same target in new audio acquires afresh');
  await new Promise(resolve => setTimeout(resolve, 300));
  await win.webContents.capturePage().then(image=>require('fs').writeFileSync(require('path').join(app.getPath('temp'), 'splitterator-radar-review.png'),image.toPNG()));
  console.log('PASS: independent detection, panel toggles, acquisition pings, new audio reset, shared Splitter threshold, stable geometry');app.exit(0);
 } catch(e){console.error(e);app.exit(1);}
});
