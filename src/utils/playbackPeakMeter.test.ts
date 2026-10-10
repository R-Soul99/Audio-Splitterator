import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
test('render-thread processor measures stereo sample peaks, keeps silent output and flushes final short block',()=>{
  const messages: any[]=[];
  const context: any={AudioWorkletProcessor: class {port={postMessage:(m:any)=>messages.push(m)};},sampleRate:48000,currentTime:1,registerProcessor:(_:string,processor:any)=>{context.Processor=processor;}};
  vm.runInNewContext(fs.readFileSync(new URL('../../public/playback-peak-meter.js',import.meta.url),'utf8'),context);
  const processor=new context.Processor();
  const outputs=[[new Float32Array(128),new Float32Array(128)]];
  for(let block=0;block<4;block++){
    const l=new Float32Array(128).fill(.25),r=new Float32Array(128).fill(.5);
    if(block===2)r[67]=-.9;
    processor.process([[l,r]],outputs);
    context.currentTime+=128/48000;
  }
  assert.equal(messages.length,1);assert.equal(messages[0].peaks[0],.25);assert.ok(Math.abs(messages[0].peaks[1]-.9)<1e-6);
  assert.ok(Math.abs(messages[0].end-(1+512/48000))<1e-10);
  assert.ok(Math.abs(messages[0].peakTimes[1]-(1+(256+67)/48000))<1e-10);
  assert.ok(outputs[0].every(c=>c.every(v=>v===0)),'side branch adds no audible PCM');
  const mono=new Float32Array(128);mono[127]=.99;mono[0]=NaN;
  processor.process([[mono]],outputs);processor.process([[]],outputs);
  assert.equal(messages[1].epoch,0);
  processor.port.onmessage({data:{epoch:5}});
  for(let i=0;i<4;i++)processor.process([[new Float32Array(128).fill(.1)]],outputs);
  assert.equal(messages[2].epoch,5);assert.ok(Math.abs(messages[2].peaks[0]-.1)<1e-6,'stopped-generation peaks cleared');
  assert.equal(messages.length,3);assert.ok(Math.abs(messages[1].peaks[0]-.99)<1e-6);assert.equal(messages[1].peaks[0],messages[1].peaks[1]);
});
import { PlaybackPeakMeter } from './playbackPeakMeter';
test('meter clocks heard peaks, Reset affects held only, stop rejects old epochs and preserves audible route',async()=>{
  const globals:any=globalThis;
  const original={document:globals.document,AudioWorkletNode:globals.AudioWorkletNode,requestAnimationFrame:globals.requestAnimationFrame,cancelAnimationFrame:globals.cancelAnimationFrame};
  let next=0;const frames=new Map<number,FrameRequestCallback>();
  class Node {
    connections:any[]=[];
    port:any={onmessage:null,postMessage:(_:any)=>{},close:()=>{}};
    gain={value:1};
    connect(n:any){this.connections.push(n);return n;}
    disconnect(n?:any){this.connections=n?this.connections.filter(v=>v!==n):[];}
  }
  let heard=1;
  const ctx:any={currentTime:1,state:'running',destination:{},audioWorklet:{addModule:async()=>{}},createGain:()=>new Node(),getOutputTimestamp:()=>({contextTime:heard,performanceTime:performance.now()}),baseLatency:0,outputLatency:0};
  globals.document={baseURI:'http://localhost/'};globals.AudioWorkletNode=Node;
  globals.requestAnimationFrame=(cb:FrameRequestCallback)=>{frames.set(++next,cb);return next;};globals.cancelAnimationFrame=(id:number)=>frames.delete(id);
  const meter=new PlaybackPeakMeter();const internals:any=meter;
  const tick=()=>{const [id,cb]=frames.entries().next().value;frames.delete(id);cb(performance.now());};
  const flush=()=>new Promise<void>(r=>setImmediate(r));
  const packet=(peaks:number[],times:number[],end:number,epoch=internals.epoch)=>internals.node.port.onmessage({data:{peaks,peakTimes:times,end,epoch}});
  try{
    meter.setActive(true);assert.equal(internals.node,null,'opening does not create audio context');
    const source=new Node();source.connect(ctx.destination);meter.track(source as any,ctx);await flush();
    meter.track(source as any,ctx);await flush();assert.equal(source.connections.length,2,'one destination and one silent meter route');
    ctx.currentTime=1.7;heard=1.3;packet([.3,.9],[1.2,1.5],1.6);tick();assert.deepEqual(internals.levels.held,[.3,0],'future right peak is not displayed early');
    heard=1.6;tick();assert.deepEqual(internals.levels.held,[.3,.9]);
    const live=[...internals.levels.live];meter.reset();assert.deepEqual(internals.levels.held,[0,0]);assert.deepEqual(internals.levels.live,live);
    const oldEpoch=internals.epoch;meter.stop();assert.deepEqual(source.connections,[ctx.destination],'stop removes only monitor branch');
    const replacement=new Node();replacement.connect(ctx.destination);meter.track(replacement as any,ctx);await flush();
    packet([1,1],[1.6,1.6],1.6,oldEpoch);packet([.25,.5],[1.6,1.6],1.6);tick();assert.deepEqual(internals.levels.held,[.25,.5],'old playback packet rejected');
    // The final block can extend beyond the end, but its peak sample is already heard.
    packet([.25,.99],[1.64,1.64],1.71);meter.untrack(replacement as any);heard=1.66;meter.stop();assert.deepEqual(internals.levels.held,[.25,.99]);assert.deepEqual(internals.levels.live,[0,0]);
    meter.setActive(false);const hidden=new Node();meter.track(hidden as any,ctx);meter.untrack(hidden as any);assert.equal(internals.sources.size,0,'hidden ended sources are not retained');
  }finally{meter.dispose();Object.assign(globals,original);}
});
