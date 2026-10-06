// Full production app at the actual desktop window size; no audio devices or disk exports.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build/export-layout-check');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
const preload = path.join(output, 'preload.cjs');
fs.writeFileSync(preload, `require('electron').contextBridge.exposeInMainWorld('electronAPI', {
  getExportFolder: async () => 'C:/A very long export folder/with a long nested path/and another long folder/for checking destination truncation',
  setExportFolder: async folder => folder, chooseExportFolder: async () => '', saveExportFile: async () => '', openExportFolder: async () => {}
});`);
app.whenReady().then(async () => {
  // Offscreen uses content dimensions: the 980x650 Windows window has a 967x589 client area.
  const win = new BrowserWindow({ show: false, width: 967, height: 589, webPreferences: { preload, offscreen: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async code => { const end = Date.now() + 15000; while (!await run(code)) { if (Date.now() > end) throw Error('Timed out: '+code); await new Promise(r => setTimeout(r, 40)); } };
  try {
    const rate = 44100, frames = rate * 20, wav = Buffer.alloc(44 + frames * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(frames*2,40);
    for(let i=0;i<frames;i++) wav.writeInt16LE(Math.round(10000*Math.sin(i*.08)),44+i*2);
    const file = path.join(output, 'layout.wav'); fs.writeFileSync(file,wav);
    await win.loadFile(path.join(root,'dist/index.html'));
    win.webContents.debugger.attach('1.3');
    const { root: documentRoot } = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:documentRoot.nodeId,selector:'input[type=file]'});
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[file]});
    await wait(`!!document.querySelector('[aria-label="Edit waveform"]') && !document.querySelector('main').inert`);
    await run(`(() => {
      const wave=document.querySelector('[aria-label="Edit waveform"]');let fiber=wave[Object.keys(wave).find(key=>key.startsWith('__reactFiber'))];while(fiber.return)fiber=fiber.return;
      const queue=[fiber.stateNode.current];while(queue.length){const f=queue.shift(),p=f.memoizedProps;if(p?.onAddMarker&&p?.onSelectionChange&&p?.audioBuffer){for(let i=1;i<20;i++)p.onAddMarker(i);break;}if(f.child)queue.push(f.child);if(f.sibling)queue.push(f.sibling);}
    })()`);
    await run(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='EXPORT').click()`);
    await wait(`!!document.getElementById('export-artist') && document.querySelector('[aria-label="Export pagination"]').textContent.includes('1 / 2')`);
    const result = await run(`(async()=>{
      const pause=()=>new Promise(r=>setTimeout(r,80));
      const edit=(id,value)=>{const input=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
      const controls=document.querySelector('[aria-label="Export controls"]');
      const table=document.querySelector('[role="table"]');
      const pagination=document.querySelector('[aria-label="Export pagination"]');
      const box=e=>e.getBoundingClientRect().toJSON();
      const info=document.querySelector('[aria-label="Recording info"]');
      if(info.getBoundingClientRect().bottom>=controls.getBoundingClientRect().top)throw Error('Recording info must be above Export panel with a gap');
      if(info.querySelectorAll('input[type="text"]').length!==3||info.querySelectorAll('input[type="checkbox"]').length!==0)throw Error('Recording info controls missing');
      if(controls.querySelector('h3')?.textContent!=='Export')throw Error('Missing Export heading');
      const bounds=box(controls),tableBounds=box(table);
      const left=box(table.closest('fieldset')),sidebar=box(document.querySelector('[aria-label="Export sidebar"]'));
      if(sidebar.left<=left.right||sidebar.top!==left.top||sidebar.bottom!==left.bottom)throw Error('Sidebar must align beside left workspace');
      for(const el of controls.querySelectorAll('input,select,button,[role="status"]')){const r=box(el);if(r.left<bounds.left||r.right>bounds.right||r.top<bounds.top||r.bottom>bounds.bottom)throw Error('Control exceeds Export panel');}
      const header=document.querySelector('header');
      if(header&&left.top-header.getBoundingClientRect().bottom>12)throw Error('Export header gap exceeds 12px');
      const button=controls.querySelector('[aria-label="Export selected tracks"]'),status=controls.querySelector('[role="status"]');
      const action=box(button),statusBox=box(status);
      if(!controls.querySelector('label[title]').title.includes('track'+String.fromCharCode(8217)+'s metadata'))throw Error('Embedding tooltip incorrect');
      if(statusBox.top<action.bottom||Math.abs(statusBox.bottom-(bounds.bottom-11))>1)throw Error('Export information not anchored at bottom: '+JSON.stringify({statusBox,bounds,action}));
      for(const input of controls.querySelectorAll('input,select')){const label=input.closest('label')?.textContent;if(label==='Open folder after export'){if(box(input).top<action.bottom||box(input).bottom>statusBox.top)throw Error('Automatic opening checkbox misplaced');}else if(box(input).bottom>action.top)throw Error('Setting below Export button');}
      const artistHeader=document.querySelectorAll('[role="columnheader"]')[3],preview=document.querySelector('[aria-label="Metadata preview heading"]');
      if(Math.abs(box(artistHeader).left-box(preview).left)>1)throw Error('Metadata preview heading misaligned');
      const initial={controls:box(controls),table:box(table),pagination:box(pagination),info:box(info)};
      if(document.querySelectorAll('[role="row"]').length!==14)throw Error('Expected 13 visible tracks on first page');
      for(const label of ['Artist','Album']){const input=[...document.querySelectorAll('label')].find(el=>el.textContent===label&&el.querySelector('input[type=checkbox]'))?.querySelector('input');if(!input||input.checked)throw Error('Filename metadata must default off');input.click();}await pause();
      edit('export-artist','An artist with a very long name '.repeat(5));edit('export-album','An album with a very long name '.repeat(5));edit('export-genre','A long genre description '.repeat(5));await pause();
      document.querySelector('[aria-label="Next page"]').click();await pause();
      if(!pagination.textContent.includes('2 / 2'))throw Error('Multiple-page navigation failed');
      const later={controls:box(controls),table:box(table),pagination:box(pagination),info:box(info)};
      if(JSON.stringify(initial)!==JSON.stringify(later))throw Error('Editing or final page shifted layout');
      const main=document.querySelector('main').getBoundingClientRect();
      for(const el of controls.querySelectorAll('input,select,button,[role="status"],[aria-label]')){
        const r=el.getBoundingClientRect();if(r.left<main.left||r.right>main.right||r.bottom>main.bottom)throw Error('Control exceeds fixed application workspace');
      }
      for(const el of document.querySelectorAll('main *')){const style=getComputedStyle(el);if(['auto','scroll'].includes(style.overflowY)&&el.scrollHeight>el.clientHeight)throw Error('Vertical scrollbar');if(['auto','scroll'].includes(style.overflowX)&&el.scrollWidth>el.clientWidth)throw Error('Horizontal scrollbar');}
      const rows=[...document.querySelectorAll('[role="row"]')].slice(1);
      for(const row of rows){if(row.getBoundingClientRect().height<26)throw Error('Track rows too cramped');const cells=[...row.children].map(box);if(cells.some(cell=>Math.abs((cell.top+cell.height/2)-(cells[0].top+cells[0].height/2))>1))throw Error('Filename and metadata misaligned');}
      return {window:[innerWidth,innerHeight],...later,tracks:document.querySelector('[role="status"]').textContent};
    })()`);
    assert.equal(result.tracks.includes('20 of 20'),true);
    await new Promise(r=>setTimeout(r,200));
    fs.writeFileSync(path.join(output,'export-layout.png'),(await win.webContents.capturePage()).toPNG());
    console.log('PASS: full production app at 980x650; long metadata/path, aligned rows, final page, fixed groups and no scrollbars',JSON.stringify(result));
    app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
