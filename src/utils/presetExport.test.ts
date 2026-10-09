import assert from 'node:assert/strict';
import test from 'node:test';
import { captureExport, exportItemChannels, presetFilename, runExport, ItemResult, loopExportList, CollisionPolicy, writtenFilename } from './presetExport';
import { presetStrip } from './presetStrip';
const source = () => { const channels = [Float32Array.from({length: 20}, (_, i) => i), Float32Array.from({length: 20}, (_, i) => -i)]; return { length: 20, numberOfChannels: 2, sampleRate: 48000, getChannelData: (c: number) => channels[c] }; };
const settings = { base: 'Session.wav', folder: 'C:/samples', format: 'flac' as const, depth: 16 as const };
const regions = [{ id: 1, region: { start: 2, end: 6, beat: 4 } }, { id: 0, region: { start: 10, end: 13, beat: 11 } }];
test('batch copies immutable stored regions, exact rotated stereo samples and slot suffixes', () => {
  const audio = source(), snapshot = captureExport(audio, regions, settings, true);
  audio.getChannelData(0).fill(99); const previous = regions[0].region.beat; regions[0].region.beat = 2;
  assert.equal(snapshot.items[0].name, 'Session_01.flac'); assert.equal(snapshot.items[1].name, 'Session_10.flac');
  assert.equal(snapshot.sampleRate, 48000); assert.equal(snapshot.channels.reduce((frames, chunk) => frames + chunk[0].length, 0), 7, 'Copy no gaps between disjoint regions');
  const overlapping = captureExport(source(), [regions[0], {id:2, region:{start:3,end:7,beat:3}}], settings, true);
  assert.equal(overlapping.channels.length,1); assert.equal(overlapping.channels[0][0].length,5, 'Overlapping presets share one immutable audio span');
  assert.deepEqual(exportItemChannels(snapshot, snapshot.items[0]).map(c => [...c]), [[4,5,2,3],[-4,-5,-2,-3]]);
  assert.deepEqual(exportItemChannels(snapshot, snapshot.items[1]).map(c => [...c]), [[11,12,10],[-11,-12,-10]]);
  regions[0].region.beat = previous;
  assert.equal(presetFilename('Session', 7, 'wav'), 'Session_07.wav');
  assert.throws(() => presetFilename('../bad', 1, 'wav')); assert.throws(() => captureExport(audio, [], settings, true));
});
test('sequential writes, explicit collision decision, partial failure and retry only unfinished', async () => {
  const snapshot = captureExport(source(), regions, settings, true), results: Record<number, ItemResult> = {};
  const calls: string[] = []; let fail = true, concurrent = 0;
  const handlers = { cancelled: () => false, encode: async () => new Uint8Array([1]), write: async (request: any) => {
    assert.equal(concurrent++, 0); await new Promise(r => setTimeout(r, 2)); concurrent--;
    calls.push(request.name + ':' + request.mode);
    if (request.name.includes('_10') && fail) throw Error('disk failure');
    return { status: request.mode === 'ask' ? 'exists' as const : 'saved' as const, path: request.name };
  }, collision: async () => 'numbered' as const, update: () => {} };
  assert.deepEqual(await runExport(snapshot, results, handlers), {saved:1,total:2,cancelled:false});
  fail = false; assert.equal((await runExport(snapshot, results, handlers)).saved, 2);
  assert.equal(calls.filter(c => c.includes('_01')).length, 2); assert.equal(calls.filter(c => c.includes('_10')).length, 3);
});
test('cancellation during a write keeps completed file and never schedules next file', async () => {
  const snapshot = captureExport(source(), regions, settings, true), results: Record<number, ItemResult> = {}; let cancelled = false, writes = 0;
  const summary = await runExport(snapshot, results, { cancelled: () => cancelled, encode: async () => new Uint8Array([1]), write: async () => { writes++; cancelled = true; return {status:'saved',path:'done'}; }, collision: async () => null, update: () => {} });
  assert.deepEqual(summary, {saved:1,total:2,cancelled:true}); assert.equal(writes,1); assert.equal(results[1].state,'saved');
});
test('cancellation after encoding or collision never publishes that file', async () => {
  for (const stage of ['encode','collision']) { let cancelled = false, writes = 0; const results: Record<number, ItemResult> = {};
    await runExport(captureExport(source(), regions, settings, true), results, {cancelled:()=>cancelled, encode:async()=>{if(stage==='encode')cancelled=true;return new Uint8Array([1]);}, write:async()=>{writes++;return {status:'exists',path:'existing'};}, collision:async()=>{cancelled=true;return null;}, update:()=>{}});
    assert.equal(writes, stage==='encode'?0:1);assert.equal(results[1].state,'pending');
  }
});
test('three stable lanes, ten overlapping slots, clipping and short-region details', () => {
  const slots = Array.from({length:10},(_,used)=>({start:2,end:8,beat:2,custom:false,used}));
  const full = presetStrip(slots,1,0,10,100); assert.equal(full.bars.length,3); assert.equal(full.overflow.length,7);
  assert.deepEqual(full.bars.map(b=>[b.left,b.right,b.lane]),[[20,80,0],[20,80,1],[20,80,2]]);
  const zoom = presetStrip(slots,1,4,2,100);assert.deepEqual(zoom.bars.map(b=>[b.left,b.right,b.lane]),[[0,100,0],[0,100,1],[0,100,2]]);
  assert.equal(presetStrip(slots,1,8,2,100).bars.length,0);
  assert.equal(presetStrip([{...slots[0],start:4,end:5}],1,0,1000,100).bars[0].right,.5);
});

test('one save list prefers occupied slots over an edited current loop and defaults to fallback only without presets', () => {
  const slots = Array(10).fill(null), selection = {start:5,end:9};
  assert.deepEqual(loopExportList(slots,null,null),[]);
  assert.deepEqual(loopExportList(slots,selection,6),[{id:-1,region:{start:5,end:9,beat:6}}]);
  slots[0] = {start:1,end:4,beat:2,custom:true,used:1};
  assert.deepEqual(loopExportList(slots,selection,6),[{id:0,region:slots[0]}]);
  slots[7] = {start:11,end:13,beat:11,custom:false,used:2};
  assert.deepEqual(loopExportList(slots,null,null).map(item=>item.id),[7,0]);
  const captured = captureExport(source(),loopExportList(slots,selection,6),settings,true);
  assert.deepEqual(captured.items.map(item=>item.name),['Session_07.flac','Session_10.flac']);
  const fallback=captureExport(source(),loopExportList(Array(10).fill(null),selection,6),settings,false);
  assert.equal(fallback.items[0].name,'Session.flac');
});
test('explicit per-conflict choices or operation policy handle late conflicts and retain actual resolved names', async () => {
  for(const apply of [false,true]) for(const mode of ['replace','numbered'] as const) {
    const snapshot=captureExport(source(),regions,settings,true),results:Record<number,ItemResult>={},policy:CollisionPolicy={mode:null};let asks=0;
    const requests:string[]=[];
    await runExport(snapshot,results,{policy,cancelled:()=>false,encode:async()=>new Uint8Array([1]),write:async request=>{
      requests.push(request.mode);
      // Exists may be discovered only at safe publication, after encoding.
      return request.mode==='ask'?{status:'exists',path:request.name}:{status:'saved',path:'C:\\samples\\'+(mode==='numbered'?request.name.replace('.flac',' (2).flac'):request.name)};
    },collision:async()=>{asks++;if(apply)policy.mode=mode;return mode;},update:()=>{}});
    assert.equal(asks,apply?1:2);assert.deepEqual(requests,['ask',mode,'ask',mode]);
    assert.equal(results[0].name,mode==='numbered'?'Session_10 (2).flac':'Session_10.flac');
    assert.equal(writtenFilename('/samples/Session_01.flac'),'Session_01.flac');
  }
});
test('collision policy survives retry, skips completed files, and a new operation starts without policy', async () => {
  const snapshot=captureExport(source(),regions,settings,true),results:Record<number,ItemResult>={},policy:CollisionPolicy={mode:null};let asks=0,fail=true;
  const calls:number[]=[];
  const handlers={policy,cancelled:()=>false,encode:async()=>new Uint8Array([1]),write:async(request:any)=>{
    const slot=request.name.includes('_10')?0:1;calls.push(slot);
    if(slot===0&&fail)throw Error('temporary disk failure');
    return request.mode==='ask'?{status:'exists' as const,path:request.name}:{status:'saved' as const,path:request.name.replace('.flac',' (2).flac')};
  },collision:async()=>{asks++;policy.mode='numbered';return 'numbered' as const;},update:()=>{}};
  await runExport(snapshot,results,handlers);assert.equal(asks,1);fail=false;
  await runExport(snapshot,results,handlers);assert.equal(asks,1);assert.equal(calls.filter(id=>id===1).length,2);
  assert.equal(results[0].name,'Session_10 (2).flac');
  await runExport(snapshot,{}, {...handlers,policy:{mode:null},collision:async()=>{asks++;return 'numbered' as const;}});assert.equal(asks,3);
});
