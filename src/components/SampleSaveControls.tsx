import React, { useEffect, useRef, useState } from 'react';
import { SampleSelection } from '../utils/loopSelection';
import { sampleFilename, snapshotSample } from '../utils/sampleExport';
import { encodeFlac, encodeWav } from '../utils/audioEncoder';
import { getSampleExport, SampleSaveRequest } from '../utils/desktopExport';

export function SampleSaveControls({ audioBuffer, selection, startBeat, onControls }: { audioBuffer: AudioBuffer | null; selection: SampleSelection | null; startBeat: number | null; onControls: () => void }) {
  const api = getSampleExport();
  const [filename, setFilename] = useState('Loop Sample');
  const [format, setFormat] = useState<'wav' | 'flac'>('wav');
  const [depth, setDepth] = useState<16 | 24>(24);
  const [folder, setFolder] = useState('');
  const [status, setStatus] = useState('');
  const [phase, setPhase] = useState<'idle' | 'encoding' | 'writing'>('idle');
  const [pending, setPending] = useState<SampleSaveRequest | null>(null);
  const active = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api?.getSampleFolder().then(value => { if (mounted.current) setFolder(value); }).catch(error => { if (mounted.current) setStatus(String(error.message)); });
    return () => { mounted.current = false; cancelled.current = true; };
  }, []);
  const message = (text: string) => { if (mounted.current) setStatus(text); };
  const commitFolder = async (value: string) => {
    if (!api || !value) return;
    try { await api.setSampleFolder(value); } catch (error) { message((error as Error).message); }
  };
  const browse = async () => {
    try { const value = await api?.chooseSampleFolder(); if (value) { setFolder(value); message('Sample destination updated.'); } else message('Folder selection cancelled.'); }
    catch (error) { message((error as Error).message); }
  };
  const write = async (request: SampleSaveRequest) => {
    setPhase('writing'); message('Writing sample...');
    const result = await api!.saveSample(request);
    if (result.status === 'exists') { setPending(request); message(`Filename exists: ${request.name}. Replace or Numbered?`); }
    else { setPending(null); message(`Saved: ${result.path}`); }
  };
  const save = async (mode?: 'replace' | 'numbered') => {
    if (active.current || !api) return;
    active.current = true; cancelled.current = false;
    try {
      if (mode && pending) { await write({ ...pending, mode }); return; }
      if (!audioBuffer || !selection || startBeat === null) throw Error('Select a valid region first.');
      const name = sampleFilename(filename, format);
      const destination = folder;
      const bitDepth = depth;
      const encoding = format;
      // Copy samples and settings synchronously before any asynchronous work.
      const snapshot = snapshotSample(audioBuffer, { ...selection }, startBeat);
      setPending(null); setPhase('encoding'); message('Encoding sample...');
      await api.setSampleFolder(destination);
      await new Promise(resolve => setTimeout(resolve, 30));
      if (cancelled.current) return;
      const data = encoding === 'wav' ? encodeWav(snapshot, { bitDepth }) : await encodeFlac(snapshot, { bitDepth });
      // Let queued cancellation run before publishing a file.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cancelled.current) return;
      await write({ name, folder: destination, data, mode: 'ask' });
    } catch (error) { setPending(null); message(`Error: ${(error as Error).message}`); }
    finally { active.current = false; if (mounted.current) setPhase('idle'); }
  };
  const busy = phase !== 'idle';
  return <div className="sample-save-controls" aria-label="Save Sample controls" onKeyDown={event => event.stopPropagation()}>
    <div className="sample-save-row">
      <input aria-label="Sample filename" title="Sample filename; extension follows the selected format" disabled={!!pending} value={filename} onChange={e => { setFilename(e.target.value); if (!busy) setStatus(''); }} />
      <select aria-label="Sample format" disabled={!!pending} value={format} onChange={e => setFormat(e.target.value as 'wav' | 'flac')}><option value="wav">WAV</option><option value="flac">FLAC</option></select>
      <select aria-label="Sample bit depth" disabled={!!pending} value={depth} onChange={e => setDepth(Number(e.target.value) as 16 | 24)}><option value={16}>16 bit</option><option value={24}>24 bit</option></select>
      <button type="button" aria-label="Show loop controls" onClick={onControls}>Controls</button>
    </div>
    <div className="sample-save-row">
      <input aria-label="Sample destination" title="Separate remembered sample destination" disabled={!!pending} value={folder} onChange={e => { setFolder(e.target.value); if (!busy) setStatus(''); }} onBlur={() => void commitFolder(folder)} placeholder="Sample destination folder" />
      <button type="button" aria-label="Browse sample folder" disabled={!api || busy || !!pending} onClick={() => void browse()}>Folder</button>
      <button type="button" aria-label="Save Sample" disabled={!api || !selection || busy || !!pending} onClick={() => void save()}>Save Sample</button>
    </div>
    <div className="sample-save-feedback" role="status" aria-live="polite" aria-busy={busy}>
      <span title={status}>{status || (!api ? 'Sample export requires the desktop app.' : !selection ? 'Select a region to save a sample.' : 'One cycle, starting at Start Beat. No fades or processing.')}</span>
      {pending && <><button type="button" disabled={busy} onClick={() => void save('replace')}>Replace</button><button type="button" disabled={busy} onClick={() => void save('numbered')}>Numbered</button><button type="button" disabled={busy} onClick={() => { setPending(null); setStatus('Save cancelled.'); }}>Cancel</button></>}
      {phase === 'encoding' && <button type="button" onClick={() => { cancelled.current = true; setStatus('Save cancelled.'); }}>Cancel</button>}
    </div>
  </div>;
}
