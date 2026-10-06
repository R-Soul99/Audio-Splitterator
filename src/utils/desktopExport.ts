export interface DesktopExportAPI {
  openExportFolder(segments: string[]): Promise<void>;
  getExportFolder(): Promise<string>;
  setExportFolder(folder: string): Promise<string>;
  chooseExportFolder(): Promise<string>;
  saveExportFile(file: { name: string; data: Uint8Array; segments: string[] }): Promise<string>;
}

export function getDesktopExport(): DesktopExportAPI | undefined {
  const api = (window as Window & { electronAPI?: DesktopExportAPI }).electronAPI;
  return api?.saveExportFile ? api : undefined;
}
