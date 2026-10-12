const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, '../build/tool-selector-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 650, webPreferences: { backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  try {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
    await run(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'EDIT').click()`);
    await pause();
    await run(`window.button = label => document.querySelector('button[aria-label="'+label+'"]');
      window.geometry = () => JSON.stringify(document.querySelector('[aria-label="Edit waveform"]').getBoundingClientRect().toJSON());
      window.original = geometry();`);
    assert.equal(await run(`button('Chop').disabled`), true);
    const layout = await run(`(() => {
      const row = document.querySelector('[aria-label="Tool selector"]'), r = row.getBoundingClientRect();
      const lcd = document.querySelector('.tool-display').getBoundingClientRect();
      const readouts = document.querySelector('[aria-label="Waveform readouts"]');
      return { above: r.bottom <= lcd.top, gap: lcd.top - r.bottom,
        outside: !readouts.contains(row), buttons: [...row.querySelectorAll('button')].map(b => {
          const br = b.getBoundingClientRect(), ir = b.querySelector('.tool-indicator').getBoundingClientRect();
          return { top: br.top, width: br.width, height: br.height, integrated: ir.left > br.left + br.width/2 && ir.right < br.right, narrow: ir.width < ir.height };
        }) };
    })()`);
    assert.equal(layout.above, true); assert.equal(layout.outside, true); assert.ok(layout.gap <= 6);
    assert.equal(layout.buttons.length, 3);
    const controls = await run(`(() => {
      const strip=document.querySelector('[aria-label="Waveform readouts"]'), group=strip.firstElementChild;
      const children=[...group.children];
      return {left:group.getBoundingClientRect().left-strip.getBoundingClientRect().left,
        order:children.map(e=>e.getAttribute('aria-label')||e.textContent.trim().replace(/\\s+/g,' ')),
        knob:children[2].querySelector('[aria-label="Sensitivity"]')!==null};
    })()`);
    assert.ok(controls.left<=10);
    assert.equal(controls.order[0],'Detect noise floor');
    assert.match(controls.order[1],/dB$/);
    assert.equal(controls.order[2],'Sensitivity');
    assert.equal(controls.order[3],'Show detected split preview');
    assert.equal(controls.knob,true);

    assert.ok(layout.buttons.every(b => b.top === layout.buttons[0].top && b.width > b.height && b.integrated && b.narrow));
    await run(`window.FileReader = class { readAsArrayBuffer() { this.result = new ArrayBuffer(8); this.onload(); } };
      AudioContext.prototype.decodeAudioData = () => Promise.resolve(new AudioBuffer({length:48000, sampleRate:48000, numberOfChannels:2}));
      const input = document.querySelector('input[type=file]'), data = new DataTransfer(); data.items.add(new File(['audio'], 'selector.wav')); input.files = data.files; input.dispatchEvent(new Event('change', {bubbles:true}));`);
    const deadline = Date.now() + 20000;
    while (await run(`button('Chop').disabled || document.querySelector('main').inert`)) {
      if (Date.now() > deadline) throw new Error('Audio load timed out');
      await pause();
    }
    for (const [label, panel] of [['Chop', '.chop-guidance'], ['Auto-Chop', '#processing-detection-controls'], ['Volume', '.tools-volume']]) {
      await run(`button('${label}').click()`); await pause();
      assert.equal(await run(`geometry()`), await run(`original`));
      assert.equal(await run(`document.querySelector('${panel}').getBoundingClientRect().height > 0`), true);
      const states = await run(`[...document.querySelectorAll('.tool-pushbutton')].map(b => ({ label:b.getAttribute('aria-label'), pressed:b.getAttribute('aria-pressed'), color:getComputedStyle(b.querySelector('.tool-indicator')).backgroundColor }))`);
      assert.equal(states.filter(s => s.pressed === 'true').length, 1);
      assert.equal(states.find(s => s.label === label).color, 'rgb(251, 191, 36)');
      assert.ok(states.filter(s => s.label !== label).every(s => s.color === 'rgb(48, 38, 25)'));
    }
    await run(`button('Chop').click()`); await pause();
    await run(`button('Chop').focus()`);
    await run(`button('Chop').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`); await pause();
    assert.equal(await run(`button('Chop').getAttribute('aria-pressed')`), 'false');
    assert.equal(await run(`!!document.querySelector('[aria-label="Sensitivity"]') && !!button('Show detected split preview')`), true);
    console.log('PASS tool selector placement, indicators, panels, Escape, disabled Chop and fixed waveform geometry');
    win.destroy(); app.quit();
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
