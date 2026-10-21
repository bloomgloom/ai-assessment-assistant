import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { UPLOADS_DIR, ensureDir } from './storage';
import { redactPdfFirstPageTop } from './pdfRedaction';
import { runPdftoppm } from './pdfRenderer';

const PDF_RENDER_DPI = 150;
const PDF_JPEG_QUALITY = 82;
const CACHE_DIR = path.join(UPLOADS_DIR, 'llm-cache', 'pdf-images');
ensureDir(CACHE_DIR);

export interface LLMImageAttachment {
  filename: string;
  mimeType: string;
  data: string;
}

function isGeneratedPdfJpeg(filename: string): boolean {
  return /^page-\d+\.jpg$/i.test(filename);
}

function pdfCacheKey(pdfPath: string, topHeightCm: number): string {
  const stat = fs.statSync(pdfPath);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      path: path.resolve(pdfPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      topHeightCm,
      dpi: PDF_RENDER_DPI,
      quality: PDF_JPEG_QUALITY,
    }))
    .digest('hex')
    .slice(0, 24);
}

async function renderPdfToJpegFiles(pdfPath: string, outputDir: string): Promise<void> {
  ensureDir(outputDir);
  const prefix = path.join(outputDir, 'page');
  await runPdftoppm([
    '-r', String(PDF_RENDER_DPI),
    '-jpeg',
    '-jpegopt', `quality=${PDF_JPEG_QUALITY}`,
    pdfPath,
    prefix,
  ], { timeout: 120000 });
}

function attachmentFilesFromDir(dir: string, label: string): LLMImageAttachment[] {
  return fs.readdirSync(dir)
    .filter(isGeneratedPdfJpeg)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((filename, index) => ({
      filename: `${label} page ${index + 1}.jpg`,
      mimeType: 'image/jpeg',
      data: fs.readFileSync(path.join(dir, filename)).toString('base64'),
    }));
}

export async function pdfToRedactedJpegAttachments(
  pdfPath: string,
  label: string,
  topHeightCm: number,
): Promise<LLMImageAttachment[]> {
  const cacheDir = path.join(CACHE_DIR, pdfCacheKey(pdfPath, topHeightCm));
  if (fs.existsSync(cacheDir)) {
    const cached = attachmentFilesFromDir(cacheDir, label);
    if (cached.length > 0) return cached;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-pdf-vision-'));
  const tmpCacheDir = path.join(tmpDir, 'cache');
  try {
    const sourcePdfPath = path.join(tmpDir, 'source.pdf');
    const outputPdfPath = path.join(tmpDir, 'redacted.pdf');
    fs.writeFileSync(sourcePdfPath, fs.readFileSync(pdfPath));

    if (topHeightCm > 0) {
      fs.writeFileSync(outputPdfPath, await redactPdfFirstPageTop(fs.readFileSync(sourcePdfPath), topHeightCm));
      await renderPdfToJpegFiles(outputPdfPath, tmpCacheDir);
    } else {
      await renderPdfToJpegFiles(sourcePdfPath, tmpCacheDir);
    }

    ensureDir(path.dirname(cacheDir));
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.renameSync(tmpCacheDir, cacheDir);
    return attachmentFilesFromDir(cacheDir, label);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function imageFileToAttachment(filepath: string, label: string, ext: string): LLMImageAttachment {
  const mimeType = ext === 'png'
    ? 'image/png'
    : ext === 'webp'
      ? 'image/webp'
      : 'image/jpeg';
  return {
    filename: label,
    mimeType,
    data: fs.readFileSync(filepath).toString('base64'),
  };
}
