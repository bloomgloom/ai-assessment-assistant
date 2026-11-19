import fs from 'fs';
import { extractHwpxText } from './hwpx';
import { imageFileToAttachment, pdfToRedactedJpegAttachments } from './visionArtifacts';
import { buildNotebookExecutionEvidence, buildPythonFileExecutionEvidence, buildTabularDataEvidence } from './artifactEvidence';
import { resolveStoredPath } from './storage';
import type { LLMImageAttachment, LLMSettings } from './llm';

export interface ArtifactRow {
  id: number;
  filename: string;
  filepath: string;
  mime_type: string;
}

const FILE_REFERENCE_EXTENSIONS = [
  'csv', 'tsv', 'xlsx', 'xls', 'json', 'txt', 'md', 'ipynb', 'py', 'js', 'ts', 'html', 'css',
  'xml', 'sql', 'pkl', 'pickle', 'parquet', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'hwpx',
];
const FILE_REFERENCE_EXT_PATTERN = FILE_REFERENCE_EXTENSIONS.join('|');
const UNQUOTED_FILE_REFERENCE_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}_./\\\\'"\`"-])((?:\\.{1,2}[/\\\\])?(?:[^\\s'"\`<>(){}\\[\\],;:]+[/\\\\])*[^\\s'"\`<>(){}\\[\\],;:]+\\s*\\.(${FILE_REFERENCE_EXT_PATTERN}))(?![\\p{L}\\p{N}_./\\\\'"\`"-])`,
  'giu'
);
const QUOTED_TEXT_PATTERN = /(['"`])([^'"`\r\n]{0,300})\1/g;

export interface ArtifactPrivacyMapper {
  artifactName(artifact: ArtifactRow): string;
  sanitizeText(text: string): string;
}

export function createArtifactPrivacyMapper(artifacts: ArtifactRow[]): ArtifactPrivacyMapper {
  const mapping = new Map<string, string>();
  const anonymizedNames = new Set<string>();
  let nextFileIndex = 1;

  const anonymize = (rawReference: string): string => {
    const key = rawReference.normalize('NFC');
    if (anonymizedNames.has(key)) return key;
    const existing = mapping.get(key);
    if (existing) return existing;

    const ext = key.match(/\.([A-Za-z0-9]+)\s*$/)?.[1]?.toLowerCase();
    const anonymized = `file_${String(nextFileIndex).padStart(3, '0')}${ext ? `.${ext}` : ''}`;
    nextFileIndex += 1;
    mapping.set(key, anonymized);
    anonymizedNames.add(anonymized);
    return anonymized;
  };

  for (const artifact of artifacts) anonymize(artifact.filename);

  const knownFilenameVariants = artifacts
    .flatMap((artifact) => {
      const filename = artifact.filename;
      return [filename, filename.normalize('NFC'), filename.normalize('NFD')];
    })
    .filter((filename, index, filenames) => filename && filenames.indexOf(filename) === index)
    .sort((left, right) => right.length - left.length);

  const replaceKnownFilenames = (text: string): string => {
    let sanitized = text;
    for (const filename of knownFilenameVariants) {
      sanitized = sanitized.split(filename).join(anonymize(filename));
    }
    return sanitized;
  };

  return {
    artifactName(artifact: ArtifactRow): string {
      return anonymize(artifact.filename);
    },
    sanitizeText(text: string): string {
      return replaceKnownFilenames(text)
        .replace(QUOTED_TEXT_PATTERN, (_match, quote: string, content: string) => {
          const sanitizedContent = content.replace(UNQUOTED_FILE_REFERENCE_PATTERN, (_contentMatch, reference: string) => {
            return anonymize(reference);
          });
          return `${quote}${sanitizedContent}${quote}`;
        })
        .replace(UNQUOTED_FILE_REFERENCE_PATTERN, (_match, reference: string) => {
          return anonymize(reference);
        });
    },
  };
}

interface DecodedTextBuffer {
  text: string;
  encoding: string;
}

function decodeTextBufferWithEncoding(buffer: Buffer): DecodedTextBuffer {
  const encodings = ['utf-8', 'euc-kr', 'utf-16le'];
  for (const encoding of encodings) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: encoding === 'utf-8' }).decode(buffer);
      if (!decoded.includes('\uFFFD')) return { text: decoded, encoding };
    } catch { /* try next encoding */ }
  }
  return { text: buffer.toString('utf8'), encoding: 'utf-8-fallback' };
}

function decodeTextBuffer(buffer: Buffer): string {
  return decodeTextBufferWithEncoding(buffer).text;
}

function normalizeNotebookSource(source: unknown): string {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

function extractIpynbInputText(buffer: Buffer, options: { skipFirstMarkdownCell?: boolean } = {}): string {
  const notebook = JSON.parse(decodeTextBuffer(buffer)) as {
    cells?: { cell_type?: string; source?: unknown }[];
  };
  if (!Array.isArray(notebook.cells)) return '';

  const chunks: string[] = [];
  notebook.cells.forEach((cell, index) => {
    if (options.skipFirstMarkdownCell && index === 0 && cell.cell_type === 'markdown') {
      return;
    }
    const source = normalizeNotebookSource(cell.source).trim();
    if (!source) return;
    if (cell.cell_type === 'markdown') {
      chunks.push(`[Markdown Cell ${index + 1}]\n${source}`);
    } else if (cell.cell_type === 'code') {
      chunks.push(`[Code Cell ${index + 1}]\n\`\`\`python\n${source}\n\`\`\``);
    }
  });
  return chunks.join('\n\n');
}

function extractCsvInputText(buffer: Buffer): DecodedTextBuffer {
  const decoded = decodeTextBufferWithEncoding(buffer);
  return { ...decoded, text: decoded.text.trim() };
}

function stripLeadingCStyleBlockComment(code: string): string {
  return code.replace(/^(\uFEFF?\s*)\/\*[\s\S]*?\*\/[ \t]*(?:\r?\n)?/, '$1');
}

function stripLeadingPythonDocstring(code: string): string {
  return code.replace(/^(\uFEFF?\s*)("""|''')[\s\S]*?\2[ \t]*(?:\r?\n)?/, '$1');
}

function stripLeadingCodeIntroBlock(code: string, ext: string): string {
  if (ext === 'py') return stripLeadingPythonDocstring(code);

  const cStyleBlockCommentExts = new Set([
    'c', 'cpp', 'h', 'java', 'js', 'jsx', 'ts', 'tsx', 'css', 'sql',
  ]);
  if (cStyleBlockCommentExts.has(ext)) return stripLeadingCStyleBlockComment(code);

  return code;
}

export async function appendArtifactContents(
  parts: string[],
  artifacts: ArtifactRow[],
  settings: Pick<LLMSettings, 'artifactStripIntroBlocks' | 'artifactStripIntroBlocksDeprecated' | 'pdfRedactionTopCm'>,
  attachments: LLMImageAttachment[] = [],
): Promise<boolean> {
  let hasContent = false;
  const privacyMapper = createArtifactPrivacyMapper(artifacts);
  const codeExts: Record<string, string> = {
    py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    c: 'c', cpp: 'cpp', h: 'c', java: 'java', html: 'html', css: 'css', sql: 'sql', json: 'json',
  };

  for (const [index, artifact] of artifacts.entries()) {
    const ext = artifact.filename.split('.').pop()?.toLowerCase() || '';
    const filepath = resolveStoredPath(artifact.filepath);
    const resolvedArtifact = { ...artifact, filepath };
    const promptLabel = `산출물 ${index + 1}: ${privacyMapper.artifactName(artifact)}`;
    if (ext === 'hwpx') {
      try {
        const text = privacyMapper.sanitizeText(
          await extractHwpxText(fs.readFileSync(filepath), {
            skipFirstTableRow: settings.artifactStripIntroBlocksDeprecated,
          })
        );
        if (text) {
          const note = settings.artifactStripIntroBlocksDeprecated
            ? 'HWPX XML 텍스트 추출: 첫 표 행 제외'
            : 'HWPX XML 텍스트 추출';
          parts.push(`[${promptLabel}]\n[${note}]\n${text}\n---`);
          hasContent = true;
        }
      } catch { /* skip */ }
    } else if (ext === 'ipynb') {
      try {
        const text = privacyMapper.sanitizeText(
          extractIpynbInputText(fs.readFileSync(filepath), {
            skipFirstMarkdownCell: settings.artifactStripIntroBlocksDeprecated,
          })
        );
        if (text) {
          const note = settings.artifactStripIntroBlocksDeprecated
            ? 'Jupyter Notebook 입력 추출: 첫 마크다운 셀 및 실행 결과 제외'
            : 'Jupyter Notebook 입력 추출: 실행 결과 제외';
          parts.push(`[${promptLabel}]\n[${note}]\n${text}\n---`);
          hasContent = true;
        }
      } catch { /* skip */ }
      const evidence = await buildNotebookExecutionEvidence(
        resolvedArtifact,
        artifacts.map((item) => ({ ...item, filepath: resolveStoredPath(item.filepath) })),
        privacyMapper.artifactName(artifact),
        { skipFirstMarkdownCell: settings.artifactStripIntroBlocksDeprecated },
      );
      if (!evidence.executionSucceeded) {
        throw new Error(`${promptLabel} 노트북 재실행 실패: ${evidence.executionError || '원인을 확인할 수 없습니다.'}`);
      }
      const text = privacyMapper.sanitizeText(evidence.text);
      if (text) {
        parts.push(`[${promptLabel}]\n${text}\n---`);
        hasContent = true;
      }
      attachments.push(...evidence.attachments);
    } else if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) {
      try {
        const text = privacyMapper.sanitizeText(await buildTabularDataEvidence(resolvedArtifact));
        if (text) {
          parts.push(`[${promptLabel}]\n${text}\n---`);
          hasContent = true;
        }
      } catch { /* skip */ }
    } else if (codeExts[ext]) {
      let code: string | null = null;
      try {
        const rawCode = fs.readFileSync(filepath, 'utf-8');
        code = privacyMapper.sanitizeText(
          settings.artifactStripIntroBlocks ? stripLeadingCodeIntroBlock(rawCode, ext) : rawCode
        );
      } catch { /* skip */ }
      if (code !== null) {
        let executionText = '';
        if (ext === 'py') {
          const evidence = await buildPythonFileExecutionEvidence(
            resolvedArtifact,
            artifacts.map(item => ({ ...item, filepath: resolveStoredPath(item.filepath) })),
            privacyMapper.artifactName(artifact),
          );
          if (!evidence.executionSucceeded) {
            throw new Error(`${promptLabel} Python 실행 실패: ${evidence.executionError || '원인을 확인할 수 없습니다.'}`);
          }
          executionText = `\n${privacyMapper.sanitizeText(evidence.text)}`;
        }
        parts.push(`[${promptLabel}]\n\`\`\`${codeExts[ext]}\n${code}\n\`\`\`${executionText}\n---`);
        hasContent = true;
      }
    } else if (artifact.mime_type === 'text/plain' || ext === 'txt') {
      try {
        let text: string;
        try {
          text = fs.readFileSync(filepath, 'utf-8');
        } catch {
          text = fs.readFileSync(filepath, 'utf16le');
        }
        text = privacyMapper.sanitizeText(text);
        parts.push(`[${promptLabel}]\n${text}\n---`);
        hasContent = true;
      } catch { /* skip */ }
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      try {
        attachments.push(imageFileToAttachment(filepath, privacyMapper.artifactName(artifact), ext));
        parts.push(`[${promptLabel}] (이미지 파일 첨부)\n---`);
        hasContent = true;
      } catch { /* skip */ }
    } else if (artifact.mime_type === 'application/pdf' || ext === 'pdf') {
      try {
        const topHeightCm = settings.artifactStripIntroBlocks ? settings.pdfRedactionTopCm : 0;
        const pdfAttachments = await pdfToRedactedJpegAttachments(
          filepath,
          privacyMapper.artifactName(artifact),
          topHeightCm,
        );
        attachments.push(...pdfAttachments);
        parts.push(`[${promptLabel}] (원본 PDF를 LLM 입력용 이미지 ${pdfAttachments.length}쪽으로 변환해 첨부${topHeightCm > 0 ? `, 첫 페이지 상단 ${topHeightCm}cm 제거` : ''})\n---`);
        if (pdfAttachments.length > 0) hasContent = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`${promptLabel}의 PDF 이미지 변환에 실패했습니다. 채점을 중단했습니다. ${message}`);
      }
    }
  }

  return hasContent;
}

export type ArtifactPromptPreparation =
  | { ok: true; hasContent: boolean; attachments: LLMImageAttachment[] }
  | { ok: false; hasContent: false; attachments: LLMImageAttachment[]; error: string };

/**
 * Shared boundary for every LLM workflow that consumes student artifacts.
 * It keeps notebook/PDF execution failures out of provider requests while
 * returning one consistent error shape to scoring and activity workflows.
 */
export async function prepareArtifactPromptContents(
  parts: string[],
  artifacts: ArtifactRow[],
  settings: Pick<LLMSettings, 'artifactStripIntroBlocks' | 'artifactStripIntroBlocksDeprecated' | 'pdfRedactionTopCm'>,
): Promise<ArtifactPromptPreparation> {
  const attachments: LLMImageAttachment[] = [];
  try {
    const hasContent = await appendArtifactContents(parts, artifacts, settings, attachments);
    return { ok: true, hasContent, attachments };
  } catch (error) {
    return {
      ok: false,
      hasContent: false,
      attachments: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}


