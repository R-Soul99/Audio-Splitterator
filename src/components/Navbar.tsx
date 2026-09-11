import React from 'react';
import { Mic, Layers, FolderOpen, Radio, Sparkles, ExternalLink } from 'lucide-react';
import { isRunningInIframe } from '../utils/fileSaver';

interface NavbarProps {
  currentTab: 'editor' | 'batch';
  onSelectTab: (tab: 'editor' | 'batch') => void;
  onOpenFile: () => void;
  isRecording: boolean;
  hasAudio: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  onOpenFile,
  isRecording,
  hasAudio,
}) => {
  const inIframe = isRunningInIframe();

  return (
    <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-40 px-4 lg:px-6 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand & Title */}
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-base font-semibold text-slate-100 tracking-tight">
                Audiophonic Recordinator
              </h1>
              <span className="text-[10px] font-medium tracking-wide uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                Studio Edition
              </span>
            </div>
          </div>
        </div>

        {/* Action Tabs & File Open */}
        <div className="flex items-center space-x-2.5 sm:space-x-3">
          {inIframe && (
            <a
              href={window.location.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 transition shadow-sm"
              title="Open in a new standalone tab for native folder picker and direct disk saving"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Open in Tab</span>
            </a>
          )}



          {/* Navigation View Toggle */}
          <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <button
              type="button"
              onClick={() => onSelectTab('editor')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md font-medium transition cursor-pointer ${
                currentTab === 'editor'
                  ? 'bg-emerald-500 text-slate-950 font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Mic className="w-3.5 h-3.5" />
              <span>Record & Editor</span>
              {isRecording && (
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onSelectTab('batch')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md font-medium transition cursor-pointer ${
                currentTab === 'batch'
                  ? 'bg-emerald-500 text-slate-950 font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Batch Processor</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
