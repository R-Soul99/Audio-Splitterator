import React from 'react';
import { FadeSettings } from '../types';
import { Sliders, ShieldCheck, Zap, HelpCircle } from 'lucide-react';

interface FadeSettingsPanelProps {
  settings: FadeSettings;
  onChange: (settings: FadeSettings) => void;
}

export const FadeSettingsPanel: React.FC<FadeSettingsPanelProps> = ({ settings, onChange }) => {
  const updateSettings = (partial: Partial<FadeSettings>) => {
    onChange({ ...settings, ...partial });
  };

  const presetMs = [5, 10, 25, 50, 100, 250, 500, 1000];

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-md space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="flex items-center space-x-2.5">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <Sliders className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <span>Anti-Clipping & Volume Fades</span>
              <span className="text-[10px] bg-emerald-500/15 text-emerald-300 px-2 py-0.5 rounded font-mono font-bold">
                Zero-Click Protection
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              Apply smooth attack/release envelopes to eliminate abrupt start/end pops
            </p>
          </div>
        </div>

        {/* Zero-Crossing Detection Switch */}
        <label className="flex items-center space-x-2 cursor-pointer bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 hover:border-emerald-500/40 transition">
          <input
            type="checkbox"
            checked={settings.zeroCrossing}
            onChange={(e) => updateSettings({ zeroCrossing: e.target.checked })}
            className="rounded accent-emerald-500 w-4 h-4 cursor-pointer"
          />
          <div className="flex items-center space-x-1">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs font-semibold text-slate-200">Zero-Crossing Detection</span>
          </div>
        </label>
      </div>

      {/* Fade In and Fade Out Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Fade In Column */}
        <div
          className={`p-3.5 rounded-xl border transition ${
            settings.fadeInEnabled
              ? 'bg-slate-950 border-slate-800'
              : 'bg-slate-950/40 border-slate-800/50 opacity-60'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.fadeInEnabled}
                onChange={(e) => updateSettings({ fadeInEnabled: e.target.checked })}
                className="rounded accent-emerald-500 w-4 h-4 cursor-pointer"
              />
              <span className="text-xs font-bold text-slate-200 uppercase tracking-wide">
                Fade In (Start)
              </span>
            </label>
            <span className="text-xs font-mono font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              {settings.fadeInMs} ms
            </span>
          </div>

          {/* Presets */}
          <div className="flex flex-wrap gap-1 mb-3">
            {presetMs.map((ms) => (
              <button
                key={ms}
                type="button"
                onClick={() => updateSettings({ fadeInMs: ms, fadeInEnabled: true })}
                className={`px-2 py-0.5 text-[11px] rounded font-mono transition cursor-pointer border ${
                  settings.fadeInMs === ms && settings.fadeInEnabled
                    ? 'bg-emerald-500 text-slate-950 font-bold border-emerald-400'
                    : 'bg-slate-850 hover:bg-slate-800 text-slate-400 border-slate-800'
                }`}
              >
                {ms}ms
              </button>
            ))}
          </div>

          {/* Slider and Number Input */}
          <div className="flex items-center space-x-3 mb-3">
            <input
              type="range"
              min="1"
              max="2000"
              step="1"
              value={settings.fadeInMs}
              onChange={(e) => updateSettings({ fadeInMs: parseInt(e.target.value) || 1 })}
              disabled={!settings.fadeInEnabled}
              className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded cursor-pointer"
            />
            <input
              type="number"
              min="1"
              max="10000"
              value={settings.fadeInMs}
              onChange={(e) => updateSettings({ fadeInMs: Math.max(1, parseInt(e.target.value) || 1) })}
              disabled={!settings.fadeInEnabled}
              className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs font-mono text-slate-200 text-right"
            />
          </div>

        </div>

        {/* Fade Out Column */}
        <div
          className={`p-3.5 rounded-xl border transition ${
            settings.fadeOutEnabled
              ? 'bg-slate-950 border-slate-800'
              : 'bg-slate-950/40 border-slate-800/50 opacity-60'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.fadeOutEnabled}
                onChange={(e) => updateSettings({ fadeOutEnabled: e.target.checked })}
                className="rounded accent-emerald-500 w-4 h-4 cursor-pointer"
              />
              <span className="text-xs font-bold text-slate-200 uppercase tracking-wide">
                Fade Out (End)
              </span>
            </label>
            <span className="text-xs font-mono font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              {settings.fadeOutMs} ms
            </span>
          </div>

          {/* Presets */}
          <div className="flex flex-wrap gap-1 mb-3">
            {presetMs.map((ms) => (
              <button
                key={ms}
                type="button"
                onClick={() => updateSettings({ fadeOutMs: ms, fadeOutEnabled: true })}
                className={`px-2 py-0.5 text-[11px] rounded font-mono transition cursor-pointer border ${
                  settings.fadeOutMs === ms && settings.fadeOutEnabled
                    ? 'bg-emerald-500 text-slate-950 font-bold border-emerald-400'
                    : 'bg-slate-850 hover:bg-slate-800 text-slate-400 border-slate-800'
                }`}
              >
                {ms}ms
              </button>
            ))}
          </div>

          {/* Slider and Number Input */}
          <div className="flex items-center space-x-3 mb-3">
            <input
              type="range"
              min="1"
              max="2000"
              step="1"
              value={settings.fadeOutMs}
              onChange={(e) => updateSettings({ fadeOutMs: parseInt(e.target.value) || 1 })}
              disabled={!settings.fadeOutEnabled}
              className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded cursor-pointer"
            />
            <input
              type="number"
              min="1"
              max="10000"
              value={settings.fadeOutMs}
              onChange={(e) => updateSettings({ fadeOutMs: Math.max(1, parseInt(e.target.value) || 1) })}
              disabled={!settings.fadeOutEnabled}
              className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs font-mono text-slate-200 text-right"
            />
          </div>

        </div>
      </div>

      {/* Visual Curve Representation & Zero-Crossing Info */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 p-3 rounded-lg border border-slate-800/80 text-xs">
        <div className="flex items-center space-x-2 text-slate-300">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>
            {settings.zeroCrossing
              ? 'Zero-crossing detection is active (avoids DC offset jumps and transient clicks).'
              : 'Zero-crossing detection is disabled.'}
          </span>
        </div>

        {/* SVG Envelope Preview */}
        <div className="flex items-center space-x-2">
          <span className="text-[11px] text-slate-400">Envelope Preview:</span>
          <svg className="w-32 h-6 bg-slate-900 rounded border border-slate-800" viewBox="0 0 100 24">
            {/* Fade In path */}
            {settings.fadeInEnabled ? (
              <path
                d={`M 4 20 Q 14 ${20 - settings.fadeInCurveNode * 16} 25 4`}
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
              />
            ) : (
              <line x1="4" y1="4" x2="25" y2="4" stroke="#64748b" strokeWidth="2" />
            )}

            {/* Flat Sustain */}
            <line x1="25" y1="4" x2="75" y2="4" stroke="#10b981" strokeWidth="2" />

            {/* Fade Out path */}
            {settings.fadeOutEnabled ? (
              <path
                d={`M 75 4 Q 86 ${4 + (1 - settings.fadeOutCurveNode) * 16} 96 20`}
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
              />
            ) : (
              <line x1="75" y1="4" x2="96" y2="4" stroke="#64748b" strokeWidth="2" />
            )}
          </svg>
        </div>
      </div>
    </div>
  );
};
