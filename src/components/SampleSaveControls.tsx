import React, { useEffect, useRef, useState } from 'react';
import { samplePreferences } from '../utils/samplePreferences';
import { SampleSelection } from '../utils/loopSelection';
import { LoopPreset } from '../utils/loopMemory';
import { encodeFlac, encodeWav } from '../utils/audioEncoder';
import { getSampleExport } from '../utils/desktopExport';
import { sampleFilename } from '../utils/sampleExport';
import { CollisionPolicy, loopExportList, presetFilename, captureExport, exportItemChannels, ExportSnapshot, ItemResult, runExport } from '../utils/presetExport';

export function SampleSaveControls({ initialFilename, onFilenameChange, audioBuffer, selection, startBeat, presets, onControls, onSaved }: { initialFilename: string; onFilenameChange: (value: string) => void; audioBuffer: AudioBuffer | null; selection: SampleSelection | null; startBeat: number | null; presets: (LoopPreset | null)[]; onControls: () => void; onSaved: (message: string) => void }) {
  const api = getSampleExport();
  const dialog = useRef<HTMLDialogElement>(null);
  const items = loopExportList(presets, audioBuffer ? selection : null, startBeat);
  const hasPresets = items.some(item => item.id !== -1);
  const [selected, setSelected] = useState<number[]>(() => items.map(item => item.id));
  const [filename, setFilename] = useState(initialFilename);
  const [format, setFormat] = useState<'wav' | 'flac'>(() => { try { return samplePreferences(localStorage.getItem('audiophonic_sample_format'), null).format; } catch { return 'flac'; } });
  const [depth, setDepth] = useState<16 | 24>(() => { try { return samplePreferences(null, localStorage.getItem('audiophonic_sample_depth')).depth; } catch { return 16; } });
  const [folder, setFolder] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<number, ItemResult>>({});
  const [applyToAll, setApplyToAll] = useState(false);
  const policy = useRef<CollisionPolicy>({ mode: null });
  const [collision, setCollision] = useState<string | null>(null);
  const decision = useRef<((mode: 'replace' | 'numbered' | null) => void) | null>(null);
  const batch = useRef<ExportSnapshot | null>(null);
  const resultRef = useRef<Record<number, ItemResult>>({});
  const active = useRef(false), cancelled = useRef(false), mounted = useRef(true);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    api?.getSampleFolder().then(value => { if (mounted.current) setFolder(value); }).catch(error => { if (mounted.current) setStatus(error.message); });
    return () => { mounted.current = false; cancelled.current = true; decision.current?.(null); dialog.current?.close(); setTimeout(() => { const target = previousFocus.current; if (target?.getClientRects().length && target !== document.body) target.focus(); else document.querySelector<HTMLButtonElement>('[aria-label="Show sample save"]')?.focus(); }, 0); };
  }, []);
  useEffect(() => { try { localStorage.setItem('audiophonic_sample_format', format); localStorage.setItem('audiophonic_sample_depth', String(depth)); } catch {} }, [format, depth]);
  useEffect(() => { if (collision) dialog.current?.querySelector<HTMLButtonElement>('[aria-label="Replace existing sample"]')?.focus(); }, [collision]);
  const choose = (choice: 'replace' | 'numbered' | null) => { if (choice && applyToAll) policy.current.mode = choice; const resolve = decision.current; decision.current = null; setCollision(null); resolve?.(choice); };
  const cancel = () => { cancelled.current = true; choose(null); setStatus('Cancelling — the current write may finish. Completed files are retained.'); };
  const save = async () => {
    if (active.current || !api) return;
    active.current = true; cancelled.current = false; setBusy(true);
    try {
      if (!batch.current) {
        if (!audioBuffer) throw Error('Load a recording first.');
        const regions = items.filter(item => selected.includes(item.id));
        policy.current = { mode: null }; setApplyToAll(false);
        batch.current = captureExport(audioBuffer, regions, { base: filename, folder, format, depth }, hasPresets);
        resultRef.current = Object.fromEntries(batch.current.items.map(item => [item.id, { state: 'pending' }]));
        setResults({ ...resultRef.current });
      }
      const snapshot = batch.current;
      await api.setSampleFolder(snapshot.folder);
      const summary = await runExport(snapshot, resultRef.current, {
        policy: policy.current,
        cancelled: () => cancelled.current,
        encode: async (s, item) => {
          await new Promise(resolve => setTimeout(resolve, 30));
          const channels = exportItemChannels(s, item);
          const buffer = new AudioBuffer({ sampleRate: s.sampleRate, length: item.end - item.start, numberOfChannels: channels.length });
          channels.forEach((channel, c) => buffer.copyToChannel(channel, c));
          const data = s.format === 'wav' ? encodeWav(buffer, { bitDepth: s.depth }) : await encodeFlac(buffer, { bitDepth: s.depth });
          await new Promise(resolve => setTimeout(resolve, 0));
          return data;
        },
        write: request => api.saveSample(request),
        collision: name => new Promise(resolve => { decision.current = resolve; setCollision(name); setStatus(`Already exists: ${name}`); }),
        update: (_id, result, ordinal, total) => { if (mounted.current) { setResults({ ...resultRef.current }); if (result.state === 'saving') setStatus(`Saving ${ordinal} of ${total}`); } },
      });
      if (!mounted.current) return;
      if (summary.saved === summary.total && !summary.cancelled) onSaved(`Saved ${summary.saved} ${summary.saved === 1 ? 'loop' : 'loops'} to ${snapshot.folder}`);
      else setStatus(`${summary.cancelled ? 'Cancelled' : 'Incomplete'}: saved ${summary.saved} of ${summary.total}. Retry saves only failed or unfinished items.`);
    } catch (error) { if (mounted.current) setStatus(`Error: ${(error as Error).message}`); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const locked = busy || !!batch.current;
  const intendedName = (id: number) => {
    const captured = batch.current?.items.find(item => item.id === id);
    if (captured) return results[id]?.name ?? captured.name;
    try { return id === -1 ? sampleFilename(filename, format) : presetFilename(filename, id, format); }
    catch { return 'Invalid filename'; }
  };
  return <dialog ref={dialog} className="sample-export-dialog" aria-labelledby="sample-export-title" onCancel={event => { event.preventDefault(); if (!active.current) onControls(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="sample-export-title">Save loops</h2><span>One cycle per file · no processing</span></header>
    <div className="sample-export-body">
      <section className="sample-export-list" aria-label="Loops to export">
        <div className="sample-export-list-heading"><span>Loops to save</span><button type="button" disabled={locked || !items.length} onClick={() => setSelected(selected.length === items.length ? [] : items.map(item => item.id))}>{selected.length === items.length && items.length ? 'Select none' : 'Select all'}</button></div>
        <div className="sample-export-items">
          {items.map(({ id, region }) => { const result = results[id]; const name = intendedName(id); return <label key={id} className="sample-export-item" data-slot={id}>
            <input type="checkbox" autoFocus={id === items[0].id} aria-label={id === -1 ? 'Export current loop' : `Export preset ${id}`} disabled={locked} checked={selected.includes(id)} onChange={event => setSelected(value => event.target.checked ? [...value, id] : value.filter(slot => slot !== id))} />
            <span>{id === -1 ? 'Current Loop' : id === 0 ? '0 (slot 10)' : `Slot ${id}`}</span>
            <span className="sample-export-row-name" title={name}>{name}</span>
            <span>{audioBuffer ? ((region.end - region.start) / audioBuffer.sampleRate).toFixed(3) + ' s' : '--'}</span>
            <span data-state={result?.state} title={result?.error || result?.path}>{result?.state || (selected.includes(id) ? 'pending' : '--')}</span>
          </label>; })}
        </div>
      </section>
      <section className="sample-export-settings" aria-label="Export settings">
        <label>{hasPresets ? 'Base filename' : 'Filename'}<input autoFocus={!items.length} aria-label="Sample filename" disabled={locked} value={filename} onChange={event => { setFilename(event.target.value); onFilenameChange(event.target.value); }} /></label>
        <p>{hasPresets ? `Slot suffixes: _01…_10.${format}` : `Extension: .${format}`}</p>
        <label>Destination<input aria-label="Sample destination" disabled={locked} value={folder} onChange={event => setFolder(event.target.value)} onBlur={() => { if (api && folder && !active.current) void api.setSampleFolder(folder).catch(error => { if (mounted.current) setStatus(error.message); }); }} placeholder="Full destination path" /></label>
        <button type="button" aria-label="Browse sample folder" disabled={!api || locked} onClick={async () => { try { const value = await api?.chooseSampleFolder(); if (value) setFolder(value); } catch (error) { setStatus((error as Error).message); } }}>Choose folder</button>
        <div className="sample-export-format"><label>Format<select aria-label="Sample format" disabled={locked} value={format} onChange={e => setFormat(e.target.value as 'wav' | 'flac')}><option value="wav">WAV</option><option value="flac">FLAC</option></select></label>
          <label>Depth<select aria-label="Sample bit depth" disabled={locked} value={depth} onChange={e => setDepth(Number(e.target.value) as 16 | 24)}><option value={16}>16 bit</option><option value={24}>24 bit</option></select></label></div>
        <div className="sample-export-collision" aria-label="Filename collision">
          {collision && <><span title={collision}>File exists: {collision}</span><div><button type="button" aria-label="Replace existing sample" onClick={() => choose('replace')}>Replace</button><button type="button" aria-label="Number existing sample" onClick={() => choose('numbered')}>Number</button></div><label className="sample-export-all-conflicts"><input type="checkbox" aria-label="Apply to all remaining conflicts" checked={applyToAll} onChange={event => setApplyToAll(event.target.checked)} />Apply to all remaining conflicts</label></>}
        </div>
      </section>
    </div>
    <div className="sample-export-status" title={status} role="status" aria-live="polite" aria-busy={busy}>{status || (!items.length ? 'Store a preset or select a valid loop to save.' : !api ? 'Sample export requires the desktop app.' : 'Choose loops and settings, then Save. Existing files will ask before replacing.')}</div>
    <footer>{batch.current && !busy && <button type="button" onClick={() => { batch.current = null; resultRef.current = {}; setResults({}); policy.current = { mode: null }; setApplyToAll(false); setSelected(items.map(item => item.id)); setStatus('New export: completed files are retained.'); }}>New export</button>}<button type="button" aria-label="Save Sample" disabled={!api || busy || (!batch.current && !items.some(item => selected.includes(item.id)))} onClick={() => void save()}>{busy ? 'Saving...' : batch.current ? 'Retry unfinished' : 'Save'}</button><button type="button" aria-label="Cancel sample export" onClick={() => busy ? cancel() : onControls()}>{busy ? 'Cancel export' : 'Cancel'}</button></footer>
  </dialog>;
}
