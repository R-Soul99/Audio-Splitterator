import React from 'react';
import {
  Play,
  Pause,
  Square,
  Repeat,
  ZoomIn,
  ZoomOut,
  Maximize2,
  BookmarkPlus,
  ArrowLeftToLine,
  ArrowRightToLine,
  Wand2,
  Trash2,
} from 'lucide-react';
import { formatTime } from '../utils/audioProcessing';

interface TransportControlsProps {
  isPlaying: boolean;
  isLooping: boolean;
  currentTime: number;
  totalDuration: number;
  cropStart: number;
  cropEnd: number;
  zoom: number;
  onPlayPause: () => void;
  onStop: () => void;
  onToggleLoop: () => void;
  onZoomChange: (zoom: number) => void;
  onZoomFit: () => void;
  onSetInToPlayhead: () => void;
  onSetOutToPlayhead: () => void;
  onResetCrop: () => void;
  onCropStartChange: (sec: number) => void;
  onCropEndChange: (sec: number) => void;
  onAddMarkerAtPlayhead: () => void;
  onClearMarkers: () => void;
  onAutoDetectSilence: () => void;
}

export const TransportControls: React.FC<TransportControlsProps> = ({
  isPlaying,
  isLooping,
  currentTime,
  totalDuration,
  cropStart,
  cropEnd,
  zoom,
  onPlayPause,
  onStop,
  onToggleLoop,
  onZoomChange,
  onZoomFit,
  onSetInToPlayhead,
  onSetOutToPlayhead,
  onResetCrop,
  onCropStartChange,
  onCropEndChange,
  onAddMarkerAtPlayhead,
  onClearMarkers,
  onAutoDetectSilence,
}) => {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-md space-y-3">
      {/* Top row: Transport buttons, Time counter, Zoom */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Play / Pause / Stop / Loop */}
        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={onPlayPause}
            className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition shadow-sm cursor-pointer"
            title="Play / Pause (Space)"
          >
            {isPlaying ? (
              <>
                <Pause className="w-4 h-4 fill-current" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                <span>Play</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onStop}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition cursor-pointer"
            title="Stop & Reset to Start"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>

          <button
            type="button"
            onClick={onToggleLoop}
            className={`p-2 rounded-lg border transition cursor-pointer ${
              isLooping
                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-400 border-slate-700'
            }`}
            title="Toggle Loop Playback"
          >
            <Repeat className="w-4 h-4" />
          </button>

          {/* Time Counter */}
          <div className="flex items-baseline space-x-1.5 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 font-mono">
            <span className="text-emerald-400 font-bold text-sm">
              {formatTime(currentTime, true)}
            </span>
            <span className="text-slate-500 text-xs">/</span>
            <span className="text-slate-400 text-xs">
              {formatTime(totalDuration, true)}
            </span>
          </div>
        </div>

        {/* Marker Actions */}
        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={onAddMarkerAtPlayhead}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 text-xs font-medium transition cursor-pointer"
            title="Add split marker at current playhead position"
          >
            <BookmarkPlus className="w-4 h-4 text-purple-400" />
            <span>Add Marker</span>
          </button>

          <button
            type="button"
            onClick={onAutoDetectSilence}
            className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-medium transition cursor-pointer"
            title="Automatically detect pauses & insert split markers"
          >
            <Wand2 className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">Auto-Split Silence</span>
          </button>

          <button
            type="button"
            onClick={onClearMarkers}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-red-400 border border-slate-700 transition cursor-pointer"
            title="Clear all split markers"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center space-x-2 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
          <button
            type="button"
            onClick={() => onZoomChange(Math.max(1, zoom / 1.5))}
            className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
            title="Zoom Out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <input
            type="range"
            min="1"
            max="40"
            step="0.5"
            value={zoom}
            onChange={(e) => onZoomChange(parseFloat(e.target.value))}
            className="w-20 accent-emerald-500 h-1.5 bg-slate-800 rounded cursor-pointer"
            title="Zoom Level"
          />
          <button
            type="button"
            onClick={() => onZoomChange(Math.min(40, zoom * 1.5))}
            className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
            title="Zoom In"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onZoomFit}
            className="text-slate-400 hover:text-emerald-400 p-1 border-l border-slate-800 pl-2 cursor-pointer"
            title="Fit to Screen"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Bottom row: Crop boundary controls & fine tuning */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800 text-xs">
        {/* In Point controls */}
        <div className="flex items-center space-x-2">
          <span className="text-emerald-400 font-semibold uppercase tracking-wider text-[10px]">
            In Crop:
          </span>
          <button
            type="button"
            onClick={onSetInToPlayhead}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
            title="Set In Crop to Playhead"
          >
            <ArrowLeftToLine className="w-3 h-3 text-emerald-400" />
            <span>Set to Playhead</span>
          </button>
          <input
            type="number"
            step="0.01"
            min="0"
            max={cropEnd - 0.05}
            value={Number(cropStart.toFixed(2))}
            onChange={(e) => onCropStartChange(parseFloat(e.target.value) || 0)}
            className="w-18 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 font-mono text-slate-200 text-right"
          />
          <span className="text-slate-400 font-mono text-[11px]">({formatTime(cropStart)})</span>
        </div>

        {/* Out Point controls */}
        <div className="flex items-center space-x-2">
          <span className="text-amber-400 font-semibold uppercase tracking-wider text-[10px]">
            Out Crop:
          </span>
          <button
            type="button"
            onClick={onSetOutToPlayhead}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
            title="Set Out Crop to Playhead"
          >
            <ArrowRightToLine className="w-3 h-3 text-amber-400" />
            <span>Set to Playhead</span>
          </button>
          <input
            type="number"
            step="0.01"
            min={cropStart + 0.05}
            max={totalDuration}
            value={Number(cropEnd.toFixed(2))}
            onChange={(e) => onCropEndChange(parseFloat(e.target.value) || totalDuration)}
            className="w-18 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 font-mono text-slate-200 text-right"
          />
          <span className="text-slate-400 font-mono text-[11px]">({formatTime(cropEnd)})</span>

          <button
            type="button"
            onClick={onResetCrop}
            className="text-[11px] text-slate-400 hover:text-slate-200 underline ml-2 cursor-pointer"
            title="Reset crop boundaries to entire recording"
          >
            Reset
          </button>
        </div>

        {/* Cropped Active Duration */}
        <div className="text-[11px] text-slate-400 font-mono bg-slate-950 px-2.5 py-0.5 rounded border border-slate-800">
          Cropped Span: <span className="text-emerald-400 font-semibold">{formatTime(Math.max(0, cropEnd - cropStart))}</span>
        </div>
      </div>
    </div>
  );
};
