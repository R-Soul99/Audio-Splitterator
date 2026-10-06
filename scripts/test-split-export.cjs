// Production-renderer regression test: node scripts/test-split-export.cjs
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'build/split-export-test');
const output = path.join(fixture, 'dist');

async function run() {
  if (!process.argv.includes('--electron')) {
    await fs.mkdir(fixture, { recursive: true });
    await fs.writeFile(path.join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="./fixture.tsx"></script>');
    await fs.writeFile(path.join(fixture, 'fixture.tsx'), `
      import React from 'react';
      import '../../src/index.css';
      import { createRoot } from 'react-dom/client';
      import { SplitsManager } from '../../src/components/SplitsManager';
      localStorage.clear();
      const state = window as any;
      state.saved = []; state.alerts = []; state.opened = []; state.folderPicks = 0;
      document.body.style.cssText = 'margin:0;background:#020617';
      document.getElementById('root').style.cssText = 'height:503px;width:943px';
      window.alert = message => state.alerts.push(message);
      state.electronAPI = {
        openExportFolder: async segments => { state.opened.push(segments); },
        getExportFolder: async () => 'C:/A very long export destination path/with many folders/that exceeds the available visual path width/test-output',
        chooseExportFolder: async () => { state.folderPicks++; return 'C:/A very long export destination path/with many folders/that exceeds the available visual path width/chosen'; },
        saveExportFile: async file => { await new Promise(resolve => setTimeout(resolve, 80)); if (state.failSave) throw Error('An intentionally long export failure message that must remain within the fixed status area without shifting any controls'); state.saved.push(file); return file.name; }
      };
      const buffer = new AudioBuffer({ length: 88200, numberOfChannels: 2, sampleRate: 44100 });
      for (let c = 0; c < 2; c++) for (let i = 0; i < buffer.length; i++)
        buffer.getChannelData(c)[i] = 0.4 * Math.sin(2 * Math.PI * (c ? 660 : 440) * i / 44100);
      state.sourceBuffer = buffer;
      createRoot(document.getElementById('root')).render(<SplitsManager
        sourceBuffer={buffer} mainFileName="test" onSeekTo={() => {}}
        preRecordArtist="Test Artist" preRecordAlbum="Test Album"
        fadeSettings={{ fadeInEnabled: false, fadeOutEnabled: false, zeroCrossing: false }}
        splits={Array.from({length:19}, (_, i) => i).map(i => ({ id: String(i), index: i + 1, trackNumber: i + 1,
          name: 'Track ' + (i + 1), startTime: i % 2, endTime: i % 2 + 1, duration: 1 }))} />);
    `);
    const { build } = await import('vite');
    await build({ root, build: { outDir: output, emptyOutDir: true,
      rollupOptions: { input: path.join(fixture, 'index.html') } } });
    const { spawnSync } = require('node:child_process');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename, '--electron'], { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Electron export regression failed');
    return;
  }
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: {
    nodeIntegration: false, contextIsolation: true, webSecurity: true
  } });
  try {
    const html = path.join(output, 'build/split-export-test/index.html');
    await win.loadFile(html);
    // Model rebuilding dist while this renderer remains open. Already loaded
    // code must still export; a deferred hashed encoder import would now fail.
    const assets = path.join(output, 'assets');
    for (const name of await fs.readdir(assets)) {
      if (name.endsWith('.js')) await fs.unlink(path.join(assets, name));
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = async predicate => {
        const deadline = Date.now() + 30000;
        while (!predicate()) { if (Date.now() > deadline) throw Error('Export timed out: ' + window.alerts); await new Promise(r => setTimeout(r, 25)); }
      };
      await waitFor(() => document.body.textContent.includes('Ready to export') && ![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export')?.disabled);
      const click = text => {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
        if (!button) throw Error('Missing button: ' + text); button.click();
      };
      const tick = label => [...document.querySelectorAll('label')].find(l => l.textContent.includes(label) && l.querySelector('input[type=checkbox]')).querySelector('input');
      const change = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const pause = () => new Promise(r => setTimeout(r, 50));
      const all = document.querySelector('[aria-label="Select all tracks across all pages"]');
      const exportButton = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export');
      const initialBottom = exportButton().getBoundingClientRect().top;
      const chooseFolder=document.querySelector('[aria-label="Choose export folder"]');
      if(chooseFolder.title!=='Choose export folder')throw Error('Folder tooltip missing');
      chooseFolder.click();await pause();
      if(window.folderPicks!==1||!document.querySelector('[aria-label="Export destination"]').title.endsWith('/chosen'))throw Error('Folder icon picker did not update destination');
      if(!tick('Track no.').checked||tick('Artist').checked||tick('Album').checked)throw Error('Fresh filename defaults incorrect');
      tick('Artist').click();tick('Album').click();await pause();
      document.querySelector('[aria-label="Next page"]').click(); await pause();
      change(document.querySelector('[aria-label="Title for track 14"]'), 'Edited title');
      document.querySelector('[aria-label="Export track 14"]').click(); await pause();
      if (!all.indeterminate) throw Error('Missing mixed selection');
      if (!document.querySelector('[aria-label="Next page"]').disabled) throw Error('Final navigation enabled');
      document.querySelector('[aria-label="Previous page"]').click(); await pause();
      document.querySelector('[aria-label="Next page"]').click(); await pause();
      if (document.querySelector('[aria-label="Title for track 14"]').value !== 'Edited title') throw Error('Title edit lost');
      if (document.querySelector('[aria-label="Export track 14"]').checked) throw Error('Selection lost');
      change(document.getElementById('export-artist'), 'Updated Artist'); change(document.getElementById('export-album'), 'Updated Album'); change(document.getElementById('export-genre'), 'Jazz'); await pause();
      if (!document.body.textContent.includes('Updated Artist - Updated Album - Edited title.flac')) throw Error('Filename not updated');
      all.click(); await pause(); all.click(); await pause();
      if (document.body.textContent.includes('19 of 19 tracks selected')) throw Error('Global clear failed');
      document.querySelector('[aria-label="Export track 14"]').click(); await pause();
      document.querySelector('[aria-label="Previous page"]').click(); await pause();
      document.querySelector('[aria-label="Export track 1"]').click(); await pause();
      tick('Save in Artist/Album folders').click(); tick('Show exported files after export').click(); await pause();
      click('Export'); await waitFor(() => window.opened.length === 1);
      if (window.saved.length !== 2 || !window.saved[0].name.startsWith('01') || !window.saved[1].name.includes('Edited title')) throw Error('Export omitted other page');
      if (window.opened[0].join('/') !== 'Updated Artist/Updated Album') throw Error('Wrong opened folder');
      if (!new TextDecoder().decode(window.saved[0].data).includes('GENRE=Jazz')) throw Error('Missing shared genre');
      if (exportButton().getBoundingClientRect().top !== initialBottom) throw Error('Layout shifted');
      for (const el of document.querySelectorAll('#root *')) {
        const css = getComputedStyle(el);
        if (['auto', 'scroll'].includes(css.overflowY) && el.scrollHeight > el.clientHeight) throw Error('Panel scrollbar');
      }
      all.click(); await pause(); all.click(); await pause();
      document.querySelector('[aria-label="Previous page"]').click(); await pause();
      document.querySelector('[aria-label="Export track 1"]').click(); document.querySelector('[aria-label="Export track 2"]').click(); await pause();
      tick('Show exported files after export').click();
      const fade = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Micro fade'));
      fade.querySelector('input').click();
      const checks = [];
      for (const [format, depth] of [['flac',16], ['flac',24], ['wav',16], ['wav',24], ['mp3',16]]) {
        window.saved = [];
        const select = document.querySelector('select');
        select.value = format; select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        if (format !== 'mp3') { const depthSelect = document.querySelector('[aria-label="Bit depth"]'); depthSelect.value = String(depth); depthSelect.dispatchEvent(new Event('change', { bubbles: true })); }
        await new Promise(r => setTimeout(r, 50));
        click('Export');
        await waitFor(() => window.saved.length === 2 || window.alerts.length > 0);
        if (window.alerts.length) throw Error(window.alerts.join('; '));
        const ctx = new AudioContext({ sampleRate: 44100 });
        for (const [i, file] of window.saved.entries()) {
          if (!file.name.endsWith('.' + format)) throw Error('Wrong filename');
          if (!new TextDecoder().decode(file.data).includes('Updated Artist')) throw Error('Missing tags');
          const audio = await ctx.decodeAudioData(file.data.slice().buffer);
          if (audio.numberOfChannels !== 2 || audio.sampleRate !== 44100) throw Error('Channel/rate mismatch');
          if (format !== 'mp3') {
            if (audio.length !== 44100) throw Error('Slice length mismatch: ' + audio.length);
            for (let c = 0; c < 2; c++) {
              const actual = audio.getChannelData(c), expected = window.sourceBuffer.getChannelData(c);
              let maxError = 0;
              for (let s = 0; s < actual.length; s++) maxError = Math.max(maxError, Math.abs(actual[s] - expected[i * 44100 + s]));
              if (maxError > (depth === 16 ? 0.00004 : 0.0000002)) throw Error('PCM mismatch: ' + maxError);
            }
          }
          checks.push({ format, depth, name: file.name, frames: audio.length, bytes: file.data.length });
        }
        await ctx.close();
        await waitFor(() => ![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export').disabled);
      }
      tick('Embed metadata').click(); await pause();
      window.saved = []; click('Export');
      await waitFor(() => window.saved.length === 2 && !exportButton().disabled);
      if (!window.saved[0].name.includes('Updated Artist - Updated Album')) throw Error('Tags toggle changed filename');
      if (new TextDecoder().decode(window.saved[0].data).includes('Updated Artist')) throw Error('Tags were not disabled');
      tick('Artist').click();tick('Album').click();tick('Embed metadata').click();await pause();
      window.saved=[];click('Export');await waitFor(()=>window.saved.length===2&&!exportButton().disabled);
      if(window.saved[0].name.includes('Updated Artist')||window.saved[0].name.includes('Updated Album'))throw Error('Embedding changed filename inclusion');
      if(!new TextDecoder().decode(window.saved[0].data).includes('Updated Artist'))throw Error('Filename inclusion changed embedding');
      tick('Artist').click();tick('Album').click();tick('Embed metadata').click();await pause();
      const longArtist = 'Long Artist name '.repeat(8);
      const longAlbum = 'Long Album name '.repeat(8);
      const longGenre = 'Long Genre '.repeat(8);
      change(document.getElementById('export-artist'), longArtist);
      change(document.getElementById('export-album'), longAlbum);
      change(document.getElementById('export-genre'), longGenre); await pause();
      if (document.getElementById('export-artist').disabled) throw Error('Shared fields disabled with tags off');
      const firstRow = document.querySelectorAll('[role="row"]')[1];
      if (!firstRow.children[1].textContent.includes(longArtist.trim()) || firstRow.children[3].textContent !== longArtist || firstRow.children[5].textContent !== longAlbum || firstRow.children[6].textContent !== longGenre) throw Error('Direct metadata preview update failed');
      const pathField = document.querySelector('[aria-label="Export destination"]');
      if (pathField.title.length < 80 || pathField.scrollWidth <= pathField.clientWidth) throw Error('Long path not truncated with tooltip');
      if (document.querySelector('dialog') || [...document.querySelectorAll('button')].some(button => button.textContent.includes('Edit'))) throw Error('Removed metadata dialogue still present');
      window.saved = []; click('Export');
      await waitFor(() => window.saved.length === 2 && !exportButton().disabled);
      if (!window.saved[0].name.includes(longArtist.trim()) || window.saved[0].segments[0] !== longArtist.trim() || window.saved[0].segments[1] !== longAlbum.trim()) throw Error('Long shared metadata not used for filenames/folders');
      window.failSave = true;
      click('Export'); await pause();
      if (exportButton().getBoundingClientRect().top !== initialBottom) throw Error('Progress moved action');
      await waitFor(() => !exportButton().disabled && document.querySelector('[role="status"]').textContent.includes('Export failed'));
      if (exportButton().getBoundingClientRect().top !== initialBottom) throw Error('Error moved action');
      window.failSave = false;
      if (exportButton().getBoundingClientRect().top !== initialBottom) throw Error('Long metadata changed action position');
      const rootBounds = document.getElementById('root').getBoundingClientRect();
      for (const el of document.querySelectorAll('[role="row"], fieldset, [role="status"], [aria-label="Recording info"], [aria-label="Output settings"], [aria-label="Export options"]')) {
        const box = el.getBoundingClientRect();
        if (box.bottom > rootBounds.bottom + 1 || box.right > rootBounds.right + 1) throw Error('Layout exceeds fixed workspace');
      }
      return checks;
    })()`);
    await fs.writeFile(path.join(fixture, 'export-panel.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(result.length, 10);
    console.log('PASS: production file:// split export, FLAC/WAV 16/24-bit and MP3; tags, decoding, stereo, rate, lossless PCM and boundaries; pagination, shared metadata, global selection, cross-page export, fixed layout and folder-open request');
    console.log(JSON.stringify(result, null, 2));
  } finally { win.destroy(); app.quit(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; if (process.argv.includes('--electron')) require('electron').app.exit(1); });
