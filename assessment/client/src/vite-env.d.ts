/// <reference types="vite/client" />

interface DesktopOpenFile {
  name: string;
  path: string;
  data: ArrayBuffer;
}

interface DesktopOpenFilesOptions {
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}

interface DesktopOpenFilesResult {
  canceled: boolean;
  files: DesktopOpenFile[];
}

interface DesktopSaveFileResult {
  canceled: boolean;
  filePath?: string;
}

interface Window {
  __hasUnsavedChanges?: boolean;
  assessmentDesktop?: {
    setDisplaySleepPrevention?: (enabled: boolean) => Promise<boolean>;
    saveFile?: (filename: string, data: ArrayBuffer) => Promise<DesktopSaveFileResult>;
    openFiles?: (options?: DesktopOpenFilesOptions) => Promise<DesktopOpenFilesResult>;
    openDirectory?: () => Promise<{ canceled: boolean; path?: string }>;
  };
}
