export interface TreeBackupFilenameOptions {
  year: number;
  semester: number;
  grade: number;
  subject: string;
  scope?: string;
  kind: string;
  compactScope?: boolean;
  extension?: string;
}

export function safeFilenameSegment(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .trim()
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/_+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '');
}

export function compactAreaName(value: string): string {
  const characters = Array.from(safeFilenameSegment(value));
  if (characters.length <= 24) return characters.join('');
  return `${characters.slice(0, 12).join('')}-${characters.slice(-8).join('')}`;
}

export function roomNumber(value: unknown): string {
  return String(value ?? '').match(/\d+/)?.[0] || '';
}

export function treeBackupFilename(options: TreeBackupFilenameOptions): string {
  const scope = options.scope
    ? (options.compactScope ? compactAreaName(options.scope) : safeFilenameSegment(options.scope))
    : '';
  const segments = [
    Math.trunc(options.year),
    Math.trunc(options.semester),
    Math.trunc(options.grade),
    safeFilenameSegment(options.subject),
    scope,
    safeFilenameSegment(options.kind),
  ].filter(value => value !== '');
  const extension = safeFilenameSegment(options.extension || 'xlsx') || 'xlsx';
  return `${segments.join('_')}.${extension}`;
}
