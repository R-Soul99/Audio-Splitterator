// Same stereo fixtures and old/new analysis in Chromium; monitors event-loop responsiveness.
const { app, BrowserWindow } = require('electron');
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
    const bundle = await esbuild.build({ stdin: { contents: `export {performVolumeScan} from './src/utils/volumeTools';export {analyseVolume,affectedFrames} from './src/utils/volumeAnalysis';`, resolveDir: path.join(__dirname,'..') }, bundle:true,write:false,format:'iife',globalName:'VolumeBench',platform:'browser' });
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
    const measurements = await win.webContents.executeJavaScript(`(async()=>{
      const rows=[];
      for(const seconds of [30,180]){
        const b=new AudioBuffer({length:seconds*48000,numberOfChannels:2,sampleRate:48000}),l=b.getChannelData(0),r=b.getChannelData(1);
        for(let i=0;i<b.length;i++){l[i]=.2*Math.sin(i*.057);r[i]=.12*Math.sin(i*.071);if(i%48000===0)r[i]=.96;}
        for(const selected of [false,true]){
          const scope=selected?'selection':'all',range=selected?{start:480000,end:960000}:{start:0,end:b.length};
          await new Promise(resolve=>setTimeout(resolve,10));
          const before=performance.now();const old=VolumeBench.performVolumeScan(b,scope,selected?{start:10,end:20}:null,-3);const baselineMs=performance.now()-before;
          let ticks=0,maxGapMs=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;ticks++;},1);
          const start=performance.now();const cache=await VolumeBench.analyseVolume(b,scope,range);const newMs=performance.now()-start;clearInterval(timer);
          const thresholdStart=performance.now();for(let i=0;i<1000;i++)VolumeBench.affectedFrames(cache,-24+(i%49)*.5,-6);
          rows.push({seconds,scope:selected?'10-second selection':'entire',baselineMs,newMs,ticks,maxGapMs,oldFrames:old.analysis.peaksCount,newFrames:VolumeBench.affectedFrames(cache,-3),thousandCountsMs:performance.now()-thresholdStart});
        }
      }return rows;
    })()`);
    fs.mkdirSync(path.join(__dirname,'../build'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../build/volume-performance.json'),JSON.stringify(measurements,null,2));console.log(JSON.stringify(measurements,null,2));
    win.destroy();app.quit();
  }catch(e){console.error(e);win.destroy();app.exit(1);}
});
