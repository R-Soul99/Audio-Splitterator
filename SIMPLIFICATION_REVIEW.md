# Simplification review ? 11 October 2026

Local branch: `simplify/record-split-export-20261011`. Implementation base: `11fbd5c3676c73cdb995832b9c151eec3193244b`. At implementation handover the changes were unstaged, uncommitted and unmerged. Leroy subsequently confirmed hands-on review passed and authorised committing, merging and pushing main on 11 October 2026. Remote main was fetched and matched the base before editing.

Loop/Sample panel, looping audio mode, Start Beat, memory/preset strip, sample export, dedicated shortcuts, styles, helpers, sample IPC and regression scripts removed. Selection audition plays once. Shared recording/import, selection and edge/move adjustment, fades, markers/splitting, volume and WAV/FLAC/MP3 track export remain. Existing npm dependencies are shared; package.json/lockfile unchanged. Device dimensions unchanged. Native geometry comparison against the pre-removal production build passed. No adjacent panel redesign or sampler app.

Preservation: [inventory and recovery instructions](LOOP_SAMPLE_PRESERVATION.md). Tag `preserve/loop-sample-20261011`; full repository ZIP and editor screenshot are beside this repository. ZIP CRC and all tracked source/Electron/scripts/config comparisons passed. SHA256: `A3684D7580A26C5D93A46A3389B3A560F11C2E5B672555339664DCB105D63AAF`.

## Checks

Passed:
- `npm run lint` (final TypeScript check).
- `npx tsx --test src/utils/*.test.ts`: 72 passed, zero failures; focused single-pass playback clock and shared sample-boundary tests included.
- `npm run build`: passed; existing large-chunk warning.
- Native Electron `check-edit-transport`: Play/Pause/resume/Stop/Return, Space/Home, no-audio controls, old-build geometry, selection one-pass/end, removed controls/props and digit shortcuts, invalid obsolete localStorage settings, no renderer errors.
- Native `check-cursor-selection`: exact end, overshoot, edge extension, region move, zoom controls and stable waveform geometry.
- Native `check-shared-detection`: shared Detect, candidates, manual marker replacement, busy/duplicate guards, splitting and fixed geometry.
- Native `check-volume-workflow`: scopes, linked stereo reduction/normalisation, undo, meters, completion and fixed geometry. Updated stale Reset selector to the current held-peak button; removed obsolete onLoopChange setup.
- Native `check-recording-display` against production file URL: direct, resume, paused, allocation retry and load retry; exact stereo PCM, navigation, markers, resource release and geometry.
- Native `check-fade-visual` standalone rerun: fade-in/out drags, offscreen visual envelopes, radar decay, Chop and failed-import preservation. Screenshot `build/transport-stopped.png` inspected visually.
- `node scripts/test-split-export.cjs`: real encoded/decoded WAV/FLAC 16/24-bit and MP3; source boundaries, stereo, rate, metadata, pagination and fixed export layout.
- `node scripts/test-export-destination.cjs`: main/preload track destination integration; added invalid obsolete sample-settings file and absent sample IPC/API checks.
- Fresh output unpacked Electron package: `npx electron-builder --dir "-c.directories.output=../splitterator-simplified-package-20261011"`.
- `git diff --check`: no whitespace errors.

Failed initial attempts, resolved or remaining:
- Initial TypeScript pass found two leftover loop refs; fixed, final pass clean.
- Recording harness initially lacked its dev server; then dev-mode instrumentation was interrupted by Vite reloads caused by generated test/build files. Production-file rerun passed all five scenarios.
- Volume harness used removed-in-baseline textual Reset button; updated test selector, rerun passed.
- First concurrent fade/radar run failed its animation alpha assertion (despite exit code 0); standalone rerun passed.
- Default `npm run electron:dir` failed with Windows EPERM renaming its unpacked directory. Fresh-output packaging passed. Tracked `dist-electron` files were restored to their initially clean baseline. After stopping the temporary Vite server, the failed attempt's generated unpacked directory was moved outside the repository to `../splitterator-failed-package-20261011`; no packaging diff remains.

Unperformed / review:
- Physical audio-interface capture, hours-long recordings, listening checks, installed/portable installer execution.
- Leroy confirmed hands-on review passed: the simplified app is tested and working. Agent physical-input and hours-long capture checks remain unperformed.
- Follow-up: after Leroy closed the old app and confirmed its recording was unimportant, launched the fresh unpacked package at `../splitterator-simplified-package-20261011/win-unpacked/Audiophonic Recordinator.exe` in a visible window. Process/window startup verified. To review current branch from source: `npm run build` then `npx electron .`. The latest-main launcher intentionally rejects dirty feature work.

## Git status and changed files

At implementation handover all task changes were unstaged. Pre-existing eight `UI_design` deletions and untracked prompts/images/worktrees/recordings remain; no user recording was opened or changed. New task files: `LOOP_SAMPLE_PRESERVATION.md`, `SIMPLIFICATION_REVIEW.md`, `src/utils/sampleSelection.ts`, `src/utils/sampleSelection.test.ts`.

Tracked task diff (M modified, D removed):

```text
M	Next_Up.txt
M	PROJECT_CONTEXT.md
M	README.md
M	electron/main.cjs
M	electron/preload.cjs
D	electron/sample-export.cjs
M	scripts/check-edit-transport.cjs
D	scripts/check-loop-memory.cjs
D	scripts/check-loop-sample.cjs
D	scripts/check-preset-batch.cjs
D	scripts/check-slide-control.cjs
D	scripts/check-start-beat-export.cjs
M	scripts/check-volume-workflow.cjs
M	scripts/test-export-destination.cjs
D	scripts/test-sample-store.cjs
M	src/App.tsx
D	src/components/LoopSampleControls.tsx
D	src/components/SampleSaveControls.tsx
D	src/components/SlideControl.tsx
M	src/components/TransportControls.tsx
M	src/components/WaveformCanvas.tsx
M	src/index.css
M	src/utils/desktopExport.ts
D	src/utils/loopMemory.test.ts
D	src/utils/loopMemory.ts
D	src/utils/loopSelection.test.ts
D	src/utils/loopSelection.ts
M	src/utils/playbackClock.test.ts
M	src/utils/playbackClock.ts
D	src/utils/presetExport.test.ts
D	src/utils/presetExport.ts
D	src/utils/presetStrip.ts
D	src/utils/sampleExport.test.ts
D	src/utils/sampleExport.ts
D	src/utils/samplePreferences.test.ts
D	src/utils/samplePreferences.ts
D	src/utils/slideControl.test.ts
D	src/utils/slideControl.ts
D	src/utils/startBeat.test.ts
D	src/utils/startBeat.ts
M	src/utils/volumeAnalysis.ts
M	src/utils/volumeTools.ts
M	src/utils/waveformDisplay.test.ts
M	src/utils/waveformDisplay.ts
```
