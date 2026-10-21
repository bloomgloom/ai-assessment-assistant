import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_STORAGE_ROOT = path.join(PROJECT_ROOT, '..', 'storage');

export const STORAGE_ROOT = path.resolve(process.env.APP_STORAGE_DIR || DEFAULT_STORAGE_ROOT);
export const DATA_DIR = path.join(STORAGE_ROOT, 'data');
export const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
export const LOGS_DIR = path.join(STORAGE_ROOT, 'logs');
export const TRASH_DIR = path.join(STORAGE_ROOT, 'trash');
export const SUBMISSIONS_DIR = path.join(UPLOADS_DIR, 'submissions');
export const TEMP_DIR = path.join(UPLOADS_DIR, 'assignment-temp');
export const RUN_RESOURCES_DIR = path.join(UPLOADS_DIR, 'assignment-run-resources');

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function toStoredPath(filepath: string): string {
  if (!filepath) return '';
  const absolutePath = path.resolve(filepath);
  const relativePath = path.relative(STORAGE_ROOT, absolutePath);
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return relativePath;
  return filepath;
}

export function resolveStoredPath(filepath: string): string {
  if (!filepath) return '';
  return path.isAbsolute(filepath) ? filepath : path.join(STORAGE_ROOT, filepath);
}

[DATA_DIR, LOGS_DIR, TRASH_DIR, UPLOADS_DIR, SUBMISSIONS_DIR, TEMP_DIR, RUN_RESOURCES_DIR].forEach(ensureDir);

export function moveFileToTrash(filepath: string, category: string): string {
  const source = resolveStoredPath(filepath);
  if (!source || !fs.existsSync(source)) return '';
  const day = new Date().toLocaleDateString('sv-SE');
  const safeCategory = category.replace(/[^a-z0-9_-]/gi, '_') || 'files';
  const targetDir = path.join(TRASH_DIR, day, safeCategory);
  ensureDir(targetDir);
  const originalName = path.basename(source);
  let target = path.join(targetDir, `${Date.now()}_${originalName}`);
  let suffix = 1;
  while (fs.existsSync(target)) target = path.join(targetDir, `${Date.now()}_${suffix++}_${originalName}`);
  fs.renameSync(source, target);
  return target;
}

export function restoreTrashedFile(trashPath: string, originalFilepath: string): void {
  if (!trashPath || !fs.existsSync(trashPath)) return;
  const target = resolveStoredPath(originalFilepath);
  ensureDir(path.dirname(target));
  fs.renameSync(trashPath, target);
}
