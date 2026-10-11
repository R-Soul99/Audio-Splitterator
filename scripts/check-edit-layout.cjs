// Fixed-size native layout review and edit interactions. --baseline captures approved main.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const baseline = process.argv.includes('--baseline');
const build = path.join(__dirname, '../build');
fs.mkdirSync(build, { recursive: true });
app.setPath('userData', path.join(build, 'edit-layout-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, autoHideMenuBar: true, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code).catch(e=>{console.error('Renderer code:',code);throw e;});
  const pause = (ms = 80) => new Promise(r => setTimeout(r, ms));
  const wait = async code => { const end = Date.now() + 20000; while (!await run(code)) { if (Date.now() > end) throw Error(code); await pause(30); } };
  const click = async label => { await run(`(document.querySelector('[aria-label="${label}"]') || [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${label}')).click()`); await pause(); };
  const capture = async name => { fs.writeFileSync(path.join(build, `edit-layout-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
    await click('EDIT');
    await run(`
      window.wave=()=>document.querySelector('[aria-label="Edit waveform"]');
      window.props=()=>{let f=wave()[Object.keys(wave()).find(k=>k.startsWith('__reactFiber'))];while(f.return)f=f.return;const queue=[f.stateNode.current];while(queue.length){const n=queue.shift();if(n.memoizedProps?.onAutoSplit&&n.memoizedProps?.onSelectionChange)return n.memoizedProps;if(n.child)queue.push(n.child);if(n.sibling)queue.push(n.sibling);}};
      window.rect=e=>e.getBoundingClientRect().toJSON();
      window.geometry=()=>({wave:rect(wave()),overview:rect(document.querySelector('[aria-label="Waveform overview"]')||[...document.querySelectorAll('canvas')].find(c=>c.getBoundingClientRect().height===26)),toolbar:rect(document.querySelector('[aria-label="Waveform editing toolbar"]')),panel:rect(document.querySelector('[aria-label="Tools"]').parentElement),buttons:[...document.querySelector('[aria-label="Waveform editing toolbar"]').querySelectorAll('button')].map(b=>({w:rect(b).width,h:rect(b).height,dx:rect(b).x-rect(document.querySelector('[aria-label="Waveform editing toolbar"]')).x,label:b.getAttribute('aria-label')||b.title||b.textContent}))});
      void 0;
    `);
    const geometry = () => run('geometry()');
    const oldPath = path.join(__dirname, 'edit-layout-baseline.json');
    if (baseline) { fs.writeFileSync(oldPath, JSON.stringify(await geometry())); console.log('PASS: captured approved-main dimensions and intact transport control geometry'); app.exit(0); return; }
    const old = JSON.parse(fs.readFileSync(oldPath));
    const expected = await geometry();
    for (const key of ['wave', 'overview']) {
      assert.equal(expected[key].width, old[key].width, key+' width');
      assert.equal(expected[key].height, old[key].height, key+' height');
    }
    assert.equal(expected.panel.height,98);
    assert.equal(expected.toolbar.height,42);
    assert.ok(expected.panel.y>77, "Display shifted below chassis label");
    assert.deepEqual(expected.buttons.map(b=>b.label),old.buttons.filter(b=>b.label!=='Play the selected region once').map(b=>b.label));
    assert.ok(expected.buttons.every(b=>b.w===24&&b.h===24));
    assert.ok(expected.panel.bottom < expected.wave.top);
    assert.ok(expected.toolbar.top > expected.overview.bottom);
    const stable = async () => {
      assert.deepEqual(await geometry(), expected, 'No panel/waveform/overview movement');
      assert.equal(await run(`document.documentElement.scrollHeight>innerHeight`), false);
      assert.equal(await run(`!!document.querySelector('[aria-label="Zoom horizontal in"],[aria-label="Reset horizontal zoom"],[aria-label="Zoom horizontal out"]')`), false);
      assert.equal(await run(`document.querySelector('[aria-label="Tools"]').querySelectorAll('[aria-label="Chop"],[aria-label="Volume"]').length`), 0);
      assert.equal(await run(`document.querySelector('[aria-label="Waveform readouts"]').querySelectorAll('[aria-label="Chop"],[aria-label="Auto-Chop"],[aria-label="Volume"]').length`), 3);
      const clipping = await run(`(()=>{const host=document.querySelector('[aria-label="Tools"]'),r=host.getBoundingClientRect();return [...host.querySelectorAll('button,output,[role=slider]')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').some(e=>{const b=e.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1||b.top<r.top-1||b.bottom>r.bottom+1;});})()`);
      assert.equal(clipping,false,'Top tool controls fit');
    };
    await stable(); await capture('empty-chop');
    assert.equal(await run(`document.querySelector('[aria-label="Chop"]').disabled`),true);
    assert.equal(await run(`document.querySelector('[aria-label="Play"]').disabled`),true);
    await click('Auto-Chop'); await stable(); await capture('empty-auto-chop');
    assert.equal(await run(`document.querySelector('.detection-apply').disabled`),true);
    await click('Volume'); await stable(); await capture('empty-volume');
    assert.equal(await run(`document.querySelector('.volume-primary').disabled`),true);
    await run(`
      window.FileReader=class{readAsArrayBuffer(){this.result=new ArrayBuffer(8);this.onload();}};
      AudioContext.prototype.decodeAudioData=function(){const b=new AudioBuffer({length:48000*20,sampleRate:48000,numberOfChannels:2});for(let c=0;c<2;c++){b.getChannelData(c).fill(.1);b.getChannelData(c).fill(.001,48000*5,48000*7);b.getChannelData(c).fill(.001,48000*12,48000*14);}return Promise.resolve(b);};
      const input=document.querySelector('input[type=file]'),d=new DataTransfer();d.items.add(new File(['fixture'],'layout-review.wav'));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));void 0;
    `);
    await wait(`props().audioBuffer && !document.querySelector('main').inert`);
    await wait(`!document.body.textContent.includes('Building waveform')`);
    await pause(500); await stable(); await capture('loaded-volume');
    await click('Volume'); await click('Chop'); await stable(); await capture('loaded-chop');
    win.show();win.focus();await pause(200);
    win.webContents.debugger.attach('1.3');
    let heldButtons=0;
    const pointer = async (type,x,y,button='left') => { if(type==='mousePressed')heldButtons=button==='right'?2:1;if(type==='mouseReleased')heldButtons=0;await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':button,buttons:heldButtons,clickCount:1}); await pause(); };
    let w=(await geometry()).wave;
    await pointer('mouseMoved',w.left+w.width*.45,w.top+w.height*.7);
    await pointer('mousePressed',w.left+w.width*.45,w.top+w.height*.7);
    await pointer('mouseReleased',w.left+w.width*.45,w.top+w.height*.7);
    await wait('props().markers.length===1');
    const markerTime = await run('props().markers[0].time');
    const mx=w.left+w.width*markerTime/20;
    await pointer('mouseMoved',mx,w.top+w.height*.7);
    await pointer('mousePressed',mx,w.top+w.height*.7,'right');await pointer('mouseReleased',mx,w.top+w.height*.7,'right');
    await wait('props().markers.length===0');
    await click('Chop'); await click('Auto-Chop'); await stable();
    // Native quiet-region drag remains available in detection view without audition.
    await pointer('mousePressed',w.left+w.width*5.2/20,w.top+w.height*.7);
    await pointer('mouseMoved',w.left+w.width*5.9/20,w.top+w.height*.7);
    await pointer('mouseReleased',w.left+w.width*5.9/20,w.top+w.height*.7);
    await wait('props().selection && props().selection.end-props().selection.start>.5');
    assert.equal(await run('props().isPlaying'),false);
    await click('Detect noise floor');await wait(`document.querySelector('[aria-label="Noise floor in dB"]').textContent==='-57.0 dB'`);
    await run(`var k=document.querySelector('[aria-label="Noise floor"]');k[Object.keys(k).find(x=>x.startsWith('__reactProps'))].onKeyDown({key:'Home',preventDefault(){}});void 0;`);
    await click('Detect noise floor in Auto-Chop');await wait(`document.querySelector('[aria-label="Noise floor in dB"]').textContent==='-57.0 dB'`);
    await wait(`document.querySelector('.detection-counts strong').textContent==='2'`);await capture('loaded-auto-chop');
    await click('Apply');await wait('props().markers.length===2');await click('Undo');await wait('props().markers.length===0');
    const gap=await run(`document.querySelector('[aria-label="Minimum silence"]').getAttribute('aria-valuenow')`);
    await run(`var k=document.querySelector('[aria-label="Minimum silence"]');k[Object.keys(k).find(x=>x.startsWith('__reactProps'))].onKeyDown({key:'ArrowUp',shiftKey:true,preventDefault(){}});void 0;`);
    assert.ok(Math.abs(Number(await run(`document.querySelector('[aria-label="Minimum silence"]').getAttribute('aria-valuenow')`))-Number(gap)-.01)<1e-9,'Shift fine adjustment');
    await click('Volume'); await stable();
    await click('Play'); await wait('props().isPlaying'); await click('Pause');assert.equal(await run('props().isPlaying'),false);await click('Return to start');
    // Overview handles retain zoom, sliding navigation and double-click reset.
    let mini=await run(`rect([...document.querySelectorAll('canvas')].find(c=>c.getBoundingClientRect().height===26))`);
    await pointer('mousePressed',mini.right-3,mini.top+12);await pointer('mouseMoved',mini.left+mini.width*.6,mini.top+12);await pointer('mouseReleased',mini.left+mini.width*.6,mini.top+12);
    await wait('props().zoom>1');
    await pointer('mousePressed',mini.left+mini.width*.3,mini.top+12);await pointer('mouseMoved',mini.left+mini.width*.45,mini.top+12);await pointer('mouseReleased',mini.left+mini.width*.45,mini.top+12);
    assert.ok(await run('props().viewOffsetSec>0'));
    await run(`[...document.querySelectorAll('canvas')].find(c=>c.getBoundingClientRect().height===26).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await wait('props().zoom===1');
    await click('Zoom waveform vertically in');await click('Reset vertical zoom');await stable();
    assert.deepEqual(errors,[],'No renderer errors');
    console.log('PASS: fixed 980x650 layout, preserved waveform/overview/display sizes and compact toolbar, three modes empty/loaded, no clipping/movement, Chop add/right-remove, native quiet selection, shared Detect, Auto-Chop Apply/Undo, Shift fine, transport, overview zoom/pan/reset, vertical zoom, disabled states');app.exit(0);
  } catch(e) { console.error(e,errors); app.exit(1); }
});
