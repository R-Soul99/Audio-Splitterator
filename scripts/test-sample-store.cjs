const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createSampleExportStore } = require('../electron/sample-export.cjs');
test('separate persisted destination, validation, explicit collision choices and complete files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'splitterator-samples-'));
  try {
    const settings = path.join(directory, 'sample-settings.json');
    const store = createSampleExportStore(settings);
    assert.equal(await store.getFolder(), '');
    await store.setFolder(directory);
    assert.equal(await createSampleExportStore(settings).getFolder(), directory);
    await assert.rejects(store.setFolder('relative'));
    await assert.rejects(store.setFolder(path.join(directory, 'absent')));
    const request = { folder: directory, name: 'cycle.wav', data: Uint8Array.of(1,2,3), mode: 'ask' };
    assert.equal((await store.save(request)).status, 'saved');
    assert.equal((await store.save(request)).status, 'exists');
    const numbered = await store.save({...request, mode:'numbered'});
    assert.ok(numbered.path.endsWith('cycle (2).wav'));
    await store.save({...request, mode:'replace', data:Uint8Array.of(4,5)});
    assert.deepEqual([...await fs.readFile(path.join(directory,'cycle.wav'))], [4,5]);
    await assert.rejects(store.save({...request,name:'../bad.wav'}));
    await assert.rejects(store.save({...request,name:'CON.wav'}));
    await assert.rejects(store.save({...request,folder:path.join(directory,'absent')}));
    // Simulate a file arriving after the existence check but before publication.
    const link = fs.link;
    fs.link = async (temporary, destination) => { await fs.writeFile(destination, 'racer'); return link(temporary,destination); };
    try { assert.equal((await store.save({...request,name:'race.wav'})).status,'exists'); }
    finally { fs.link = link; }
    assert.equal(await fs.readFile(path.join(directory,'race.wav'),'utf8'),'racer');
    fs.link = async () => { const error = Error('Simulated disk failure'); error.code='EIO'; throw error; };
    try { await assert.rejects(store.save({...request,name:'failure.wav'}),/disk failure/); }
    finally { fs.link = link; }
    // Destinations without hard links use an exclusive handle, with the same collision protection.
    fs.link = async () => { const error=Error('No hard links');error.code='ENOTSUP';throw error; };
    try {
      assert.equal((await store.save({...request,name:'portable.wav'})).status,'saved');
      assert.deepEqual([...await fs.readFile(path.join(directory,'portable.wav'))],[1,2,3]);
      const open=fs.open;
      fs.open=async (...args)=>{const file=await open(...args);if(args[0].endsWith('portable-fail.wav')) file.writeFile=async()=>{throw Error('Portable write failure');};return file;};
      try { await assert.rejects(store.save({...request,name:'portable-fail.wav'}),/Portable write failure/); }
      finally { fs.open=open; }
      assert.equal((await fs.readdir(directory)).includes('portable-fail.wav'),false);
    } finally { fs.link=link; }
    assert.equal((await fs.readdir(directory)).some(name=>name.endsWith('.tmp') || name==='failure.wav'),false);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
