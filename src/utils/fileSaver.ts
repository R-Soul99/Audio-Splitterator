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
 * Resolves directory segments from FolderStructureOptions
 * e.g. ['Artist', 'Album'] or ['Artist', '1977 - Rumours'] or custom pattern
 */
export function resolveFolderSegments(opts?: FolderStructureOptions): string[] {
  if (!opts || !opts.enabled) return [];

  const artist = opts.artist?.trim() || '';
  const album = opts.album?.trim() || '';
  const year = opts.year?.trim() || '';
  const genre = opts.genre?.trim() || '';
  const type = opts.type || 'artist_album';

  if (opts.customFolderPattern) {
    // Custom folder pattern like "{artist}/{album}" or "{genre}/{artist}/({year}) {album}"
    const resolved = opts.customFolderPattern
      .replace(/\{artist\}/gi, artist || 'Unknown Artist')
      .replace(/\{album\}/gi, album || 'Unknown Album')
      .replace(/\{year\}/gi, year || '')
      .replace(/\{genre\}/gi, genre || '')
      .replace(/\{albumArtist\}/gi, artist || 'Unknown Artist');
    
    return resolved
      .split(/[/\\\\]+/)
      .map((seg) => sanitizeFolderName(seg))
      .filter((seg) => seg.length > 0);
  }

  const segments: string[] = [];

  switch (type) {
    case 'album_only':
      if (album) segments.push(sanitizeFolderName(album));
      break;
    case 'artist_year_album':
      if (artist) segments.push(sanitizeFolderName(artist));
      if (year && album) {
        segments.push(sanitizeFolderName(`${year} - ${album}`));
      } else if (album) {
        segments.push(sanitizeFolderName(album));
      }
      break;
    case 'flat':
      break;
    case 'artist_album':
    default:
      if (artist) segments.push(sanitizeFolderName(artist));
      if (album) segments.push(sanitizeFolderName(album));
      break;
  }

  return segments;
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
  const folderSegments = resolveFolderSegments(opts.folderStructure);
  const folderPathDisplay = folderSegments.join(' / ');

  // 1. If user explicitly selected ZIP mode OR when zip is needed:
  if (mode === 'zip') {
    const zip = new JSZip();

    // Determine subfolder path inside zip
    let subfolderZip: JSZip = zip;
    for (const segment of folderSegments) {
      subfolderZip = subfolderZip.folder(segment) || subfolderZip;
    }

    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      opts.onProgress?.(i + 1, files.length, item.name);
      subfolderZip.file(item.name, item.blob);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(zipBlob, zipName);

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

      // Automatically create / navigate through subfolder segments
      let targetDir = rootDirHandle;
      for (const seg of folderSegments) {
        targetDir = await targetDir.getDirectoryHandle(seg, { create: true });
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

      const folderDisplay = folderPathDisplay || 'selected folder';
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
