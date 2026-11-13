export interface TreeBackupFilenameOptions {
  year: number;
  semester: number;
  grade: number;
  subject: string;
  scope?: string;
  kind: string;
  compactScope?: boolean;
}

function safeFilenameSegment(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .trim()
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/_+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '');
}

function compactAreaName(value: string): string {
  const characters = Array.from(safeFilenameSegment(value));
  return characters.length <= 24
    ? characters.join('')
    : `${characters.slice(0, 12).join('')}-${characters.slice(-8).join('')}`;
}

export function roomNumber(value: unknown): string {
  return String(value ?? '').match(/\d+/)?.[0] || '';
}

export function treeBackupFilename(options: TreeBackupFilenameOptions): string {
  const scope = options.scope
    ? (options.compactScope ? compactAreaName(options.scope) : safeFilenameSegment(options.scope))
    : '';
  return `${[
    Math.trunc(options.year),
    Math.trunc(options.semester),
    Math.trunc(options.grade),
    safeFilenameSegment(options.subject),
    scope,
    safeFilenameSegment(options.kind),
  ].filter(value => value !== '').join('_')}.xlsx`;
}

export function downloadFilename(disposition: string, fallback: string): string {
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { return utf8[1]; }
  }
  return plain?.[1] || fallback;
}
