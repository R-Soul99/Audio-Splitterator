const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
(async () => {
  await fs.mkdir(path.join(root,'build'),{recursive:true});
  const profile = await fs.mkdtemp(path.join(root,'build','destination-test-'));
  const typed = path.join(profile, 'Typed folder with spaces');
  const picked = path.join(profile, 'Picked folder with spaces');
  await fs.mkdir(typed); await fs.mkdir(picked);
  const file = path.join(profile,'not a folder.txt'); await fs.writeFile(file,'test');
  const handlers = new Map();
  let pickerCalls = 0, bridge;
  const electron = {
    app: { getPath: () => profile, whenReady: () => ({ then: () => {} }), on: () => {} },
    ipcMain: { handle: (name, fn) => handlers.set(name,fn) },
    dialog: { showOpenDialog: async (_window, options) => { pickerCalls++; assert.equal(options.defaultPath, typed); return { filePaths: [picked] }; } },
    contextBridge: { exposeInMainWorld: (_name, api) => { bridge=api; } },
    ipcRenderer: { invoke: (name, ...args) => handlers.get(name)({},...args) },
  };
  const evaluate = async fileName => vm.runInNewContext(await fs.readFile(path.join(root,'electron',fileName),'utf8'), { require: name => name==='electron' ? electron : require(name), __dirname:path.join(root,'electron'), process, console, Uint8Array });
  await evaluate('main.cjs'); await evaluate('preload.cjs');
  assert.equal(await bridge.setExportFolder(typed),typed);
  assert.equal(await bridge.getExportFolder(),typed);
  // A fresh main-process module must read the same persisted path.
  await evaluate('main.cjs'); assert.equal(await bridge.getExportFolder(),typed);
  for(const invalid of ['', 'relative/path', file, path.join(profile,'missing')]) {
    await assert.rejects(bridge.setExportFolder(invalid), /Invalid destination/);
    assert.equal(await bridge.getExportFolder(),typed);
  }
  const written = await bridge.saveExportFile({ name:'typed.wav',data:new Uint8Array([1,2,3]),segments:[] });
  assert.equal(written,path.join(typed,'typed.wav'));
  assert.deepEqual([...await fs.readFile(written)],[1,2,3]);
  assert.equal(pickerCalls,0);
  assert.equal(await bridge.chooseExportFolder(),picked);
  assert.equal(await bridge.getExportFolder(),picked);
  assert.equal(pickerCalls,1);
  console.log('PASS: destination main/preload integration; space-containing paths, persistence, invalid-path rejection, typed-path export and folder picker');
})().catch(error=>{console.error(error);process.exitCode=1;});
