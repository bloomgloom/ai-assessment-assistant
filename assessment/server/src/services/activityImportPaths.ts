import type { ImportEntry } from './importEntries';

export function activityDateFromPath(relativePath: string): string {
  const segment = relativePath.normalize('NFC').split(/[/\\]/).find(value => /^\d{4}-\d{2}-\d{2}(?:\D.*)?$/.test(value));
  return segment?.slice(0, 10) || '';
}

export function isReflectionImportPath(relativePath: string): boolean {
  return relativePath.normalize('NFC').split(/[/\\]/).some(value => value === '되돌아보기');
}

export function importDateFolders(entries: ImportEntry[]): string[] {
  return Array.from(new Set(entries.map(entry => activityDateFromPath(entry.relativePath)).filter(Boolean)));
}
