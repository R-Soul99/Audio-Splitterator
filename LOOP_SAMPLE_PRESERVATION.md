# Loop/Sample preservation — 11 October 2026

Preserved before removal at commit `11fbd5c` (full ID: run `git rev-parse preserve/loop-sample-20261011`). Local tag: `preserve/loop-sample-20261011`. Full tracked-repository archive: `../splitterator-loop-sample-20261011.zip`. Editor screenshot: `../splitterator-loop-sample-20261011.png`.

All feature source and required configuration were committed. Existing working-tree changes were unrelated deleted/moved UI reference files; untracked prompts, reference images, worktrees and `test_audio_files/` were not changed or included as required source. The ZIP passed CRC validation and comparison of all tracked source, Electron code, scripts and project configuration against the preservation tag (normalising Git archive CRLF conversion). This is a complete source snapshot, not a patch. No sampler app was created.

## What is preserved

- Fixed Loop/Sample Tools panel; loop switch/LED; sample-accurate Start/End/Length readouts, coarse/fine edge adjustments, half/double, whole-region moves and spring-centred Slide.
- Start Beat placement, waveform marker and ruler drag/keyboard adjustment; audition begins at the beat and wraps to selection Start.
- Ten recording-owned memory slots, digit 0?9 store/recall, Shift-click replace, right-click clear and waveform preset strip. Memory is session-only and clears when recording identity changes.
- Single/selected-preset export, rotated one-cycle stereo PCM, WAV/FLAC 16/24-bit, remembered separate destination, filename and collision handling.
- Scheduled non-overlapping native source handover and output-latency-aware playhead synchronisation.

## Files and dependencies

Dedicated components: `LoopSampleControls.tsx`, `SampleSaveControls.tsx`, `SlideControl.tsx`. Dedicated utilities: `loopMemory`, `startBeat`, `slideControl`, `sampleExport`, `samplePreferences`, `presetExport`, `presetStrip`; their tests and `check-loop-*`, `check-start-beat-export`, `check-slide-control`, `check-preset-batch`, `test-sample-store` scripts. Desktop sample storage: `electron/sample-export.cjs`, sample IPC in main/preload and sample API types in `desktopExport.ts`. Feature state/handlers live in `App.tsx`; marker/strip/placement/panel integration in `WaveformCanvas.tsx`; dedicated styles in `index.css`. The unused legacy `TransportControls.tsx` also contains a loop toggle.

Shared and retained: waveform selection/edge/move, fades, markers, silence analysis/splitting, audio encoders, volume, recording and normal export. The shared `sampleSelection` function/type formerly lived in `loopSelection.ts`; after removal it lives in `sampleSelection.ts`. Playback clock/output latency remain, with single-pass selection playback. Loop-only resize/edit/time/beat helpers and Slide scale are removed.

Runtime dependencies are React, Electron, Web Audio, `libflacjs` and the existing WAV encoder. These are also required by recording/edit/export; there are no exclusively sampler-related npm dependencies to uninstall. Lockfile and project configuration are in the snapshot.

## Settings and limitations

Sample format/depth use `audiophonic_sample_format` / `audiophonic_sample_depth` in localStorage; destination uses `sample-export-settings.json` in Electron userData. The simplified app ignores these without deleting them. Normal `export-settings.json` is unchanged. There is no persisted project/session loader for loop memory in the inspected implementation; audio import creates fresh state. Presets are volatile, sample export is WAV/FLAC only, and historical outstanding-work notes are not evidence of final approval of every feature. Physical-input and long-take behaviour need human review.

## Recover and run without disturbing current work

From this repository: `git worktree add --detach ../splitterator-loop-sample-recovery preserve/loop-sample-20261011`. In that separate directory run `npm ci`, `npm run build`, then `npx electron .` (unset `ELECTRON_RUN_AS_NODE`, `NODE_ENV` and `VITE_DEV_SERVER_URL` if set). Alternatively extract the ZIP into a new directory and run the same commands. Do not use the latest-main launcher in the preserved checkout: it selects current main. The tag/archive preserve code, not user recordings or volatile in-memory presets. Keep recordings and current dirty checkout intact. The preservation tag and ZIP remain local. Leroy subsequently confirmed the simplification passed hands-on review and authorised its integration.
