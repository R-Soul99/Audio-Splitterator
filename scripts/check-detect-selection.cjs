// Run after npm run build: npx electron scripts/check-detect-selection.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
app.setPath('userData', path.join(__dirname, '../build/detect-selection-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false,width:980,height:650,webPreferences:{backgroundThrottling:false}});
  const run = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve,80));
  const wait = async code => { const deadline=Date.now()+20000; while(!await run(code)) {if(Date.now()>deadline) throw Error(code);await pause();} };
  try {
    await win.loadFile(path.join(__dirname,'../dist/index.html'));
    await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='EDIT').click()`);await pause();
    await run(`window.props=e=>e[Object.keys(e).find(k=>k.startsWith('__reactProps'))];
      window.wave=()=>document.querySelector('[aria-label="Edit waveform"]');
      window.component=()=>{let f=wave()[Object.keys(wave()).find(k=>k.startsWith('__reactFiber'))];while(f&&!f.memoizedProps?.onSelectionChange) f=f.return;return f;};
      window.knob=()=>document.querySelector('[aria-label="Minimum silence"]');
      window.gap=()=>Number(knob().getAttribute('aria-valuenow'));
      window.select=(start,end)=>component().memoizedProps.onSelectionChange({start,end});
      window.detect=()=>document.querySelector('[aria-label="Detect noise floor"]');
      window.labels=[]; window.dots=[];
      const text=CanvasRenderingContext2D.prototype.fillText, move=CanvasRenderingContext2D.prototype.moveTo;
      CanvasRenderingContext2D.prototype.fillText=function(t,x,y,...args){if(t==='0 dBFS') labels.push({x,y,baseline:this.textBaseline});return text.call(this,t,x,y,...args);};
      CanvasRenderingContext2D.prototype.moveTo=function(x,y){if(this.canvas.getAttribute('aria-label')==='Waveform indicators'&&y===2)dots.push(x);return move.call(this,x,y);};
      window.FileReader=class{readAsArrayBuffer(){this.result=new ArrayBuffer(8);this.onload();}};
      AudioContext.prototype.decodeAudioData=()=>{const b=new AudioBuffer({length:48000*20,sampleRate:48000,numberOfChannels:2});for(let c=0;c<2;c++){const a=b.getChannelData(c);a.fill(.03);for(const [s,e] of [[2.8,4.2],[6,6.8],[12,12.8]])a.fill(.00065,Math.round(s*48000),Math.round(e*48000));}return Promise.resolve(b);};
      const input=document.querySelector('input[type=file]'),data=new DataTransfer();data.items.add(new File(['audio'],'short-gaps.wav'));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));`);
    await wait(`!document.querySelector('main').inert&&!document.body.textContent.includes('Building waveform')&&!document.querySelector('[aria-label="Chop"]').disabled`);
    await run(`document.querySelector('[aria-label="Auto-Chop"]').click()`);await pause();
    assert.equal(await run('gap()'),1);
    await run('detect().click()');await pause();assert.equal(await run('gap()'),1,'missing selection leaves Gap unchanged');
    await run('select(6.2,6.5)');await pause();await run('detect().click()');
    await wait(`!detect().disabled&&Math.abs(gap()-.3)<1e-8`);
    await wait(`document.querySelector('.detection-counts strong').textContent==='2'`);
    await wait('dots.length>0&&labels.length>0');
    assert.ok(await run(`labels.every(l=>l.baseline==='bottom'&&l.y-10>8)`),'labels clear the detection-dot band');
    // Gap remains editable, and ordinary selection changes do not overwrite it.
    await run(`props(knob()).onKeyDown({key:'ArrowUp',preventDefault(){}})`);await pause();
    assert.ok(Math.abs(await run('gap()')-.4)<1e-8);
    await run('select(6.5,6.2)');await pause();assert.ok(Math.abs(await run('gap()')-.4)<1e-8);
    await run(`document.querySelector('[aria-label="Detect noise floor in Auto-Chop"]').click()`);
    await wait(`!detect().disabled&&Math.abs(gap()-.3)<1e-8`);
    // Both detection entry points seed the same duration, bounded by the knob limits.
    await run('select(6.2,6.23)');await pause();await run('detect().click()');await wait(`!detect().disabled&&gap()===.1`);
    await run('select(0,12)');await pause();await run('detect().click()');await wait(`!detect().disabled&&gap()===10`);
    await run('select(6.2,6.5)');await pause();await run('detect().click()');await wait(`!detect().disabled&&Math.abs(gap()-.3)<1e-8`);
    await wait(`document.querySelector('.detection-counts strong').textContent==='2'`);
    await run(`document.querySelector('button.pointer-events-auto')?.click()`); await pause();
    // Flush the hidden window's compositor before saving the final preview.
    await win.webContents.capturePage(); await pause(); await pause();
    fs.mkdirSync(path.join(__dirname,'../build'),{recursive:true});
    fs.writeFileSync(path.join(__dirname,'../build/detect-selection.png'),(await win.webContents.capturePage()).toPNG());
    console.log('PASS Detect seeds Gap, reversed selection, duration limits, manual edits, short-gap prediction/dots and label clearance');
    win.destroy();app.quit();
  } catch(error) {console.error(error);win.destroy();app.exit(1);}
});
