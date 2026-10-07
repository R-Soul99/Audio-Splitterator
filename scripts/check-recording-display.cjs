// Controlled stereo input through real recording handlers; no physical device needed.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async code => {
    const deadline = Date.now() + 15000;
    while (!await run(code)) {
      if (Date.now() > deadline) throw Error(code);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  try {
    for (const stopWhilePaused of [false, true]) {
      await win.loadURL(process.argv[2] || 'http://localhost:3000/?standby=1');
      await run(`localStorage.setItem('audiophonic_preview_standby','true')`);
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload();});
      await wait(`!!document.querySelector('[aria-label="Wake audio engine"]')`);
      await run(`
        window.processors=[];window.analysers=0;window.traceCount=0;window.finalBuffer=null;
        navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){}}]});
        navigator.mediaDevices.enumerateDevices=async()=>[];
        const node=()=>({connect(){},disconnect(){},gain:{value:1,setValueAtTime(){}}});
        window.AudioContext=class {
          constructor(options={}){this.sampleRate=options.sampleRate||48000;this.state='running';this.currentTime=0;this.destination=node();}
          resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
          createMediaStreamSource(){return node();}createGain(){return node();}createChannelSplitter(){return node();}
          createAnalyser(){const value=analysers++%2===0?.25:-.5;return {...node(),fftSize:1024,getFloatTimeDomainData(array){array.fill(value);}};}
          createScriptProcessor(size){const processor={...node(),size};processors.push(processor);return processor;}
          createBuffer(channels,length,sampleRate){finalBuffer=new AudioBuffer({numberOfChannels:channels,length,sampleRate});return finalBuffer;}
        };
        const fill=CanvasRenderingContext2D.prototype.fillRect,stroke=CanvasRenderingContext2D.prototype.stroke;
        CanvasRenderingContext2D.prototype.fillRect=function(...args){if(this.canvas.getAttribute('aria-label')==='Combined recording waveform'&&args[0]===0&&args[1]===0)traceCount=0;return fill.apply(this,args);};
        CanvasRenderingContext2D.prototype.stroke=function(...args){if(this.canvas.getAttribute('aria-label')==='Combined recording waveform'&&this.lineWidth===2)traceCount++;return stroke.apply(this,args);};
        document.querySelector('[aria-label="Wake audio engine"]').click();
      `);
      await wait('analysers>=2');
      await wait(`document.querySelector('[aria-label="Start recording"]').getBoundingClientRect().width<96`);
      await run(`
        window.geometry=()=>{
          const rect=element=>{const r=element.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
          const panel=title=>[...document.querySelectorAll('span')].find(e=>e.textContent===title).parentElement;
          const waveform=document.querySelector('[aria-label="Combined recording waveform"]');
          const meters=panel('Level Meters').parentElement;
          const transport=panel('Transport');
          return {waveform:rect(waveform),meters:rect(meters),transport:rect(transport),
            button:rect(transport.querySelector('button')),
            vus:[...document.querySelectorAll('svg[aria-label$="level meter"]')].map(rect),
            overflow:[document.documentElement.scrollWidth>innerWidth,document.documentElement.scrollHeight>innerHeight],
            clipped:[...transport.querySelectorAll('button')].some(b=>b.getBoundingClientRect().bottom>transport.getBoundingClientRect().bottom)};
        };
        window.elapsed=()=>document.querySelector('[aria-label="Combined recording waveform"]').parentElement.nextElementSibling.children[0].children[1].textContent;
        window.feed=(leftValue,rightValue)=>processors.find(processor=>processor.size===4096).onaudioprocess({
          inputBuffer:{numberOfChannels:2,getChannelData:channel=>new Float32Array(4096).fill(channel?rightValue:leftValue)},
          outputBuffer:{numberOfChannels:2,getChannelData:()=>new Float32Array(4096)}
        });
        void 0;
      `);
      const capture=async state=>{ await win.webContents.capturePage(); await new Promise(resolve=>setTimeout(resolve,80)); await win.webContents.capturePage().then(image=>require('fs').writeFileSync(require('path').join(app.getPath('temp'),`splitterator-transport-${state}.png`),image.toPNG())); };
      const readyGeometry=await run('geometry()');
      await capture('ready');
      assert.equal(await run(`document.querySelector('[aria-label="Stop recording"]').disabled`),true);
      assert.ok(Math.abs(readyGeometry.meters[0]-(readyGeometry.waveform[0]-17*(readyGeometry.button[2]/96)))<1,'meter panel aligned with waveform panel');
      assert.ok(readyGeometry.transport[0]>readyGeometry.meters[0]);
      assert.deepEqual(readyGeometry.overflow,[false,false]);
      assert.equal(readyGeometry.clipped,false);
      await run(`document.querySelector('[aria-label="Start recording"]').click()`);
      await wait('processors.some(processor=>processor.size===4096)');
      await run(`
        const left=new Float32Array(4096).fill(.25),right=new Float32Array(4096).fill(-.5);
        processors.find(processor=>processor.size===4096).onaudioprocess({
          inputBuffer:{numberOfChannels:2,getChannelData:channel=>channel?right:left},
          outputBuffer:{numberOfChannels:2,getChannelData:()=>new Float32Array(4096)}
        });
      `);
      await wait('traceCount===1');
      await wait(`!!document.querySelector('[aria-label="Pause recording"]')`);
      assert.deepEqual(await run('geometry()'),readyGeometry,'recording layout stable');
      await capture('recording');
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyM',key:'m',bubbles:true}))`);
      assert.equal(await run(`document.querySelector('[aria-label="Add recording marker"]')?.textContent.includes('(1)')`),true,'M drops recording marker');
      await run(`document.querySelector('[aria-label="Pause recording"]').click()`);
      await wait(`!!document.querySelector('[aria-label="Resume recording"]')`);
      assert.deepEqual(await run('geometry()'),readyGeometry,'paused layout stable');
      await capture('paused');
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
      assert.deepEqual(await run(`({channels:finalBuffer.numberOfChannels,rate:finalBuffer.sampleRate,
        length:finalBuffer.length,left:[finalBuffer.getChannelData(0)[0],finalBuffer.getChannelData(0)[4095],finalBuffer.getChannelData(0)[4096],finalBuffer.getChannelData(0)[8191]],right:[finalBuffer.getChannelData(1)[0],finalBuffer.getChannelData(1)[4095],finalBuffer.getChannelData(1)[4096],finalBuffer.getChannelData(1)[8191]]})`),
        { channels: 2, rate: 44100, length: 8192, left: [0.25,0.25,0.75,0.75], right: [-0.5,-0.5,0.5,0.5] }, 'captured stereo samples remain distinct and exact');
      console.log('PASS: stable transport/layout, Space resume, marker/pause behaviour, exact stereo continuity; stop while '+(stopWhilePaused?'paused':'recording'));
    }
    win.destroy();app.exit(0);
  } catch (error) { console.error(error);win.destroy();app.exit(1); }
});
