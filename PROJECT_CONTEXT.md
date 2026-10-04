# Audiophonic Splitterator — Project Context

## Purpose

Audiophonic Splitterator is a Windows desktop audio application designed primarily for recording vinyl records and turning long recordings into properly separated, tagged audio tracks.

The intended workflow is **RECORD → EDIT → SAVE**. The application should make this process substantially quicker and easier than using a conventional general-purpose audio editor.

## Primary use case

1. Record audio from a turntable/audio interface.
2. Monitor incoming levels and recording quality.
3. Open the completed recording in the Edit workspace.
4. Identify gaps between tracks.
5. Automatically or manually place split markers.
6. Audition and fine-adjust boundaries.
7. Enter/confirm track and release metadata.
8. Export the resulting tracks as WAV, FLAC or MP3.

Vinyl is the primary design case. Surface noise means a track gap is not necessarily digital silence. Detection needs to understand the recording's noise floor rather than simply looking for samples close to zero. Account for groove noise, surface crackle, non-silent gaps and imprecise physical track boundaries.

## Application structure

### RECORD

Responsible for incoming audio capture: input selection, stereo/mono selection, sample rate, preamp/input gain, monitoring, oscilloscope, VU/peak metering, recording transport, recording markers and artist/album information.

### EDIT

The main waveform editing/splitting workspace. Important concepts include waveform navigation, selections, split markers, vinyl noise-floor detection, gap detection, marker snapping, zero-crossing assistance, looping/audition and non-destructive editing where possible.

The waveform is the central working area and should retain as much screen space as possible. Opening tools, information panels or controls must not unexpectedly resize or move it.

### SAVE

Responsible for track metadata, naming, export format, destination and individual track export. Export formats include WAV, FLAC and MP3.

## Technology and architecture

The application uses React, TypeScript, Vite, Electron, Web Audio APIs, libflacjs and lamejs (via `@breezystack/lamejs`). Electron provides the Windows desktop application; browser development is also supported.

`src/App.tsx` coordinates the three workspaces and shared editing/playback state. Components live in `src/components/`; audio processing, silence analysis, encoding and export helpers live in `src/utils/`. Electron integration lives in `electron/`. Inspect current code before relying on these descriptions; preserve established boundaries and avoid unrelated restructuring. `README.md` and `package.json` describe setup and build commands.

## Design principles

### Audio first

Never sacrifice audio correctness for a cosmetic improvement. Changes affecting splitting, encoding, recording, sample positions or waveform timing require particular care.

### Non-destructive where possible

Editing operations should avoid altering the source recording unnecessarily.

### Stable interface

Controls opening or changing state must not cause unrelated parts of the interface to jump, resize or move. Preserve the fixed device/workspace layout and waveform space.

### Physical-control aesthetic

The visual design deliberately resembles vintage laboratory and professional audio equipment: hi-fi and recording hardware, analogue meters, rotary controls, switches and illuminated indicators. Maintain this established aesthetic.

## Development workflow

Leroy normally uses this process:

1. Discuss behaviour/design with ChatGPT.
2. Reach agreement on the desired behaviour.
3. Produce a precise implementation brief for the coding agent. Leroy saves the brief as a text file in `Prompts/` and asks the agent to read that file and implement it.
4. The agent inspects current implementation and works on a fresh development branch from up-to-date `main` for each development pass.
5. Run automated tests, TypeScript checking and the production build.
6. Leroy tests the behaviour interactively.
7. Refine problems before the work is considered complete; honour agreed staged review points.
8. Merge approved work into `main`.

Human testing is important. Passing automated checks does not by itself mean a feature is approved. Keep the existing prompt-file hand-off; adopting a different prompt system is a separate decision.

## Sources of truth

Use the following order when information conflicts:

1. Current code on `main` — what the application currently does.
2. Explicit requirements in the current development task.
3. `PROJECT_CONTEXT.md` — enduring project intent.
4. Existing approved behaviour that Leroy has asked to preserve.
5. `Next_Up.txt` — informal current/future notes; potentially stale and incomplete.
6. `SEEDS.md` — ideas only.
7. `Prompts/` — historical development briefs.
8. Screenshots, mockups and old plans — reference material only.

Current `main` establishes the implementation baseline; an explicit current task can authorise changes to that baseline. Distinguish implemented behaviour from human approval.

Old prompt files describe what was requested at that point in development. They must not automatically be treated as current requirements. A historical brief becomes task-specific input only when Leroy explicitly selects it for the current pass; reconcile it with current code and this hierarchy.

Do not infer that an idea has been approved merely because it appears in `SEEDS.md`, `Next_Up.txt`, an old prompt, screenshot or previous implementation. Discussion and implementation approval are separate things.
