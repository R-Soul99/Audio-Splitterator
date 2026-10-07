export interface DesktopExportAPI {
  openExportFolder(folder: string): Promise<void>;
  getExportFolder(): Promise<string>;
  setExportFolder(folder: string): Promise<string>;
  chooseExportFolder(): Promise<string>;
  saveExportFile(file: { name: string; data: Uint8Array; segments: string[] }): Promise<string>;
}

export function getDesktopExport(): DesktopExportAPI | undefined {
  const api = (window as Window & { electronAPI?: DesktopExportAPI }).electronAPI;
  return api?.saveExportFile ? api : undefined;
}

export interface SampleSaveRequest { folder: string; name: string; data: Uint8Array; mode: 'ask' | 'replace' | 'numbered' }
export interface SampleExportAPI {
  getSampleFolder(): Promise<string>;
  setSampleFolder(folder: string): Promise<string>;
  chooseSampleFolder(): Promise<string | null>;
  saveSample(request: SampleSaveRequest): Promise<{ status: 'saved' | 'exists'; path: string }>;
}
export function getSampleExport(): SampleExportAPI | undefined {
  const api = (window as Window & { electronAPI?: SampleExportAPI }).electronAPI;
  return api?.saveSample ? api : undefined;
}
