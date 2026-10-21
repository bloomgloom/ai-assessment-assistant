import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import { runPdftoppm } from './pdfRenderer';

const RENDER_DPI = 200;

function clampTopHeightCm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(30, value));
}

function fillTopPixelsWhite(pngBuffer: Buffer, topHeightRatio: number): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const rows = Math.max(0, Math.min(png.height, Math.round(png.height * topHeightRatio)));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx + 1] = 255;
      png.data[idx + 2] = 255;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function renderFirstPageToPng(inputPath: string, outputPrefix: string): Promise<string> {
  try {
    await runPdftoppm([
      '-f', '1',
      '-l', '1',
      '-r', String(RENDER_DPI),
      '-png',
      inputPath,
      outputPrefix,
    ], { timeout: 30000 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`PDF 개인정보 가리기에 필요한 pdftoppm 실행에 실패했습니다: ${message}`);
  }

  const outputPath = `${outputPrefix}-1.png`;
  if (!fs.existsSync(outputPath)) {
    throw new Error('PDF 첫 페이지 렌더링 결과를 찾을 수 없습니다.');
  }
  return outputPath;
}

export async function redactPdfFirstPageTop(pdfBuffer: Buffer, topHeightCm: number): Promise<Buffer> {
  const heightCm = clampTopHeightCm(topHeightCm);
  if (heightCm <= 0) return pdfBuffer;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-pdf-redact-'));
  try {
    const inputPath = path.join(tmpDir, 'input.pdf');
    const outputPrefix = path.join(tmpDir, 'page');
    fs.writeFileSync(inputPath, pdfBuffer);

    const sourcePdf = await PDFDocument.load(pdfBuffer);
    const pages = sourcePdf.getPages();
    const firstPage = pages[0];
    if (!firstPage) return pdfBuffer;

    const { width, height } = firstPage.getSize();
    const redactHeightPt = Math.min(height, (heightCm / 2.54) * 72);
    const topHeightRatio = height > 0 ? redactHeightPt / height : 0;

    const firstPagePngPath = await renderFirstPageToPng(inputPath, outputPrefix);
    const redactedPng = fillTopPixelsWhite(fs.readFileSync(firstPagePngPath), topHeightRatio);

    const outputPdf = await PDFDocument.create();
    const firstImage = await outputPdf.embedPng(redactedPng);
    const redactedPage = outputPdf.addPage([width, height]);
    redactedPage.drawImage(firstImage, { x: 0, y: 0, width, height });

    if (pages.length > 1) {
      const remainingPages = await outputPdf.copyPages(sourcePdf, pages.slice(1).map((_, index) => index + 1));
      remainingPages.forEach((page) => outputPdf.addPage(page));
    }

    return Buffer.from(await outputPdf.save());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
