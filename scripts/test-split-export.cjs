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
      import { createRoot } from 'react-dom/client';
      import { SplitsManager } from '../../src/components/SplitsManager';
      const state = window as any;
      state.saved = []; state.alerts = [];
      window.alert = message => state.alerts.push(message);
      state.electronAPI = {
        getExportFolder: async () => 'test-output',
        chooseExportFolder: async () => 'test-output',
        saveExportFile: async file => { state.saved.push(file); return file.name; }
      };
      const buffer = new AudioBuffer({ length: 88200, numberOfChannels: 2, sampleRate: 44100 });
      for (let c = 0; c < 2; c++) for (let i = 0; i < buffer.length; i++)
        buffer.getChannelData(c)[i] = 0.4 * Math.sin(2 * Math.PI * (c ? 660 : 440) * i / 44100);
      state.sourceBuffer = buffer;
      createRoot(document.getElementById('root')).render(<SplitsManager
        sourceBuffer={buffer} mainFileName="test" onSeekTo={() => {}}
        preRecordArtist="Test Artist" preRecordAlbum="Test Album"
        fadeSettings={{ fadeInEnabled: false, fadeOutEnabled: false, zeroCrossing: false }}
        splits={[0, 1].map(i => ({ id: String(i), index: i + 1, trackNumber: i + 1,
          name: 'Track ' + (i + 1), startTime: i, endTime: i + 1, duration: 1 }))} />);
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
  const win = new BrowserWindow({ show: false, webPreferences: {
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
      await waitFor(() => document.body.textContent.includes('Ready to export') && !document.querySelector('button:disabled'));
      const click = text => {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
        if (!button) throw Error('Missing button: ' + text); button.click();
      };
      const fade = [...document.querySelectorAll('label')].find(l => l.title.includes('micro fade'));
      fade.querySelector('input').click();
      const checks = [];
      for (const [format, depth] of [['flac',16], ['flac',24], ['wav',16], ['wav',24], ['mp3',16]]) {
        window.saved = [];
        const select = document.querySelector('select');
        select.value = format; select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        if (format !== 'mp3') click(depth + '-bit');
        await new Promise(r => setTimeout(r, 50));
        click('Export Selected');
        await waitFor(() => window.saved.length === 2 || window.alerts.length > 0);
        if (window.alerts.length) throw Error(window.alerts.join('; '));
        const ctx = new AudioContext({ sampleRate: 44100 });
        for (const [i, file] of window.saved.entries()) {
          if (!file.name.endsWith('.' + format)) throw Error('Wrong filename');
          if (!new TextDecoder().decode(file.data).includes('Test Artist')) throw Error('Missing tags');
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
        await waitFor(() => ![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export Selected').disabled);
      }
      return checks;
    })()`);
    assert.equal(result.length, 10);
    console.log('PASS: production file:// split export, FLAC/WAV 16/24-bit and MP3; tags, decoding, stereo, rate, lossless PCM and boundaries');
    console.log(JSON.stringify(result, null, 2));
  } finally { win.destroy(); app.quit(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; if (process.argv.includes('--electron')) require('electron').app.exit(1); });
