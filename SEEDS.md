# Audiophonic Splitterator — Seeds & Feature Ideas

A shared backlog of roadmap ideas, architectural discussions, and feature seeds. Both the user and the assistant can add notes and reference them here anytime.

---

## 1. Architectural: Fixed-Viewport DAW Layout (Eliminate Page Scrolling)
- **Problem**: When the web page scrolls vertically, using the mouse wheel over the waveform can accidentally trigger zoom-in/out instead of scrolling the page, and controls can slip out of view.
- **Solution**: 
  - Lock layout to **100vh** (fixed viewport, no outer browser scrollbar).
  - **Top Dock**: Sleek transport controls, master peak meters, and main file status.
  - **Center Stage**: Waveform canvas with draggable overview navigation bar.
  - **Bottom Dock / Side Drawer**: Tabbed panels for:
    - *Track Splits & Metadata Tagging*
    - *Silence Detection & Auto-Split Tools*
    - *Batch Audio Converter*
    - *Soundcard / Live Audio Recorder*
  - **Mouse Wheel Modifier**: Require `Ctrl + Wheel` or `Alt + Wheel` to zoom waveform, keeping regular mouse scroll safe.

---

## 2. Audio Processing: Vinyl Noise Floor Profiler for Silence Detection
- **Concept**: A vinyl record is never mathematically silent; surface crackle and groove noise can fool standard silence detectors into thinking songs never end.
- **Implementation**:
  - **"Sample Vinyl Floor" Tool**: The user creates a small selection over the lead-in groove, track gap, or run-out groove.
  - The app calculates the average RMS and peak decibel level of that vinyl crackle (e.g. -42 dB).
  - Automatically calibrates the silence detection threshold (e.g. 2 dB above the crackle baseline) so track boundaries are spotted with laser precision.

---

## 3. Performance & Memory: Long Recording Optimization (Vinyl LP Sides)
- **Problem**: A full 2-sided vinyl recording is 40–50+ minutes of stereo audio. Uncompressed 32-bit float audio can consume 1GB+ of browser RAM, leading to Chrome slowdowns.
- **Solutions**:
  - **Level-of-Detail (LOD) Decimated Peak Pyramids**: Pre-compute multi-resolution min/max peaks so drawing 45 minutes of audio only needs 1,000 to 2,000 points rather than 120 million samples.
  - **Canvas Offscreen Caching**: Avoid redrawing background waveforms during playhead tracking; only redraw the overlay layer.
  - **ArrayBuffer Lifecycle Management**: Release old audio buffers cleanly from memory when cuts or splices are executed.

---

## 4. Packaging: Standalone Desktop App (Windows .exe)
- **Goal**: Run Audiophonic Splitterator as a real desktop program without opening Chrome or typing terminal commands.
- **Status**: Electron and `electron-builder` packages are already integrated in `package.json`.
- **Workflow**:
  - We prototype and refine all features here with instant browser feedback.
  - When ready, run `npm run electron:build` to produce an installer (`Audiophonic-Splitterator-Setup.exe`).
  - Launches with full OS window decorations, system tray support, and direct hard drive access for Resonic Pro.

---

## 5. UI Seeds & Enhancements Backlog
- [x] Rename "Cut Out Selection" to **"Cut Selection"**.
- [x] **Draggable Overview Edges**: Drag left/right borders of the minimap overview box to zoom in and out dynamically.
- [ ] Folder for user reference screenshots: `docs/screenshots/`
- [ ] Custom naming patterns for export (e.g. `{artist} - {album} - {trackNumber} - {title}.flac`).
- [ ] Split-marker snapping to nearest silence/zero-crossing point.
