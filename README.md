# Audiophonic Splitterator

High-fidelity audio recording, soundcard line-in capture, waveform slicing with zero-crossing detection, micro-crossfade editing, and FLAC / WAV / MP3 batch export.

---

## 🛠️ Getting Started Locally

### 1. Install Dependencies
Run this once after downloading or updating the repository:
```bash
npm install
```

---

## 🚀 Running in Development

### Option A: Web Browser Mode (Fastest)
Runs the React + Vite dev server at `http://localhost:3000`:
```bash
npm run dev
```

### Option B: Desktop App Mode (Live Reloading Window)
Launches the Vite dev server and opens **Audiophonic Splitterator** inside a native desktop window with live reloading:
```bash
npm run electron:dev
```

---

## 📦 Creating the Standalone Windows `.exe`

### 1. Full Windows Build (Installer + Portable `.exe`)
Builds the production web bundle and packages it with Electron into a standalone Windows installer and portable executable:
```bash
npm run electron:build
```
- The output files will be generated in the **`dist-electron/`** folder:
  - `Audiophonic Splitterator Setup 1.0.0.exe` (Full Windows installer with desktop shortcut)
  - `Audiophonic Splitterator 1.0.0.exe` (Portable single-file executable—runs immediately with no installation needed)

### 2. Fast Unpacked `.exe` (For Rapid Testing)
If you want to test the `.exe` immediately without waiting for the installer compression step:
```bash
npm run electron:dir
```
- Look inside `dist-electron/win-unpacked/Audiophonic Splitterator.exe` and double-click to launch.

---

## 🎧 Audio Recording & Hardware Permissions
When running as a desktop `.exe`, hardware audio permissions for your soundcards, line-in inputs, USB interfaces (e.g. Focusrite, Behringer, mixers, vinyl preamps), and microphones are granted automatically by the Electron main process.
