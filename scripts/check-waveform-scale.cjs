// Production UI regression with native pointer input and the real import/selection handlers.
// Run after npm run build: electron scripts/check-waveform-scale.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = path.join(__dirname, '../build', 'waveform-scale-regression-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code);
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
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) wav.writeInt16LE(Math.round(32767 * (i < rate*10 ? (c ? .48 : .96) : (c ? .01 : .02)) * Math.sin(i * (c ? 0.12 : 0.08))), 44 + i * 4 + c * 2);
    const file = path.join(app.getPath('temp'), 'waveform-scale-regression.wav'); fs.writeFileSync(file, wav);
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
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

    const click = async label => {await run(`document.querySelector('[aria-label="${label}"]').click()`);await pause();};
    const rect=await run('wave().getBoundingClientRect().toJSON()');
    const original=await run(`component().memoizedProps.audioBuffer.getChannelData(0).reduce((sum,v)=>sum+v*v,0)`);
    const measure = async () => run(`(()=>{
      const canvas=wave(),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,data=ctx.getImageData(0,0,w,h).data;
      const ranges=x=>[0,1].map(c=>{const ys=[];for(let y=c*h/2;y<(c+1)*h/2;y++){const i=(Math.floor(y)*w+Math.floor(x))*4;if(data[i+1]>45&&data[i+1]>data[i]*3&&data[i+1]>data[i+2]*1.15)ys.push(y);}return {min:Math.min(...ys),max:Math.max(...ys)};});
      const guides=[];for(let y=0;y<h;y++){let count=0;for(let x=Math.floor(w*.08);x<w*.5;x++){const i=(y*w+x)*4;if(data[i]>35&&data[i]>data[i+1]*1.2&&data[i+1]>data[i+2]*1.4)count++;}if(count>w*.05)guides.push(y);}
      return {w,h,full:ranges(w*.25),quiet:ranges(w*.75),guides};
    })()`);
    const check = async zoom => {
      assert.equal(Number(await run('wave().dataset.verticalZoom')),zoom);
      const m=await measure(),lane=m.h/2;
      for(let c=0;c<2;c++){
        const center=(c+.5)*lane,peak=c?.48:.96;
        for(const [edge,sign] of [['min',-1],['max',1]]){
          assert.ok(Math.abs(m.full[c][edge]-(center+sign*peak*lane*.48*zoom))<=2,JSON.stringify({zoom,c,edge,...m}));
          assert.ok(Math.abs(m.quiet[c][edge]-(center+sign*(c?.01:.02)*lane*.48*zoom))<=2,JSON.stringify({zoom,c,edge,...m}));
          const expected=center+sign*lane*.48*zoom;
          assert.ok(m.guides.some(y=>Math.abs(y-expected)<=1),JSON.stringify({expected,...m}));
        }
      }
      assert.deepEqual(await run('wave().getBoundingClientRect().toJSON()'),rect);
      return m;
    };
    const shot=async name=>{await win.webContents.capturePage();await pause();fs.writeFileSync(path.join(__dirname,`../build/waveform-scale-${name}.png`),(await win.webContents.capturePage()).toPNG());};
    await check(1);await shot('default');
    await click('Zoom waveform vertically out');await check(.8);await shot('reduced');
    await click('Reset vertical zoom');await check(1);
    await click('Zoom waveform vertically in');
    assert.equal(Number(await run('wave().dataset.verticalZoom')),1.25);await shot('increased');
    const increased=await measure();assert.ok(increased.quiet[0].max-increased.quiet[0].min>=2);
    assert.ok(Math.abs(increased.full[0].max-increased.full[0].min-increased.h/2*.96)<=3,'Magnified full-scale peaks clip symmetrically at channel margins');
    assert.equal(increased.guides.length,0,'Offscreen full-scale guides are not falsely labelled at channel edges');
    await click('Reset vertical zoom');await check(1);await shot('reset');
    await run('component().memoizedProps.onZoomChange(2);component().memoizedProps.onViewOffsetChange(10);void 0');await pause();await shot('quiet');
    for(let i=0;i<8;i++)await click('Zoom waveform vertically in');
    await shot('quiet-magnified');
    assert.equal(await run(`component().memoizedProps.audioBuffer.getChannelData(0).reduce((sum,v)=>sum+v*v,0)`),original,'Display zoom never changes audio');
    await run(`document.querySelector('input[type=file]').value=''`);
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[file]});
    await wait(`!document.querySelector('main').inert && Number(wave().dataset.verticalZoom)===1`);
    await check(1);
    console.log('PASS: default/reset/reimport unity; reduced and increased zoom; fixed stereo full-scale/quiet sample mapping and guides; no peak normalisation or source mutation; fixed waveform dimensions');
    app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
