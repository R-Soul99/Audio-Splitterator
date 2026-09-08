import JSZip from 'jszip';
import { ExportMode, FolderStructureOptions } from '../types';

export interface FileToSave {
  name: string;
  blob: Blob;
}

export interface SaveResult {
  method: 'directory' | 'zip' | 'downloads' | 'iframe_blocked';
  count: number;
  message: string;
  savedPath?: string;
  files?: FileToSave[];
}

export interface SaveFilesOptions {
  mode?: ExportMode; // default: 'individual'
  zipDefaultName?: string;
  folderStructure?: FolderStructureOptions;
  onProgress?: (current: number, total: number, fileName: string) => void;
}

/**
 * Clean strings for safe filesystem folder names (strips invalid OS characters)
 */
export function sanitizeFolderName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim();
}

/**
 * Checks if the current window is embedded inside an iframe (like AI Studio preview)
 */
export function isRunningInIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Saves multiple files as separate individual files (one file at a time)
 * or packaged in a folder-structured archive.
 * 
 * Supports creating [Artist] / [Album Title] subfolder hierarchy automatically!
 */
export async function saveFilesPrompt(
  files: FileToSave[],
  options?: SaveFilesOptions | string
): Promise<SaveResult> {
  if (files.length === 0) {
    return { method: 'downloads', count: 0, message: 'No files to save.' };
  }

  // Backwards compatibility where second argument was zipDefaultName string
  const opts: SaveFilesOptions =
    typeof options === 'string'
      ? { zipDefaultName: options, mode: 'individual' }
      : { mode: 'individual', ...options };

  const mode: ExportMode = opts.mode || 'individual';
  const zipName = opts.zipDefaultName || 'audio-splits.zip';
  const folderOpts = opts.folderStructure;

  const artistFolder = folderOpts?.enabled && folderOpts.artist ? sanitizeFolderName(folderOpts.artist) : '';
  const albumFolder = folderOpts?.enabled && folderOpts.album ? sanitizeFolderName(folderOpts.album) : '';

  // 1. If user explicitly selected ZIP mode OR when zip is needed:
  if (mode === 'zip') {
    const zip = new JSZip();

    // Determine subfolder path inside zip
    let subfolderZip: JSZip = zip;
    if (artistFolder && albumFolder) {
      subfolderZip = zip.folder(artistFolder)?.folder(albumFolder) || zip;
    } else if (artistFolder) {
      subfolderZip = zip.folder(artistFolder) || zip;
    } else if (albumFolder) {
      subfolderZip = zip.folder(albumFolder) || zip;
    }

    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      opts.onProgress?.(i + 1, files.length, item.name);
      subfolderZip.file(item.name, item.blob);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(zipBlob, zipName);

    const folderPathDisplay = [artistFolder, albumFolder].filter(Boolean).join(' / ');
    return {
      method: 'zip',
      count: files.length,
      message: folderPathDisplay
        ? `Exported ${files.length} tracks in ZIP containing "${folderPathDisplay}" folder hierarchy.`
        : `Exported ${files.length} tracks packaged in "${zipName}".`,
      savedPath: folderPathDisplay || zipName,
    };
  }

  // 2. Individual Files Mode
  // Try Native Directory Picker (File System Access API)
  // Allows user to pick a folder on disk, then automatically creates [Artist] -> [Album] subfolders!
  if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
    try {
      // @ts-ignore
      const rootDirHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'music',
      });

      // Automatically create / navigate to [Artist] / [Album Title] subfolders if requested
      let targetDir = rootDirHandle;
      const pathParts: string[] = [];

      if (artistFolder) {
        targetDir = await targetDir.getDirectoryHandle(artistFolder, { create: true });
        pathParts.push(artistFolder);
      }
      if (albumFolder) {
        targetDir = await targetDir.getDirectoryHandle(albumFolder, { create: true });
        pathParts.push(albumFolder);
      }

      let savedCount = 0;
      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        opts.onProgress?.(i + 1, files.length, item.name);
        const fileHandle = await targetDir.getFileHandle(item.name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(item.blob);
        await writable.close();
        savedCount++;
      }

      const folderDisplay = pathParts.length > 0 ? pathParts.join(' / ') : 'selected folder';
      return {
        method: 'directory',
        count: savedCount,
        message: `Successfully saved ${savedCount} tracks directly to "${folderDisplay}" on your disk!`,
        savedPath: folderDisplay,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error('Directory selection was cancelled.');
      }

      // Check if blocked by iframe security
      const isIframe = isRunningInIframe();
      const isSecurityError =
        err?.name === 'SecurityError' ||
        (err?.message && err.message.toLowerCase().includes('cross origin'));

      if (isIframe && isSecurityError) {
        console.warn('showDirectoryPicker blocked in cross-origin iframe. Falling back.', err);
        return {
          method: 'iframe_blocked',
          count: files.length,
          message:
            'Browser Security: Folder picker is restricted inside embedded preview frames. Open in a new tab for direct disk folder access, or save via the options below.',
          files,
        };
      }

      console.warn('showDirectoryPicker unavailable or errored, falling back:', err);
    }
  }

  // 3. Fallback: Sequential Downloads (if Directory Picker is unsupported)
  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    opts.onProgress?.(i + 1, files.length, item.name);
    triggerDownload(item.blob, item.name);
    if (i < files.length - 1) {
      // 500ms delay between downloads to allow browser download queue to register
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return {
    method: 'downloads',
    count: files.length,
    message: `Triggered download for ${files.length} audio files to your browser downloads folder.`,
    files,
  };
}

/**
 * Triggers a browser download for a single blob.
 */
export function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1500);
}
