// Spring Slide regression using real imported audio and native Web Audio sources.
// Run after npm run build: electron scripts/check-slide-control.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = path.join(__dirname, '../build', 'slide-control-regression-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
  const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(e) { console.error('Failed renderer code:', code); throw e; } };
  win.webContents.on('console-message', event => { if (event.level === 'error') console.log('Renderer:', event.message); });
  const pause = () => new Promise(resolve => setTimeout(resolve, 50));
  const wait = async code => {
    const deadline = Date.now() + 15000;
    while (!await run(code)) { if (Date.now() > deadline) throw Error(`Timed out: ${code}`); await pause(); }
  };
  try {
    const rate = 48000, frames = rate * 20 + 1;
    const wav = Buffer.alloc(44 + frames * 4);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40);
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) wav.writeInt16LE(c ? (i % (rate / 4) < 80 ? 20000 : 0) : Math.round(2000 + i / frames * 20000), 44 + i * 4 + c * 2);
    const file = path.join(__dirname, '../build/loop-sample-sync-transients.wav'); fs.writeFileSync(file, wav);
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
    win.webContents.setAudioMuted(true);
    await run(`
      window.sources=[]; window.blocks=[]; window.audioClock=null;
      const create=AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource=function(){
        const node=create.call(this),ctx=this,entry={node,ctx,active:false};sources.push(entry);
        const start=node.start.bind(node),stop=node.stop.bind(node),connect=node.connect.bind(node);
        node.start=(...args)=>{entry.active=true;entry.when=args[0]||ctx.currentTime;entry.offset=args[1];entry.duration=args[2];return start(...args)};
        node.stop=(...args)=>{entry.until=Math.min(entry.until??Infinity,args[0]||ctx.currentTime);return stop(...args)};
        node.connect=(...args)=>{if(window.tap)connect(window.tap);return connect(...args)};
        node.addEventListener('ended',()=>{entry.active=false});window.audioClock=ctx;return node;
      };
      const timestamp=AudioContext.prototype.getOutputTimestamp;
      AudioContext.prototype.getOutputTimestamp=function(){const stamp=timestamp.call(this);window.lastHeard=Math.max(0,Math.min(this.currentTime,stamp.contextTime>0?stamp.contextTime+Math.max(0,performance.now()-stamp.performanceTime)/1000:this.currentTime-this.baseLatency-this.outputLatency));return stamp;};
      void 0;
    `);
    win.webContents.debugger.attach('1.3');
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file] });
    await wait(`!!document.querySelector('[aria-label="Edit waveform"]') && !document.querySelector('main').inert`);
    await run(`
      window.wave = () => document.querySelector('[aria-label="Edit waveform"]');
      window.component = () => {
        let fiber = wave()[Object.keys(wave()).find(key => key.startsWith('__reactFiber'))];
        while (fiber.return) fiber = fiber.return;
        const queue = [fiber.stateNode.current];
        while (queue.length) { const next = queue.shift(); const p = next.memoizedProps;
          if (p?.onSelectionChange && p?.onZoomChange && p?.audioBuffer) return next;
          if (next.child) queue.push(next.child); if (next.sibling) queue.push(next.sibling);
        }
        throw Error('Waveform component missing');
      };
      window.currentSelection = () => component().memoizedProps.selection;
      window.audioDuration = component().memoizedProps.audioBuffer.duration;
      window.clearSelection = () => component().memoizedProps.onSelectionChange(null);
      void 0;
    `);
    const click = async label => { await run(`(document.querySelector('[aria-label="${label}"]') || [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${label}')).click()`); await pause(); };
    const select = async (label, value) => { await run(`(() => { const el = document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '${value}'); el.dispatchEvent(new Event('change', {bubbles:true})); })()`); await pause(); };
    const setRegion = async (start, end) => { await run(`component().memoizedProps.onSelectionChange({start:${start},end:${end}})`); await pause(); };
    const rect = await run('wave().getBoundingClientRect().toJSON()');
    await click('Loop / Sample');
    assert.equal(await run(`document.querySelector('[aria-label="Halve selection"]').disabled`), true);
    const typeTime = async (label, value, key) => {
      await run(`(() => { const el=document.querySelector('[aria-label="${label}"]'); el.focus(); el.select(); })()`); await pause();
      await win.webContents.debugger.sendCommand('Input.insertText', {text:value}); await pause();
      if (key) { await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key,code:key,windowsVirtualKeyCode:key==='Enter'?13:27}); await pause(); }
      else { await run(`document.querySelector('[aria-label="${label}"]').blur()`); await pause(); }
    };
    const snapshot = async name => { await win.webContents.capturePage(); await pause(); fs.writeFileSync(path.join(__dirname, `../build/slide-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
    const geometry=await run(`(()=>{const r=e=>e.getBoundingClientRect().toJSON();return {tools:r(document.querySelector('[aria-label="Tools"]')),wave:r(wave()),boundaries:[...document.querySelectorAll('.loop-boundaries,.loop-boundaries input,.loop-boundaries output,.loop-boundaries button')].map(r),loopTools:r(document.querySelector('.loop-movement')),memory:[...document.querySelectorAll('.loop-memory,.loop-memory-slot')].map(r)};})()`);
    const baselinePath=path.join(__dirname,'../build/slide-baseline.json');
    if(fs.existsSync(baselinePath)) {
      const baseline=JSON.parse(fs.readFileSync(baselinePath));assert.deepEqual(geometry.tools,baseline.tools);assert.deepEqual(geometry.wave,baseline.wave);assert.deepEqual(geometry.boundaries,baseline.boundaries);
      assert.ok(geometry.loopTools.width<baseline.loopTools.width);assert.deepEqual(geometry.memory.map(r=>({width:r.width,height:r.height})),baseline.memory.map(r=>({width:r.width,height:r.height})));
    }
    const saveRect=await run(`document.querySelector('[aria-label="Show sample save"]').getBoundingClientRect().toJSON()`);assert.ok(Math.abs(saveRect.right-geometry.tools.right)<.05,'Save reaches the existing inner right margin');assert.ok(saveRect.bottom<=geometry.memory[0].top,'Save is in the selector row above Memory');assert.equal(await run(`document.querySelector('[aria-label="Slide selection"]').getBoundingClientRect().width`),72);
    await snapshot('disabled');
    const control=()=>run(`document.querySelector('[aria-label="Slide selection"]').getBoundingClientRect().toJSON()`);
    const samples=()=>run(`({start:Math.round(currentSelection().start*48000),end:Math.round(currentSelection().end*48000),beat:component().memoizedProps.startBeat,custom:component().memoizedProps.customStartBeat})`);
    const reset=async()=>{await setRegion(4,6);await setRegion(5,7);await run('component().memoizedProps.onStartBeatChange(288000)');await pause();};
    await reset();await snapshot('neutral');
    // Drive actual component RAF callbacks with explicit elapsed timestamps while
    // stopped, so 30/60/120 Hz and Shift comparisons have exact timing.
    await run(`window.realRAF=requestAnimationFrame;window.realCAF=cancelAnimationFrame;window.realNow=performance.now.bind(performance);window.slideClock=realNow();window.slideFrames=new Map();window.slideFrameId=0;Object.defineProperty(performance,'now',{configurable:true,value:()=>slideClock});window.requestAnimationFrame=callback=>{slideFrames.set(++slideFrameId,callback);return slideFrameId};window.cancelAnimationFrame=id=>slideFrames.delete(id);window.stepSlide=ms=>{slideClock+=ms;const pending=[...slideFrames.values()];slideFrames.clear();pending.forEach(callback=>callback(slideClock));};void 0`);
    const step=async ms=>{await run(`stepSlide(${ms})`);await pause();};
    let lastPoint;
    const mouse=async(type,x,y,fine=false)=>{await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1,modifiers:fine?8:0});await pause();};
    const point=async displacement=>{const r=await control();return {x:r.x+r.width/2+displacement*(r.width-14)/2,y:r.y+r.height/2};};
    const begin=async(displacement,fine=false)=>{lastPoint=await point(displacement);await mouse('mouseMoved',lastPoint.x,lastPoint.y,fine);await mouse('mousePressed',lastPoint.x,lastPoint.y,fine);assert.equal(await run(`document.querySelector('[aria-label="Slide selection"]').hasPointerCapture(1)`),true);};
    const move=async(displacement,fine=false)=>{lastPoint=await point(displacement);await mouse('mouseMoved',lastPoint.x,lastPoint.y,fine);};
    const release=async()=>{await mouse('mouseReleased',lastPoint.x,lastPoint.y);assert.equal(await run(`document.querySelector('[aria-label="Slide selection"]').getAttribute('aria-valuenow')`),'0');};
    const velocity=async(fine=false)=>{const d=await run(`(parseFloat(document.querySelector('.slide-thumb').style.left)/50)-1`);const span=await run('audioDuration/component().memoizedProps.zoom');return Math.sign(d)*Math.max(0,Math.abs(d)-.08)/.92*span*48000*.25*(fine?.1:1);};
    const shape=async()=>{const s=await samples();assert.equal(s.end-s.start,96000);assert.equal(s.beat-s.start,48000);assert.equal(s.custom,true);return s;};
    for(const d of [0,.03,-.03]){await begin(d);await step(1000);assert.equal((await samples()).start,240000);await release();}
    for(const d of [-.54,.54]){await reset();await begin(d);const v=await velocity();await step(1000);assert.equal((await shape()).start,Math.round(240000+v));await release();const frozen=await samples();await step(2000);assert.deepEqual(await samples(),frozen,'Release stops immediately');}
    const positions=[];
    for(const count of [1,30,60,120]){await reset();await begin(.37);for(let i=0;i<count;i++)await step(1000/count);positions.push((await shape()).start);await release();}
    assert.ok(positions.every(p=>p===positions[0]),'Actual RAF component movement independent of frame count');
    await reset();await begin(.54);const v=await velocity();await step(500);const beforeShift=await samples();await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',shiftKey:true}))`);await pause();assert.deepEqual(await samples(),beforeShift,'Shift alone cannot jump the selection');await step(500);assert.equal((await shape()).start,Math.round(240000+v*.55));await snapshot('fine');await run(`window.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift'}))`);await pause();const afterShift=await samples();await step(0);assert.deepEqual(await samples(),afterShift);await release();
    // The viewport is captured for a hold; a new hold adopts the current zoom.
    await reset();await begin(1);const wide=await velocity();await step(100);const first=(await samples()).start;await run('component().memoizedProps.onZoomChange(60)');await pause();await step(100);assert.ok(Math.abs((await samples()).start-first-Math.round(wide*.1))<=1);await release();await reset();await begin(1);const narrow=await velocity();assert.ok(Math.abs(wide/narrow-60)<1e-8);await step(1000);assert.equal((await shape()).start,Math.round(240000+narrow));await release();
    // Sub-sample steps accumulate at a deliberately magnified viewport.
    await run('component().memoizedProps.onZoomChange(20000)');await pause();await reset();await begin(1,true);const tiny=await velocity(true);assert.ok(tiny/120<1);for(let i=0;i<120;i++)await step(1000/120);assert.equal((await shape()).start,Math.round(240000+tiny));await release();
    await run('component().memoizedProps.onZoomChange(1)');await pause();await reset();await begin(1);await step(10000);assert.equal((await shape()).start,frames-96000);await step(10000);await move(-1);const leftSpeed=await velocity();await step(1);assert.equal((await shape()).start,Math.round(frames-96000+leftSpeed*.001),'Reverse immediately at end');await step(10000);assert.equal((await shape()).start,0);await step(10000);await move(1);const rightSpeed=await velocity();await step(1);assert.equal((await shape()).start,Math.round(rightSpeed*.001),'Reverse immediately at start');await release();
    for(const reason of ['cancel','capture','blur','tab','save']) {
      await reset();await begin(.5,true);await step(100);const frozen=await samples();
      if(reason==='cancel')await run(`document.querySelector('[aria-label="Slide selection"]').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}))`);
      if(reason==='capture'){await run(`document.querySelector('[aria-label="Slide selection"]').releasePointerCapture(1)`);await mouse('mouseMoved',lastPoint.x+1,lastPoint.y,true);await run(`document.querySelector('[aria-label="Slide selection"]').dispatchEvent(new PointerEvent('lostpointercapture',{bubbles:true,pointerId:1}))`);}
      if(reason==='blur')await run(`window.dispatchEvent(new Event('blur'))`);
      if(reason==='tab')await click('Auto-Split');
      if(reason==='save')await click('Show sample save');
      await pause();await step(1000);assert.deepEqual(await samples(),frozen,reason);
      assert.equal(await run(`document.querySelector('[aria-label="Slide selection"]').getAttribute('aria-valuenow')`),'0');assert.equal(await run(`document.querySelector('[aria-label="Slide selection"]').dataset.fine`),'false');
      if(reason==='tab')await click('Loop / Sample');if(reason==='save')await click('Cancel sample export');await release();
    }
    const key=async(type,key,fine=false,repeat=false)=>{await run(`document.querySelector('[aria-label="Slide selection"]').dispatchEvent(new KeyboardEvent('${type}',{bubbles:true,key:'${key}',shiftKey:${fine},repeat:${repeat}}))`);await pause();};
    for(const direction of ['ArrowLeft','ArrowRight']){await reset();await key('keydown',direction);const speed=await velocity();await step(100);await key('keydown',direction,false,true);await step(100);assert.equal((await shape()).start,Math.round(240000+speed*.2));await key('keyup',direction);const frozen=await samples();await step(1000);assert.deepEqual(await samples(),frozen);}
    await reset();await key('keydown','ArrowRight',true);const speed=await velocity(true);await step(100);assert.equal((await shape()).start,Math.round(240000+speed*.1));await key('keyup','ArrowRight',true);
    // Unmount ends a captured pointer gesture and its RAF callback.
    await reset();await begin(.5);await step(100);const beforeUnmount=await samples();await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='RECORD').click()`);await pause();await step(1000);await run('window.requestAnimationFrame=realRAF;window.cancelAnimationFrame=realCAF;Object.defineProperty(performance,"now",{configurable:true,value:realNow});for(const callback of slideFrames.values())realRAF(callback);slideFrames.clear();void 0');await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='EDIT').click()`);await pause();await wait(`!!document.querySelector('[aria-label="Edit waveform"]') && !document.querySelector('main').inert`);await click('Loop / Sample');assert.deepEqual(await samples(),beforeUnmount);await release();

    // Real native input / real frames during live looping, with independent PCM.
    await reset();await click('Loop and play the selected region');
    // Observe actual rendered PCM, independently of the cursor formula.
    await run(`(async()=>{
      const code="class Tap extends AudioWorkletProcessor {process(inputs){if(inputs[0]?.[0])this.port.postMessage({clock:currentFrame/sampleRate,rate:sampleRate,data:Array.from(inputs[0][0])});return true}}registerProcessor('tap',Tap)";
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await audioClock.audioWorklet.addModule(url);URL.revokeObjectURL(url);
      window.tap=new AudioWorkletNode(audioClock,'tap');tap.port.onmessage=e=>{blocks.push(e.data);if(blocks.length>1000)blocks.shift();};tap.connect(audioClock.destination);sources.at(-1).node.connect(tap);
      window.alignment=()=>{const clock=lastHeard;const latest=sources.at(-1),prior=sources.at(-2);if(clock<latest.when&&(!prior||prior.until<latest.when-1e-8))return null;const block=[...blocks].reverse().find(b=>b.clock<=clock&&b.clock+b.data.length/b.rate>clock);if(!block)return null;const sample=block.data[Math.floor((clock-block.clock)*block.rate)];if(sample===0)return null;const index=(sample*32768-2000)/20000*${frames};return {cursor:component().memoizedProps.currentTime,pcm:index/${rate},clock};};
    })()`);
    let observed=0,maxError=0;
    const repeats = async () => {
      for (let i=0;i<12;i++) { await new Promise(r=>setTimeout(r,80)); const state=await run(`new Promise(resolve=>setTimeout(()=>resolve({playing:component().memoizedProps.isPlaying, looping:component().memoizedProps.isLooping, time:component().memoizedProps.currentTime, selection:currentSelection(), active:sources.filter(s=>s.active&&s.when<=s.ctx.currentTime&&(!s.until||s.until>s.ctx.currentTime)).length,alignment:alignment()}),5))`); assert.equal(state.playing,true); assert.equal(state.looping,true); assert.equal(state.active,1);
        if(state.alignment){const error=Math.abs(state.alignment.cursor-state.alignment.pcm);maxError=Math.max(maxError,error);observed++;assert.ok(error<.004,'Cursor vs actual PCM '+JSON.stringify(state.alignment));}
      }
    };
    await repeats();
    const liveHold=async(d,fine=false)=>{await begin(d,fine);for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,60));const state=await run(`({alignment:alignment(),rate:sources.at(-1).node.playbackRate.value})`);assert.equal(state.rate,1);if(state.alignment){const error=Math.abs(state.alignment.cursor-state.alignment.pcm);observed++;maxError=Math.max(maxError,error);assert.ok(error<.004,JSON.stringify(state.alignment));}}await release();await shape();await repeats();};
    await liveHold(.25);await liveHold(-.5,true);await snapshot('playing');
    assert.equal(await run(`sources.some((a,i)=>sources.slice(i+1).some(b=>Math.max(a.when,b.when)<Math.min(a.until??(a.when+(a.duration??Infinity)),b.until??(b.when+(b.duration??Infinity)))-1e-8))`),false,'Source intervals never overlap');
    assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'),rect);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await run(`document.querySelector('[aria-label="Slide selection"]').focus()`);await pause();assert.equal(await run(`getComputedStyle(document.querySelector('[aria-label="Slide selection"]')).outlineStyle`),'dashed');await snapshot('focus');
    await run('component().memoizedProps.onStop()');await pause();console.log('PASS: timed spring Slide, pointer/keyboard/Shift/dead zone, exact samples/clamps/reversal, cleanup, wider Tools and right-aligned Memory; PCM comparisons',observed,'maximum cursor error ms',maxError*1000);app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
