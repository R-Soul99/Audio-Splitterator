// Fixed-size display styling, alignment, real metering and screenshot review.
// Run after npm run build: electron scripts/check-tool-display.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const build = path.join(__dirname, '../build');
app.setPath('userData', path.join(build, 'tool-display-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, autoHideMenuBar: true, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code).catch(e=>{console.error(code);throw e;});
  const pause = (ms=100) => new Promise(resolve=>setTimeout(resolve,ms));
  const wait = async code => { const end=Date.now()+20000; while (!await run(code)) { if(Date.now()>end)throw Error(code);await pause(30); } };
  const click = async label => { await run(`(document.querySelector('[aria-label="${label}"]')||[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${label}')).click()`);await pause(); };
  const shot = async name => { await pause(200);await win.webContents.capturePage();await pause(100);fs.writeFileSync(path.join(build,`tool-display-${name}.png`),(await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadFile(path.join(__dirname,'../dist/index.html'));await click('EDIT');
    await run(`window.wave=()=>document.querySelector('[aria-label="Edit waveform"]');window.props=()=>{let f=wave()[Object.keys(wave()).find(k=>k.startsWith('__reactFiber'))];while(f.return)f=f.return;const q=[f.stateNode.current];while(q.length){const n=q.shift();if(n.memoizedProps?.onAutoSplit&&n.memoizedProps?.onSelectionChange)return n.memoizedProps;if(n.child)q.push(n.child);if(n.sibling)q.push(n.sibling);}};
      window.rect=e=>e.getBoundingClientRect().toJSON();window.footprint=()=>['Edit waveform','Waveform overview','Waveform editing toolbar'].map(label=>rect(document.querySelector('[aria-label="'+label+'"]'))).concat(rect(document.querySelector('.tool-display')));void 0;`);
    const footprint=await run('footprint()');
    const fit = async () => {
      assert.deepEqual(await run('footprint()'),footprint,'Display and waveform footprint never moves');
      assert.equal(await run(`document.querySelector('[aria-label="Waveform editing toolbar"]').textContent.includes('Transport')||document.querySelector('[aria-label="Waveform editing toolbar"]').textContent.includes('Selection')||document.querySelector('[aria-label="Waveform editing toolbar"]').textContent.includes('View')`),false,'Section headings removed');
      assert.equal(await run(`!!document.querySelector('.tools-selector-row')`),false,'Internal title row removed');
      assert.equal(await run(`document.querySelector('.tool-display').previousElementSibling.textContent.trim()`),'Tools','Permanent chassis label');
      assert.equal(await run(`!!document.querySelector('[aria-label="Play the selected region once"]')`),false);
      assert.equal(await run(`[...document.querySelector('[aria-label="Waveform editing toolbar"]').querySelectorAll('button')].every(b=>rect(b).width===24&&rect(b).height===24)`),true,'All icon buttons use compact Transport size');
      const bad = await run(`(()=>{const host=document.querySelector('.tools-panel'),r=host.getBoundingClientRect();return [...host.querySelectorAll('button,input,output,h3,p,[role=slider],[role=meter]')].filter(e=>e.getClientRects().length).filter(e=>{const b=e.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1||b.top<r.top-1||b.bottom>r.bottom+1;}).map(e=>e.outerHTML.slice(0,100));})()`);
      assert.deepEqual(bad,[],'Display controls, text and readouts fit');
      assert.equal(await run(`(()=>{const host=rect(document.querySelector('.tools-panel'));return [...document.querySelectorAll('.volume-section h3,.detection-section h3')].filter(e=>e.getClientRects().length).every(e=>rect(e).top-host.top<=3);})()`),true,'Section titles sit at the top');
      const colors = await run(`(()=>{const green=v=>{const n=v.match(/[0-9.]+/g)?.map(Number);return !n||n[3]===0||(n[0]===0&&n[1]===0&&n[2]===0)||(n[1]>n[0]&&n[1]>n[2]);};return [...document.querySelectorAll('.tools-panel *')].filter(e=>e.getClientRects().length).filter(e=>{const s=getComputedStyle(e);return ![s.color,s.backgroundColor,s.borderTopColor,s.outlineColor].every(green);}).map(e=>({tag:e.tagName,class:e.className}));})()`);
      assert.deepEqual(colors,[],'All visible display graphics are monochrome green or black');
      assert.equal(await run(`getComputedStyle(document.querySelector('.tool-display')).backgroundColor`),'rgb(0, 0, 0)');
      assert.equal(await run('document.documentElement.scrollHeight>innerHeight'),false);
    };
    const spacing = async labels => {
      const measurements=await run(`(${JSON.stringify(labels)}).map(label=>{const k=document.querySelector('[aria-label="'+label+'"]'),hit=rect(k),face=getComputedStyle(k,'::before'),read=rect(k.closest('.volume-parameter')?.querySelector('.volume-digital')||k.parentElement.nextElementSibling);return {label,hit:hit.width,diameter:parseFloat(face.width),gap:read.top-(hit.top+parseFloat(getComputedStyle(k).borderTopWidth)+parseFloat(face.top)+parseFloat(face.height)),readoutTop:read.top};})`);
      for(const m of measurements){assert.equal(m.hit,m.label==='Normalise target peak'?32:24,'Interactive area preserved');assert.equal(m.diameter,m.hit===32?26:20,'Visible circle reduced');assert.ok(Math.abs(m.gap-8)<.2,'Eight pixel visible-edge/readout gap: '+JSON.stringify(m));}
      assert.ok(measurements.every(m=>m.readoutTop===measurements[0].readoutTop),'Readouts share a baseline');
      console.log('Knob spacing',JSON.stringify(measurements));
    };
    await click('Auto-Chop');await spacing(['Noise floor','Minimum silence']);await fit();await shot('auto-chop-empty');
    assert.equal(await run(`document.querySelector('.detection-apply').disabled`),true);
    await click('Volume');await fit();await shot('volume-empty');
    assert.equal(await run(`document.querySelector('.volume-primary').disabled`),true);
    assert.equal(await run(`getComputedStyle(document.querySelector('.volume-primary')).opacity`),'0.35');
    await run(`window.FileReader=class{readAsArrayBuffer(){this.result=new ArrayBuffer(8);this.onload();}};AudioContext.prototype.decodeAudioData=function(){const b=new AudioBuffer({length:48000*20,sampleRate:48000,numberOfChannels:2});for(let c=0;c<2;c++){const a=b.getChannelData(c);for(let i=0;i<a.length;i++){const t=i/48000,quiet=t>=5&&t<7||t>=12&&t<14;a[i]=quiet?.001:(c?.9:.25)*Math.sin(2*Math.PI*220*t);}}return Promise.resolve(b);};var input=document.querySelector('input[type=file]'),data=new DataTransfer();data.items.add(new File(['fixture'],'display-review.wav'));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));void 0;`);
    await wait(`props().audioBuffer&&!document.querySelector('main').inert&&!document.body.textContent.includes('Building waveform')`);await pause(400);
    await click('Chop');await fit();
    assert.deepEqual(await run(`[...document.querySelector('[aria-label="Chop guidance"]').children].map(e=>e.textContent)`),[
      'CHOP MODE',
      'Select a quiet section, then click the ear button to detect the noise floor.',
      'Adjust Sensitivity to control snapping to detected split points.',
      'Left-click to add a split; right-click a split to remove it.',
      'Choose another mode or press Esc to leave Chop mode.'
    ]);
    await shot('chop');
    // Escape leaves Chop without editing; typing fields keep their own Escape behaviour.
    const original=await run('({markers:props().markers,selection:props().selection,buffer:props().audioBuffer.length})');
    await run(`document.querySelector('input:not([type=file])').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0;`);
    assert.equal(await run(`document.querySelector('[aria-label="Chop"]').getAttribute('aria-pressed')`),'true');
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));void 0;`);await pause();
    assert.equal(await run(`document.querySelector('[aria-label="Chop"]').getAttribute('aria-pressed')`),'false');
    assert.deepEqual(await run('({markers:props().markers,selection:props().selection,buffer:props().audioBuffer.length})'),original);
    await click('Auto-Chop');
    win.webContents.debugger.attach('1.3');let pressed=false;
    const pointer=async(type,t)=>{const r=await run('rect(wave())');if(type==='mousePressed')pressed=true;if(type==='mouseReleased')pressed=false;await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:r.left+r.width*t/20,y:r.top+r.height*.7,button:type==='mouseMoved'&&!pressed?'none':'left',buttons:pressed?1:0,clickCount:type==='mouseMoved'?0:1});await pause(60);};
    await pointer('mouseMoved',5.2);await pointer('mousePressed',5.2);await pointer('mouseMoved',5.9);await pointer('mouseReleased',5.9);
    await wait('props().selection&&props().selection.end-props().selection.start>.5');
    await click('Detect noise floor');await wait(`document.querySelector('[aria-label="Noise floor in dB"]').textContent==='-57.0 dB'`);
    const edgeDrag = async (label,fine) => {
      const r=await run(`rect(document.querySelector('[aria-label="${label}"]'))`),before=Number(await run(`document.querySelector('[aria-label="${label}"]').getAttribute('aria-valuenow')`));
      const send=async(type,y)=>{await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:r.left+1,y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1,modifiers:fine?8:0});await pause(60);};
      // The transparent margin outside the smaller circle must still start a drag.
      await send('mousePressed',r.top+r.height/2);await send('mouseMoved',r.top+r.height/2-20);await send('mouseReleased',r.top+r.height/2-20);
      const after=Number(await run(`document.querySelector('[aria-label="${label}"]').getAttribute('aria-valuenow')`));assert.ok(after>before,'Margin hit and drag work: '+label);if(fine)assert.ok(after-before<=(label==='Noise floor'?1.7:label==='Minimum silence'?.18:.11),'Shift fine control retained');
    };
    await fit();await shot('auto-chop');
    await edgeDrag('Noise floor',true);await edgeDrag('Minimum silence',true);await spacing(['Noise floor','Minimum silence']);
    const centered = await run(`(()=>{const r=e=>rect(e);return [r(document.querySelector('.detection-detect')),r(document.querySelector('[aria-label="Noise floor"]')),r(document.querySelector('[aria-label="Minimum silence"]')),r(document.querySelector('.detection-apply'))].map(b=>b.y+b.height/2);})()`);
    assert.ok(centered.every(y=>Math.abs(y-centered[0])<1),'Auto-Chop buttons and knobs share a control centre');
    await run(`var k=document.querySelector('[aria-label="Noise floor"]');k[Object.keys(k).find(x=>x.startsWith('__reactProps'))].onKeyDown({key:'Home',preventDefault(){}});var g=document.querySelector('[aria-label="Minimum silence"]');g[Object.keys(g).find(x=>x.startsWith('__reactProps'))].onKeyDown({key:'End',preventDefault(){}});void 0;`);
    await pause();await fit();await shot('auto-chop-limits');
    await click('Volume');await fit();
    assert.equal(await run(`document.querySelector('.volume-detect .volume-button').title`),'Detect noise level.');
    assert.equal(await run(`document.querySelector('.volume-meter-unit').textContent`),'');
    const reference=await run(`[...document.querySelectorAll('[role=meter]')].map(m=>{const z=m.querySelector('.volume-zero-reference'),last=m.querySelector('i[data-db="0"]');return {left:rect(z).left,right:rect(z).right,targetLeft:rect(last).left,targetRight:rect(last).right,label:z.textContent,height:rect(z).height};})`);
    for(const z of reference){assert.ok(Math.abs(z.left-z.targetLeft)<.1);assert.ok(Math.abs(z.right-z.targetRight)<.1);assert.equal(z.height,1);assert.equal(z.label,'0 dB');}
    await spacing(['Normalise target peak']);await edgeDrag('Normalise target peak',true);
    const alignment=await run(`(()=>{const r=e=>rect(e),center=e=>{const b=r(e);return b.y+b.height/2;};return {headings:[...document.querySelectorAll('.volume-section h3')].slice(0,3).map(e=>r(e).y),buttons:[r(document.querySelector('.volume-detect .volume-button')),r(document.querySelector('.volume-normalise .volume-button'))],controls:[center(document.querySelector('.volume-flip')),center(document.querySelector('[aria-label="Normalise target peak"]'))],meters:[...document.querySelectorAll('.volume-meter-row')].map(center)};})()`);
    assert.ok(alignment.headings.every(y=>Math.abs(y-alignment.headings[0])<1),'Volume headings aligned');
    assert.equal(alignment.buttons[0].width,alignment.buttons[1].width);assert.equal(alignment.buttons[0].height,alignment.buttons[1].height);assert.equal(alignment.buttons[0].y,alignment.buttons[1].y);
    assert.ok(Math.abs(alignment.controls[0]-alignment.controls[1])<1);assert.ok(Math.abs((alignment.meters[0]+alignment.meters[1])/2-alignment.controls[0])<1);
    await click('Detect');await wait(`!document.querySelector('.volume-detect .volume-button').disabled`);await fit();
    assert.deepEqual(await run(`[rect(document.querySelector('.volume-detect .volume-button')),rect(document.querySelector('.volume-normalise .volume-button'))]`),alignment.buttons,'Peak readout never moves buttons');
    await click('Clear selection');await click('Return to start');await click('Play');await wait('props().playbackPeakMeter.levels.held[1]>.85');await fit();await shot('volume');
    await click('Pause');await click('Left held sample peak; reset held peaks');
    assert.deepEqual(await run('props().playbackPeakMeter.levels.held'),[0,0]);await fit();await shot('volume-reset');
    await run('props().onSelectionChange({start:5.2,end:5.9})');await pause();
    await click('Selection / All range');assert.equal(await run(`document.querySelector('[aria-label="Selection / All range"]').getAttribute('aria-checked')`),'false');await fit();await shot('volume-selection');
    await click('Detect');await wait(`!document.querySelector('.volume-detect .volume-button').disabled`);
    await run(`var meter=props().playbackPeakMeter;cancelAnimationFrame(meter.raf);meter.raf=0;meter.levels={live:[1,2],held:[1,2]};meter.emit();void 0;`);await pause();await fit();
    assert.equal(await run(`[...document.querySelectorAll('[role=meter]')].every(m=>m.getAttribute('aria-valuenow')==='0'&&getComputedStyle(m.querySelector('.volume-zero-reference')).zIndex==='1'&&m.querySelector('i[data-db="0"]').classList.contains('lit'))`),true,'Zero reference remains over lit/over-range meter');
    // Inject extreme held levels only into the meter fixture; audio remains unchanged.
    await run(`var meter=props().playbackPeakMeter;meter.levels={live:[0,0],held:[1e-6,1e-45]};meter.emit();void 0;`);await pause();
    assert.equal(await run(`[...document.querySelectorAll('.volume-peak-readout')].every(e=>e.scrollWidth<=e.clientWidth)`),true,'Six-character peak readouts fit');
    // Stress long display strings without mutating audio, selection or processing state.
    await run(`var status=document.querySelector('.volume-status');status.textContent='Reduced 123456789 sample frames; normalised to -6.0 dBFS.';status.title=status.textContent;void 0;`);
    await fit();await shot('volume-long-readouts');
    assert.deepEqual(errors,[],'No renderer errors');
    console.log('PASS: monochrome green display; fixed geometry and unclipped empty/loaded modes; exact Chop guidance and Escape; aligned Volume headings/buttons/control/readout rows; aligned Auto-Chop controls; quiet selection/Detect; genuine playback meters/reset and All/Selection; limits and long readouts. Screenshots: build/tool-display-{chop,auto-chop,volume}.png');app.exit(0);
  } catch(e) { console.error(e,errors);try{await shot('failure');}catch{}app.exit(1); }
});
