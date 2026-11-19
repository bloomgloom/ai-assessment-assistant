import fs from 'fs';
import path from 'path';
import type { Response } from 'express';
import { resolveStoredPath } from './storage';

const CONTENT_TYPES: Record<string, string> = {
  '.py': 'text/x-python; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.java': 'text/x-java; charset=utf-8',
  '.c': 'text/x-c; charset=utf-8',
  '.cpp': 'text/x-c++; charset=utf-8',
  '.h': 'text/x-c; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.sql': 'text/x-sql; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ipynb': 'application/x-ipynb+json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.hwpx': 'application/vnd.hancom.hwpx',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

export function artifactContentType(filename: string, fallback = ''): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || fallback || 'application/octet-stream';
}

export function sendArtifactFile(
  res: Response,
  file: { filename: string; filepath: string; mime_type?: string },
): boolean {
  const filepath = resolveStoredPath(file.filepath);
  if (!filepath || !fs.existsSync(filepath)) {
    res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    return false;
  }
  res.setHeader('Content-Type', artifactContentType(file.filename, file.mime_type));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.sendFile(path.resolve(filepath));
  return true;
}
