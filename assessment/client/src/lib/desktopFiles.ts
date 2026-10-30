export function hasDesktopFileDialogs() {
  return Boolean(window.assessmentDesktop?.saveFile && window.assessmentDesktop?.openFiles);
}

export async function saveBlob(filename: string, blob: Blob) {
  if (window.assessmentDesktop?.saveFile) {
    await window.assessmentDesktop.saveFile(filename, await blob.arrayBuffer());
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function filenameFromDisposition(disposition: string, fallback: string) {
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  return plainMatch?.[1] || fallback;
}

export async function downloadUrl(url: string, fallbackFilename: string) {
  const response = await fetch(url);
  if (!response.ok) {
    let message = `다운로드에 실패했습니다. (${response.status})`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {}
    throw new Error(message);
  }

  const filename = filenameFromDisposition(
    response.headers.get('Content-Disposition') || '',
    fallbackFilename,
  );
  await saveBlob(filename, await response.blob());
}

export async function openFiles(options?: DesktopOpenFilesOptions): Promise<File[] | null> {
  if (!window.assessmentDesktop?.openFiles) return null;
  const result = await window.assessmentDesktop.openFiles(options);
  if (result.canceled) return [];
  return result.files.map(file => new File([file.data], file.name));
}

export async function openDirectory(): Promise<string | null> {
  if (!window.assessmentDesktop?.openDirectory) return null;
  const result = await window.assessmentDesktop.openDirectory();
  return result.canceled ? '' : (result.path || '');
}

export async function openFilePath(filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (!window.assessmentDesktop?.openFiles) return null;
  const result = await window.assessmentDesktop.openFiles({ filters });
  return result.canceled ? '' : (result.files[0]?.path || '');
}

export function filesToInputChangeEvent(files: File[]) {
  return {
    target: { files, value: '' },
    currentTarget: { files, value: '' },
  };
}

export function acceptToFilters(accept?: string) {
  if (!accept) return undefined;
  const extensions = accept
    .split(',')
    .map(value => value.trim())
    .filter(value => value.startsWith('.'))
    .map(value => value.slice(1))
    .filter(Boolean);
  return extensions.length ? [{ name: 'Files', extensions }] : undefined;
}
