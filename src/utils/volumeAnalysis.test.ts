import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyseVolume, affectedFrames, analysisIsCurrent, processVolume } from './volumeAnalysis';
import { measureSamplePeak } from './volumeTools';
class BufferFixture {
  sampleRate = 48000;
  channels: Float32Array[];
  constructor({ length, numberOfChannels, sampleRate }: {length: number; numberOfChannels: number; sampleRate: number}) { this.sampleRate = sampleRate; this.channels = Array.from({length: numberOfChannels}, () => new Float32Array(length)); }
  get numberOfChannels() { return this.channels.length; } get length() { return this.channels[0].length; } get duration() { return this.length / this.sampleRate; }
  getChannelData(c: number) { return this.channels[c]; }
  copyToChannel(d: Float32Array, c: number) { this.channels[c].set(d); }
}
(globalThis as any).AudioBuffer = BufferFixture;
const make = (l: number[], r: number[]) => { const b = new BufferFixture({length: l.length, numberOfChannels: 2, sampleRate: 48000}); b.channels[0].set(l); b.channels[1].set(r); return b as unknown as AudioBuffer; };
test('cached counts include either channel, count coincident stereo once, exact exclusive scope', async () => {
  const b = make([.95, .1, .9, .2, .8], [0, .96, .9, .7, 0]);
  const cache = await analyseVolume(b, 'selection', {start: 1, end: 4});
  assert.ok(Math.abs(cache.peak - .96) < 1e-6);
  assert.equal(affectedFrames(cache, -3), 2);
  assert.equal(affectedFrames(cache, -6), 3);
  assert.equal(affectedFrames(cache, -6, -3), 2);
  assert.equal(affectedFrames(cache, 0), 0);
  assert.equal(analysisIsCurrent(cache, b, 'selection', {start:1,end:4}), true);
  assert.equal(analysisIsCurrent(cache, b, 'selection', {start:1,end:5}), false);
  assert.equal(analysisIsCurrent(cache, b, 'all', {start:1,end:4}), false);
  assert.equal(analysisIsCurrent(cache, make([0],[0]), 'selection', {start:1,end:4}), false);
});
test('strict threshold and ceiling match clamp, source and outside samples untouched', async () => {
  const b = make([.99, .1, .9, .2, -.99], [.8, .96, .9, .7, -.9]);
  const cache = await analyseVolume(b, 'selection', {start:1,end:4});
  const result = await processVolume(cache, 'reduce', {thresholdDb:-3,ceilingDb:-6,targetDb:-.5});
  assert.ok(result.ok); if (!result.ok) return;
  assert.equal(result.peaksReducedCount, affectedFrames(cache,-3,-6));
  const ceil = Math.pow(10,-6/20);
  assert.ok(Math.abs(result.buffer.getChannelData(1)[1] - ceil) < 1e-6);
  for(let c=0;c<2;c++) { assert.equal(result.buffer.getChannelData(c)[0], b.getChannelData(c)[0]); assert.equal(result.buffer.getChannelData(c)[4], b.getChannelData(c)[4]); }
  assert.ok(Math.abs(b.getChannelData(1)[1]-.96)<1e-6);
  assert.equal(result.buffer.length,b.length); assert.equal(result.buffer.sampleRate,b.sampleRate);
});
test('normalise and combined use fresh linked scope peak; silence/invalid safe', async () => {
  const b=make([.99,.2,.9,.3,.99],[.8,.1,.96,.15,.8]);
  const cache=await analyseVolume(b,'selection',{start:1,end:4});
  for(const action of ['normalise','combined'] as const) {
    const result=await processVolume(cache,action,{thresholdDb:-3,ceilingDb:-6,targetDb:-.5});
    assert.ok(result.ok); if(!result.ok)continue;
    assert.ok(Math.abs(measureSamplePeak([result.buffer.getChannelData(0),result.buffer.getChannelData(1)],cache.range)-Math.pow(10,-.5/20))<1e-6);
    assert.ok(Math.abs(result.buffer.getChannelData(0)[1]/result.buffer.getChannelData(1)[1]-2)<1e-6);
    assert.equal(result.buffer.getChannelData(0)[0],b.getChannelData(0)[0]);
  }
  const silent=await analyseVolume(make([0,0],[0,0]),'all',{start:0,end:2});
  assert.deepEqual(await processVolume(silent,'normalise',{thresholdDb:-3,ceilingDb:-6,targetDb:-.5}),{ok:false,reason:'silent'});
  assert.deepEqual(await processVolume(cache,'normalise',{thresholdDb:-3,ceilingDb:-6,targetDb:NaN}),{ok:false,reason:'invalid'});
});
test('chunked analysis yields, rejects cancelled scans and processing without modifying source',async()=>{
  const b=new BufferFixture({length:150000,numberOfChannels:2,sampleRate:48000}) as unknown as AudioBuffer;
  b.getChannelData(1).fill(.9);
  let paints=0;const timer=setInterval(()=>paints++,1);
  const cache=await analyseVolume(b,'all',{start:0,end:b.length});clearInterval(timer);assert.ok(paints>=2);
  const control=new AbortController();const scan=analyseVolume(b,'all',cache.range,control.signal);control.abort();await assert.rejects(scan,{name:'AbortError'});
  const processingControl=new AbortController();const result=processVolume(cache,'combined',{thresholdDb:-3,ceilingDb:-6,targetDb:-.5},processingControl.signal);processingControl.abort();await assert.rejects(result,{name:'AbortError'});
  assert.equal(b.getChannelData(1)[0],Math.fround(.9));
});
