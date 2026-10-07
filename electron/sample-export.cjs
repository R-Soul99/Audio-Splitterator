const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const safeName = value => typeof value === 'string' && value.length <= 210 && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value) && /[^. ]\.(wav|flac)$/i.test(value);
function createSampleExportStore(settingsPath) {
  async function validateFolder(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || /[\x00-\x1f]/.test(folder)) throw Error('Enter a full sample destination path.');
    try { if (!(await fs.stat(folder)).isDirectory()) throw Error(); await fs.access(folder, require('node:fs').constants.W_OK); }
    catch { throw Error('Choose an existing writable sample destination folder.'); }
    return path.resolve(folder);
  }
  async function getFolder() {
    try { const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')); return typeof settings.folder === 'string' ? settings.folder : ''; }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }
  async function setFolder(folder) {
    folder = await validateFolder(folder);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const temporary = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ folder }), { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, settingsPath);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return folder;
  }
  async function save({ folder, name, data, mode = 'ask' }) {
    if (!safeName(name) || !(data instanceof Uint8Array) || !data.byteLength || !['ask', 'replace', 'numbered'].includes(mode)) throw Error('Invalid sample export request.');
    folder = await validateFolder(folder);
    const destination = path.join(folder, name);
    if (mode === 'ask') {
      try { await fs.lstat(destination); return { status: 'exists', path: destination }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Write and sync a private temporary file before publishing a complete final file.
    const temporary = path.join(folder, `.sample-${randomUUID()}.tmp`);
    try {
      const file = await fs.open(temporary, 'wx');
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      if (mode === 'replace') {
        await fs.rename(temporary, destination);
        return { status: 'saved', path: destination };
      }
      const extension = path.extname(name), stem = path.basename(name, extension);
      for (let index = mode === 'numbered' ? 1 : 0; index < 10000; index++) {
        const target = path.join(folder, index ? `${stem} (${index + 1})${extension}` : name);
        // Hard-link publication is atomic and exclusive, including a late collision.
        try {
          try { await fs.link(temporary, target); }
          catch (error) {
            if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
            // FAT/exFAT and some network destinations cannot publish hard links.
            // An exclusive handle still prevents late overwrites; clean up our file on failure.
            const finalFile = await fs.open(target, 'wx');
            let complete = false;
            try { await finalFile.writeFile(data); await finalFile.sync(); complete = true; }
            finally {
              try { await finalFile.close(); }
              finally { if (!complete) await fs.unlink(target); }
            }
          }
          return { status: 'saved', path: target };
        }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (mode === 'ask') return { status: 'exists', path: target };
        }
      }
      throw Error('Too many samples with this filename.');
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  return { getFolder, setFolder, validateFolder, save };
}
module.exports = { createSampleExportStore };
