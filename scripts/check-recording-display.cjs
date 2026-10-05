// Controlled stereo input through real recording handlers; no physical device needed.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async code => {
    const deadline = Date.now() + 15000;
    while (!await run(code)) {
      if (Date.now() > deadline) throw Error(code);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  try {
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
    assert.equal(await run('traceCount'), 1, 'one combined scrolling trace');
    assert.equal(await run(`!!document.querySelector('[aria-label="L VU level meter"]') && !!document.querySelector('[aria-label="R VU level meter"]')`), true, 'both stereo meters remain');
    await win.webContents.capturePage().then(image=>require('fs').writeFileSync(require('path').join(app.getPath('temp'),'splitterator-rec-combined-review.png'),image.toPNG()));
    await run(`document.querySelector('[aria-label="Stop recording"]').click()`);
    await wait('finalBuffer!==null');
    assert.deepEqual(await run(`({channels:finalBuffer.numberOfChannels,rate:finalBuffer.sampleRate,
      length:finalBuffer.length,left:[...new Set(finalBuffer.getChannelData(0))],right:[...new Set(finalBuffer.getChannelData(1))]})`),
      { channels: 2, rate: 44100, length: 4096, left: [0.25], right: [-0.5] }, 'captured stereo samples remain distinct and exact');
    console.log('PASS: one REC display trace, both VU meters, unchanged stereo samples and sample rate');
    win.destroy();app.exit(0);
  } catch (error) { console.error(error);win.destroy();app.exit(1); }
});
