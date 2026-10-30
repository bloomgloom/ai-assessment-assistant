import fs from 'fs';
import path from 'path';
import * as unzipper from 'unzipper';

export interface ImportEntry {
  relativePath: string;
  read: () => Promise<Buffer>;
}

function visiblePath(relativePath: string): boolean {
  const parts = relativePath.split(/[/\\]/).filter(Boolean);
  return !parts.some(part => part === '__MACOSX' || part.startsWith('.'));
}

export async function entriesFromZip(zipPath: string): Promise<ImportEntry[]> {
  const directory = await unzipper.Open.file(zipPath);
  return directory.files
    .filter(entry => entry.type !== 'Directory' && visiblePath(entry.path))
    .map(entry => {
      let relativePath = entry.path.normalize('NFC');
      if (relativePath.includes('\uFFFD')) {
        try { relativePath = Buffer.from(entry.path, 'latin1').toString('utf8').normalize('NFC'); } catch {}
      }
      return { relativePath, read: () => entry.buffer() };
    });
}

export async function entriesFromFolder(folderPath: string): Promise<ImportEntry[]> {
  const root = path.resolve(folderPath);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error('선택한 경로가 폴더가 아닙니다.');
  const entries: ImportEntry[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, item.name);
      const relativePath = path.relative(root, absolutePath).normalize('NFC');
      if (!visiblePath(relativePath)) continue;
      if (item.isDirectory()) walk(absolutePath);
      else if (item.isFile()) entries.push({ relativePath, read: async () => fs.readFileSync(absolutePath) });
    }
  };
  walk(root);
  return entries;
}

export async function entriesFromImportSource(source: { zipPath?: string; folderPath?: string }): Promise<ImportEntry[]> {
  if (source.zipPath) return entriesFromZip(source.zipPath);
  if (source.folderPath) return entriesFromFolder(source.folderPath);
  throw new Error('ZIP 파일 또는 폴더 경로가 필요합니다.');
}

export function entryFilename(entry: ImportEntry): string {
  return entry.relativePath.split(/[/\\]/).pop() || '';
}
