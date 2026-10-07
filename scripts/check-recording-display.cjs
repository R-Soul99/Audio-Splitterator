// Controlled stereo input through real recording handlers; physical permission denied.
// After npm run build: electron scripts/check-recording-display.cjs file:///.../dist/index.html
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const profile = path.join(__dirname, '../build/recording-regression-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  const run = async code => { try{return await win.webContents.executeJavaScript(code);}catch(error){console.error('Failed renderer check:',code);throw error;} };
  const wait = async code => {
    const deadline = Date.now() + 15000;
    while (!await run(code)) {
      if (Date.now() > deadline) throw Error(code);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  try {
    win.webContents.debugger.attach('1.3');
    for (const scenario of ['direct', 'resume', 'paused', 'retry', 'load-retry']) {
      await win.loadURL(process.argv[2] || 'http://localhost:3000/?standby=1');
      await run(`localStorage.setItem('audiophonic_preview_standby','true'); localStorage.setItem('monitoringAudioOutput','true'); localStorage.setItem('monitorVolume','1')`);
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload();});
      await wait(`!!document.querySelector('[aria-label="Wake audio engine"]')`);
      await run(`
        window.processors=[];window.analysers=0;window.traceCount=0;window.finalBuffer=null;window.audioNodes=[];window.stoppedTracks=0;window.contexts=[];
        navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){stoppedTracks++}}]});
        navigator.mediaDevices.enumerateDevices=async()=>[];
        const node=(kind='other')=>{const value={kind,connections:[],connect(target){this.connections.push(target);},disconnect(){this.connections=[];},gain:{value:1,setValueAtTime(){}}};audioNodes.push(value);return value;};
        window.AudioContext=class {
          constructor(options={}){contexts.push(this);this.sampleRate=options.sampleRate||48000;this.state='running';this.currentTime=0;this.destination=node('destination');}
          resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
          createMediaStreamSource(){return node();}createGain(){return node('gain');}createChannelSplitter(){return node();}
          createAnalyser(){const value=analysers++%2===0?.25:-.5;return {...node(),fftSize:1024,getFloatTimeDomainData(array){array.fill(value);}};}
          createScriptProcessor(size){const processor={...node('processor'),size};processors.push(processor);return processor;}
          createBuffer(channels,length,sampleRate){finalBuffer=new AudioBuffer({numberOfChannels:channels,length,sampleRate});return finalBuffer;}
        };
        const fill=CanvasRenderingContext2D.prototype.fillRect,stroke=CanvasRenderingContext2D.prototype.stroke;
        CanvasRenderingContext2D.prototype.fillRect=function(...args){if(this.canvas.getAttribute('aria-label')==='Combined recording waveform'&&args[0]===0&&args[1]===0)traceCount=0;return fill.apply(this,args);};
        CanvasRenderingContext2D.prototype.stroke=function(...args){if(this.canvas.getAttribute('aria-label')==='Combined recording waveform'&&this.lineWidth===2)traceCount++;return stroke.apply(this,args);};
        document.querySelector('[aria-label="Wake audio engine"]').click();
      `);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      await wait('analysers>=2');
      await wait(`document.querySelector('[aria-label="Start recording"]').getBoundingClientRect().width<136`);
      await run(`
        window.geometry=()=>{
          const rect=element=>{const r=element.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
          const panel=title=>[...document.querySelectorAll('span')].find(e=>e.textContent===title).parentElement;
          const waveform=document.querySelector('[aria-label="Combined recording waveform"]');
          const meters=panel('Level Meters').parentElement;
          const transport=document.querySelector('[aria-label="Recording controls"]');
          const controls=panel('Controls');
          const preamp=document.querySelector('[title="Preamp boost gain (drag up / down)"]');
          return {waveform:rect(waveform),meters:rect(meters),transport:rect(transport),
            button:rect(transport.querySelector('button')),
            led:rect(transport.querySelector('[role="img"]')),
            stopGroup:rect(transport.querySelectorAll('button')[1].parentElement),
            controls:rect(controls),
            scope:rect(panel('Oscilloscope')),
            preamp:rect(preamp),
            preampSection:rect(preamp.parentElement.parentElement),
            vus:[...document.querySelectorAll('svg[aria-label$="level meter"]')].map(rect),
            overflow:[document.documentElement.scrollWidth>innerWidth,document.documentElement.scrollHeight>innerHeight],
            clipped:[...controls.querySelectorAll('button,select,output')].some(b=>{const r=b.getBoundingClientRect(),c=controls.getBoundingClientRect();return r.bottom>c.bottom||r.top<c.top||r.left<c.left||r.right>c.right;})};
        };
        window.elapsed=()=>document.querySelector('[aria-label="Combined recording waveform"]').parentElement.nextElementSibling.children[0].children[1].textContent;
        window.feed=(leftValue,rightValue)=>{ const output=[new Float32Array(4096).fill(1),new Float32Array(4096).fill(1)]; processors.find(processor=>processor.size===4096).onaudioprocess({
          inputBuffer:{numberOfChannels:2,getChannelData:channel=>new Float32Array(4096).fill(channel?rightValue:leftValue)},
          outputBuffer:{numberOfChannels:2,getChannelData:channel=>output[channel]}
        }); if(output.some(channel=>channel.some(value=>value!==0))) throw Error('Recording output must be silent'); };
        void 0;
      `);

      // Wake removes the existing Standby banner; wait for its resize observation.
      await new Promise(resolve=>setTimeout(resolve,150));
      const ready=await run('geometry()');
      assert.deepEqual(ready.overflow,[false,false]); assert.equal(ready.clipped,false);
      const capture=async state=>{await win.webContents.capturePage();await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(app.getPath('temp'),`splitterator-record-${state}.png`),(await win.webContents.capturePage()).toPNG());};
      const nav=async()=>{
        await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='EDIT').click()`);
        assert.equal(await run(`document.querySelector('[aria-label="Recording controls"]').getBoundingClientRect().width`),0);
        await run('feed(.25,-.5)');
        await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='RECORD').click()`);
        await wait(`document.querySelector('[aria-label="Recording controls"]').getBoundingClientRect().width>0`);
        assert.deepEqual(await run('geometry()'),ready,'navigation restores exact layout');
      };
      assert.equal(await run(`document.querySelector('[aria-label="Pause recording"]').disabled`),true);
      assert.equal(await run(`document.querySelector('[aria-label="Start recording"]').querySelector('svg')===null`),true,'idle record circle');
      assert.ok(ready.button[2]>ready.preamp[2],'main control remains larger than Preamp');
      assert.ok(ready.stopGroup[1]>ready.button[1]+ready.button[3],'small control remains underneath');
      assert.ok(ready.vus.every(v=>Math.abs(v[2]/v[3]-440/246)<.001),'VU proportions retained');
      assert.equal(await run(`audioNodes.filter(n=>n.connections.includes(contexts[0]?.destination)).every(n=>n.kind==='processor')`),true,'software monitoring remains off');
      await capture('ready');
      await run(`document.querySelector('[aria-label="Start recording"]').click();document.querySelector('[aria-label="Starting recording"]')?.click()`);
      await wait(`!!document.querySelector('[aria-label="Stop recording"]')`);
      assert.equal(await run('processors.filter(p=>p.size===4096).length'),1,'one capture source');
      await run('feed(.25,-.5)');
      await wait('traceCount===1');
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyM',key:'m',bubbles:true}))`);
      assert.equal(await run(`document.querySelector('[aria-label="Add recording marker"]').textContent.includes('(1)')`),true);
      assert.equal(await run(`document.querySelector('[aria-label="Stop recording"] svg').classList.contains('lucide-square')`),true);
      assert.equal(await run(`!!document.querySelector('[aria-label="Recording indicator on"]')`),true);
      assert.deepEqual(await run('geometry()'),ready);
      await capture('recording');
      await nav();
      assert.equal(await run(`!!document.querySelector('[aria-label="Recording indicator on"]')`),true);
      if(scenario!=='direct') {
        await run(`document.querySelector('[aria-label="Pause recording"]').click()`);
        await wait(`!!document.querySelector('[aria-label="Resume recording"]')`);
        const frozen=await run('elapsed()');
        await run('feed(1,1)');
        await new Promise(r=>setTimeout(r,120));
        assert.equal(await run('elapsed()'),frozen);
        assert.equal(await run(`getComputedStyle(document.querySelector('.recording-paused-icon')).animationDuration`),'1s');
        assert.equal(await run(`document.querySelector('[aria-label="Resume recording"]').nextElementSibling.getAnimations().length`),0);
        await nav();
        assert.equal(await run('elapsed()'),frozen,'pause time survives navigation');
        assert.equal(await run(`!!document.querySelector('[aria-label="Resume recording"]')`),true);
        await capture('paused');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        assert.equal(await run(`getComputedStyle(document.querySelector('.recording-paused-icon')).animationName`),'none');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
        if(scenario==='resume') {
          await run(`document.querySelector('[aria-label="Resume recording"]').focus()`);
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
          await wait(`!!document.querySelector('[aria-label="Pause recording"]')`);
          assert.equal(await run(`!!document.querySelector('.recording-paused-icon,.recording-paused-led')`),false);
          await run('feed(.75,.5)');
        }
      }
      if(scenario==='retry' || scenario==='load-retry') {
        await run(`window.originalCreate=AudioContext.prototype.createBuffer;AudioContext.prototype.createBuffer=function(...args){${scenario==='retry'?"throw Error('Injected allocation failure')":"const b=originalCreate.apply(this,args);Object.defineProperty(b,'duration',{get(){throw Error('Injected Edit loading failure')}});return b"}};document.querySelector('[aria-label="Stop recording"]').click()`);
        await wait(`!!document.querySelector('[role="alert"]')`);
        assert.equal(await run(`document.querySelector('[role="alert"]').textContent.includes('Take retained')`),true);
        assert.equal(await run(`!!document.querySelector('[aria-label="Resume recording"]')`),true);
        await nav();
        await run('AudioContext.prototype.createBuffer=originalCreate;finalBuffer=null;void 0');
        if(scenario==='retry') {
          await run(`document.querySelector('[aria-label="Resume recording"]').click()`);
          await wait(`!!document.querySelector('[aria-label="Pause recording"]')`);
          await run('feed(.75,.5)');
          await run(`document.querySelector('[aria-label="Pause recording"]').click()`);
        }
      }
      await run(`window.busyChecks=[];window.busyObserver=new MutationObserver(()=>{const b=document.querySelector('[aria-label="Finalising recording"]');if(b)busyChecks.push({disabled:b.disabled,pause:document.querySelector('[aria-label="Recording controls"]').querySelectorAll('button')[1].disabled,blink:!!document.querySelector('.recording-paused-icon,.recording-paused-led'),geometry:geometry()})});busyObserver.observe(document.querySelector('[aria-label="Recording controls"]'),{attributes:true,childList:true,subtree:true});window.createCount=0;window.originalFinal=AudioContext.prototype.createBuffer;AudioContext.prototype.createBuffer=function(...a){createCount++;return originalFinal.apply(this,a)};const b=document.querySelector('[aria-label="Stop recording"]');b.click();b.click();b.click();`);
      await wait('finalBuffer!==null');
      await wait(`!!document.querySelector('[aria-label="Start recording"]')`);
      const busy=await run('busyChecks');assert.ok(busy.length>0,'busy state is rendered');for(const state of busy){assert.equal(state.disabled,true);assert.equal(state.pause,true);assert.equal(state.blink,false);assert.deepEqual(state.geometry,ready,'busy layout stable');}
      assert.equal(await run('createCount'),1,'repeated stop finalises once');
      assert.equal(await run(`document.querySelector('[aria-label="Recording controls"]').getBoundingClientRect().width`),0,'success switches to Edit');
      const resumed=scenario==='resume'||scenario==='retry';
      const expected=resumed?12288:8192;
      assert.deepEqual(await run(`({length:finalBuffer.length,channels:finalBuffer.numberOfChannels,rate:finalBuffer.sampleRate,first:[finalBuffer.getChannelData(0)[0],finalBuffer.getChannelData(1)[0]],last:[finalBuffer.getChannelData(0)[finalBuffer.length-1],finalBuffer.getChannelData(1)[finalBuffer.length-1]]})`),{length:expected,channels:2,rate:44100,first:[.25,-.5],last:resumed?[.75,.5]:[.25,-.5]},'exact uninterrupted PCM without paused silence');
      assert.equal(await run('processors.find(p=>p.size===4096).onaudioprocess'),null,'capture released');
      assert.equal(await run(`contexts.every(c=>c.state==='closed') && stoppedTracks>0`),true,'capture resources released after success');
      assert.equal(await run(`!!document.querySelector('.recording-paused-icon,.recording-paused-led')`),false);
      await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='RECORD').click()`);
      await wait(`document.querySelector('[aria-label="Start recording"]').getBoundingClientRect().width>0`);
      assert.deepEqual(await run('geometry()'),ready);
      assert.equal(await run('elapsed()'),'0:00.000','successful take resets idle readout');
      assert.equal(await run(`document.querySelector('[aria-label="Add recording marker"]').textContent.includes('(1)')`),false);
      console.log('PASS recording lifecycle:',scenario);
    }
    win.destroy();app.exit(0);
  } catch(error){console.error(error);win.destroy();app.exit(1);}
});
