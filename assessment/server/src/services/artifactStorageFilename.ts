import crypto from 'crypto';
import path from 'path';

const MAX_STORED_FILENAME_BYTES = 240;

function safeSegment(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || '_';
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function storedArtifactFilename(
  studentNum: number,
  studentName: string,
  originalFilename: string,
  options: { now?: number; randomHex?: string } = {},
): string {
  const now = options.now ?? Date.now();
  const randomHex = options.randomHex ?? crypto.randomBytes(8).toString('hex');
  const original = safeSegment(path.basename(originalFilename.normalize('NFC')));
  const candidateExt = path.extname(original);
  const ext = Buffer.byteLength(candidateExt) <= 20 ? candidateExt : '';
  const stem = ext ? path.basename(original, ext) : original;
  const prefix = `${now}_${studentNum}_${safeSegment(studentName)}_${randomHex}_`;
  const availableStemBytes = Math.max(1, MAX_STORED_FILENAME_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(ext));
  const fittedStem = truncateUtf8(stem, availableStemBytes) || 'file';
  return `${prefix}${fittedStem}${ext}`;
}
