import { performance } from 'node:perf_hooks';
import { analyseVolume, affectedFrames } from '../src/utils/volumeAnalysis';
const rate=48000;
for(const seconds of [30,180]){
 const channels=[new Float32Array(seconds*rate),new Float32Array(seconds*rate)];
 for(let i=0;i<channels[0].length;i++){channels[0][i]=.2*Math.sin(i*.057);channels[1][i]=.12*Math.sin(i*.071);if(i%48000===0)channels[1][i]=.96;}
 const buffer={sampleRate:rate,length:channels[0].length,duration:seconds,numberOfChannels:2,getChannelData:(c:number)=>channels[c]} as AudioBuffer;
 for(const selected of [false,true]){
  let ticks=0;const timer=setInterval(()=>ticks++,1),start=performance.now();
  const result=await analyseVolume(buffer,selected?'selection':'all',selected?{start:10*rate,end:20*rate}:{start:0,end:buffer.length});
  const ms=performance.now()-start;clearInterval(timer);
  const countStart=performance.now();let count=0;for(let i=0;i<1000;i++)count=affectedFrames(result,-24+(i%49)*.5,-6);
  console.log(JSON.stringify({seconds,scope:selected?'10-second selection':'entire',ms,peak:result.peak,rightChannelFrames:affectedFrames(result,-3),uiYields:ticks,thousandCachedCountsMs:performance.now()-countStart,count}));
 }
}
