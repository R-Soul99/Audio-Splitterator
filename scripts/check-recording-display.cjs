// Controlled stereo input through real recording handlers; no physical device needed.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
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
    for (const stopWhilePaused of [false, true]) {
      await win.loadURL(process.argv[2] || 'http://localhost:3000/?standby=1');
      await run(`localStorage.setItem('audiophonic_preview_standby','true'); localStorage.setItem('monitoringAudioOutput','true'); localStorage.setItem('monitorVolume','1')`);
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload();});
      await wait(`!!document.querySelector('[aria-label="Wake audio engine"]')`);
      await run(`
        window.processors=[];window.analysers=0;window.traceCount=0;window.finalBuffer=null;window.audioNodes=[];
        navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){}}]});
        navigator.mediaDevices.enumerateDevices=async()=>[];
        const node=(kind='other')=>{const value={kind,connections:[],connect(target){this.connections.push(target);},disconnect(){this.connections=[];},gain:{value:1,setValueAtTime(){}}};audioNodes.push(value);return value;};
        window.AudioContext=class {
          constructor(options={}){this.sampleRate=options.sampleRate||48000;this.state='running';this.currentTime=0;this.destination=node('destination');}
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
            stopGroup:rect(transport.querySelector('[aria-label="Stop recording"]').parentElement),
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
      const capture=async state=>{ await win.webContents.capturePage(); await new Promise(resolve=>setTimeout(resolve,80)); await win.webContents.capturePage().then(image=>require('fs').writeFileSync(require('path').join(app.getPath('temp'),`splitterator-transport-${state}.png`),image.toPNG())); };
      const readyGeometry=await run('geometry()');
      await capture('ready');
      assert.equal(await run(`!!document.querySelector('.recording-paused-button')`),false,'Ready has no paused animation');
      assert.equal(await run(`document.querySelector('[aria-label="Stop recording"]').disabled`),true);
      assert.ok(Math.abs(readyGeometry.meters[0]-(readyGeometry.waveform[0]-17*(readyGeometry.button[2]/136)))<1,'meter panel aligned with waveform panel');
      assert.ok(readyGeometry.transport[0]>readyGeometry.meters[0]);
      assert.deepEqual(readyGeometry.overflow,[false,false]);
      assert.equal(readyGeometry.clipped,false);
      assert.ok(readyGeometry.led[0]>=readyGeometry.controls[0] && readyGeometry.led[0]+readyGeometry.led[2]<=readyGeometry.controls[0]+readyGeometry.controls[2],'REC LED fits within Controls');
      const checkVisualState=async(name)=>{
        const actual=await run(`(()=>{const group=document.querySelector('[aria-label="Recording controls"]'),button=group.querySelector('button'),led=group.querySelector('[role="img"]');return {label:button.nextElementSibling.textContent,colour:button.classList.contains('bg-amber-600')?'amber':'red',icon:button.querySelector('svg')?.classList.contains('lucide-pause')?'pause':'circle',led:led.getAttribute('aria-label'),glow:getComputedStyle(led.firstElementChild).boxShadow!=='none'};})()`);
        assert.deepEqual(actual,{label:name==='Ready'?'RECORD':name==='Recording'?'PAUSE':'RESUME',colour:name==='Paused'?'amber':'red',icon:name==='Ready'?'circle':'pause',led:name==='Recording'?'Recording indicator on':name==='Paused'?'Recording indicator flashing: paused':'Recording indicator off',glow:name!=='Ready'},name+' visual state');
      };
      await checkVisualState('Ready');
      assert.equal(await run(`!!document.querySelector('.recording-paused-led')`),false,'Ready LED does not blink');
      const scale=readyGeometry.button[2]/136;
      assert.ok(readyGeometry.button[2]>readyGeometry.preamp[2],'primary button larger than Preamp');
      assert.ok(Math.abs(readyGeometry.transport[1]+readyGeometry.transport[3]-(readyGeometry.controls[1]+readyGeometry.controls[3]-13*scale))<1,'recording controls anchored at panel bottom');
      assert.ok(readyGeometry.preampSection[1]+readyGeometry.preampSection[3]<=readyGeometry.transport[1],'Preamp does not overlap recording controls');
      assert.ok(Math.abs(readyGeometry.meters[0]+readyGeometry.meters[2]-(readyGeometry.scope[0]+readyGeometry.scope[2]))<.01,'meters span beneath waveform and oscilloscope');
      assert.equal(await run(`!!document.querySelector('[title="Toggle monitor output"], [title="Monitor volume"]') || [...document.querySelectorAll('span')].some(e=>e.textContent==='Transport')`),false,'Monitor and separate Transport removed');
      const assertSilentOutput=async()=>assert.equal(await run(`audioNodes.filter(n=>n.connections.some(target=>target.kind==='destination')).every(n=>n.kind==='processor')`),true,'input/gain never route to speakers regardless of saved preferences');
      await assertSilentOutput();
      assert.equal(await run(`document.querySelector('[aria-label="Detect preamp level"]').disabled`),false,'Detect remains available');
      await run(`
        { const silent=new Float32Array(2048).fill(1);
        processors.find(p=>p.size===2048).onaudioprocess({inputBuffer:{numberOfChannels:2,getChannelData:()=>new Float32Array(2048)},outputBuffer:{getChannelData:()=>silent}});
        if(silent.some(value=>value!==0)) throw Error('Calibration output must be silent'); }
      `);
      // Detect must still analyse raw input with software monitoring removed.
      await run(`document.querySelector('[aria-label="Detect preamp level"]').focus()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
      await wait(`document.querySelector('[aria-label="Detect preamp level"]').getAttribute('aria-pressed')==='true'`);
      await run(`
        { const silent=new Float32Array(2048).fill(1);
        processors.find(p=>p.size===2048).onaudioprocess({inputBuffer:{numberOfChannels:2,getChannelData:()=>new Float32Array(2048).fill(.5)},outputBuffer:{getChannelData:()=>silent}});
        if(silent.some(value=>value!==0)) throw Error('Detect output must be silent'); }
      `);
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      await wait(`document.querySelector('output[aria-live="polite"]').textContent.startsWith('SET')`);
      assert.deepEqual(await run('geometry()'),readyGeometry,'Detect feedback does not shift layout');
      assert.ok(readyGeometry.stopGroup[1]>readyGeometry.button[1]+readyGeometry.button[3],'Stop below primary button');
      assert.ok(readyGeometry.vus.every(vu=>Math.abs(vu[2]/vu[3]-440/246)<.001),'VU proportions preserved');
      await run(`document.querySelector('[aria-label="Start recording"]').click()`);
      await wait('processors.some(processor=>processor.size===4096)');
      await assertSilentOutput();
      await run('feed(.25,-.5)');
      await wait('traceCount===1');
      await wait(`!!document.querySelector('[aria-label="Pause recording"]')`);
      assert.deepEqual(await run('geometry()'),readyGeometry,'recording layout stable');
      await checkVisualState('Recording');
      assert.equal(await run(`!!document.querySelector('.recording-paused-led')`),false,'Recording LED remains steady');
      assert.equal(await run(`getComputedStyle(document.querySelector('[aria-label="Pause recording"]')).animationName`),'none','recording button stays steady');
      await capture('recording');
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyM',key:'m',bubbles:true}))`);
      assert.equal(await run(`document.querySelector('[aria-label="Add recording marker"]')?.textContent.includes('(1)')`),true,'M drops recording marker');
      await run(`document.querySelector('[aria-label="Pause recording"]').click()`);
      await wait(`!!document.querySelector('[aria-label="Resume recording"]')`);
      assert.deepEqual(await run('geometry()'),readyGeometry,'paused layout stable');
      assert.equal(await run(`document.querySelector('[aria-label="Resume recording"] svg').classList.contains('lucide-pause')`),true,'Paused shows pause icon with Resume action');
      assert.equal(await run(`document.querySelector('[aria-label="Resume recording"]').nextElementSibling.textContent`),'RESUME','Resume label stays visible');
      assert.equal(await run(`[...document.querySelector('[aria-label="Combined recording waveform"]').parentElement.nextElementSibling.querySelectorAll('span')].some(e=>e.textContent==='Paused')`),true,'Paused status readout stays visible');
      await checkVisualState('Paused');
      const checkPausedLed=async()=>assert.deepEqual(await run(`(()=>{const led=document.querySelector('.recording-paused-led'),animation=led.getAnimations()[0];return {name:getComputedStyle(led).animationName,duration:animation?.effect.getTiming().duration,opacity:animation?.effect.getKeyframes().map(frame=>frame.opacity)};})()`),{name:'recording-led-blink',duration:1000,opacity:['1','0.15','1']},'Paused LED blinks once per second');
      await checkPausedLed();
      assert.deepEqual(await run(`(()=>{const button=document.querySelector('[aria-label="Resume recording"]'),icon=button.querySelector('svg'),animations=button.getAnimations().filter(animation=>animation instanceof CSSAnimation);return {name:getComputedStyle(button).animationName,duration:animations[0]?.effect.getTiming().duration,icon:icon.getAnimations().length,label:button.nextElementSibling.getAnimations().length};})()`),
        {name:'recording-pause-blink',duration:1000,icon:0,label:0},'one-second animation applies to button with a steady Resume label');
      assert.deepEqual(await run(`(()=>{const animation=document.querySelector('.recording-paused-button').getAnimations().find(animation=>animation instanceof CSSAnimation);return animation.effect.getKeyframes().map(frame=>frame.opacity);})()`),['1','0.55','1'],'gentle button blink');
      await capture('paused');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await wait(`getComputedStyle(document.querySelector('.recording-paused-button')).animationName==='none'`);
      assert.equal(await run(`getComputedStyle(document.querySelector('.recording-paused-button')).opacity`),'1','reduced motion shows steady amber button');
      assert.deepEqual(await run('geometry()'),readyGeometry,'reduced motion preserves layout');
      await checkPausedLed();
      // Sample the actual running animation, rather than only its CSS definition.
      const ledLevels=[];
      for(let sample=0;sample<8;sample++){
        await win.webContents.capturePage();
        ledLevels.push(Number(await run(`getComputedStyle(document.querySelector('.recording-paused-led')).opacity`)));
        await new Promise(resolve=>setTimeout(resolve,125));
      }
      assert.ok(Math.max(...ledLevels)-Math.min(...ledLevels)>.2,'LED visibly pulses even with reduced motion: '+ledLevels.join(', '));
      await capture('paused-reduced-motion');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});

      const frozenTime=await run('elapsed()');
      await run(`feed(1,1);window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyM',key:'m',bubbles:true}))`);
      await new Promise(resolve=>setTimeout(resolve,250));
      assert.equal(await run('elapsed()'),frozenTime,'elapsed time freezes while paused');
      assert.equal(await run(`document.querySelector('[aria-label="Add recording marker"]')?.textContent.includes('(1)')`),true,'M ignored while paused');
      // Space on the focused combined control must resume rather than reaching editor playback.
      await run(`document.querySelector('[aria-label="Resume recording"]').focus()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
      await wait(`!!document.querySelector('[aria-label="Pause recording"]')`);
      assert.deepEqual(await run('geometry()'),readyGeometry,'resumed layout stable');
      assert.equal(await run(`!!document.querySelector('.recording-paused-button')`),false,'resume removes blinking immediately');
      await checkVisualState('Recording');
      assert.equal(await run(`!!document.querySelector('.recording-paused-led')`),false,'Recording LED remains steady');
      assert.equal(await run(`getComputedStyle(document.querySelector('[aria-label="Pause recording"] svg')).animationName`),'none','recording icon is steady');
      await wait(`elapsed()!==${JSON.stringify(frozenTime)}`);
      await capture('resumed');
      await run('feed(.75,.5)');
      if(stopWhilePaused){
        await run(`document.querySelector('[aria-label="Pause recording"]').click()`);
        await wait(`!!document.querySelector('[aria-label="Resume recording"]')`);
      }
      assert.equal(await run(`document.querySelector('[aria-label="Stop recording"]').disabled`),false,'Stop enabled in active and paused recordings');
      assert.equal(await run('traceCount'), 1, 'one combined scrolling trace');
      assert.equal(await run(`!!document.querySelector('[aria-label="L VU level meter"]') && !!document.querySelector('[aria-label="R VU level meter"]')`), true, 'both stereo meters remain');
      await capture(stopWhilePaused?'stop-paused':'stop-recording');
      await run(`document.querySelector('[aria-label="Stop recording"]').click()`);
      await wait('finalBuffer!==null');
      assert.equal(await run(`!!document.querySelector('.recording-paused-button, .recording-paused-led')`),false,'Stop removes paused animations');
      assert.deepEqual(await run(`({channels:finalBuffer.numberOfChannels,rate:finalBuffer.sampleRate,
        length:finalBuffer.length,left:[finalBuffer.getChannelData(0)[0],finalBuffer.getChannelData(0)[4095],finalBuffer.getChannelData(0)[4096],finalBuffer.getChannelData(0)[8191]],right:[finalBuffer.getChannelData(1)[0],finalBuffer.getChannelData(1)[4095],finalBuffer.getChannelData(1)[4096],finalBuffer.getChannelData(1)[8191]]})`),
        { channels: 2, rate: 44100, length: 8192, left: [0.25,0.25,0.75,0.75], right: [-0.5,-0.5,0.5,0.5] }, 'captured stereo samples remain distinct and exact');
      // Finalisation retains the existing switch to Edit; returning to Record shows Ready.
      await run(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='RECORD').click()`);
      await wait(`!!document.querySelector('[aria-label="Start recording"]') && document.querySelector('[aria-label="Start recording"]').getBoundingClientRect().width<136`);
      await checkVisualState('Ready');
      assert.equal(await run(`!!document.querySelector('.recording-paused-led')`),false,'Ready LED does not blink');
      assert.equal(await run(`document.querySelector('[aria-label="Stop recording"]').disabled`),true,'Stop disabled after finalisation');
      assert.deepEqual(await run('geometry()'),readyGeometry,'Ready layout restored after finalisation');
      await capture('stopped-ready');
      console.log('PASS: bottom-right controls, full-width meters, stable layout, silent output, Space resume, marker/pause behaviour, exact stereo continuity; stop while '+(stopWhilePaused?'paused':'recording'));
    }
    win.destroy();app.exit(0);
  } catch (error) { console.error(error);win.destroy();app.exit(1); }
});
