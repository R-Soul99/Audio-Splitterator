export interface DesktopWindowAPI {
  setUnsavedWork(value: boolean): void;
  confirmClose(): void;
  onCloseRequested(callback: () => void): () => void;
}

export function getDesktopWindow(): DesktopWindowAPI | undefined {
  const api = (window as Window & { electronAPI?: Partial<DesktopWindowAPI> }).electronAPI;
  return api?.setUnsavedWork && api.confirmClose && api.onCloseRequested ? (api as DesktopWindowAPI) : undefined;
}
