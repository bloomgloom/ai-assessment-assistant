import assert from 'node:assert/strict';
import {
  artifactIntroStripOptions,
  createArtifactPrivacyMapper,
  extractIpynbInputText,
  prepareArtifactPromptContents,
  type ArtifactRow,
} from './artifactPrompt';

function artifact(id: number, filename: string): ArtifactRow {
  return { id, filename, filepath: `/tmp/${filename}`, mime_type: 'text/plain' };
}

async function run(): Promise<void> {
  const csv = artifact(1, 'PC04(홍길동)_winequality-red.csv');
  const code = artifact(2, 'analysis.py');
  const mapper = createArtifactPrivacyMapper([csv, code]);

  assert.equal(mapper.artifactName(csv), 'file_001.csv');
  assert.equal(mapper.artifactName(code), 'file_002.py');
  assert.equal(
    mapper.sanitizeText('df = pd.read_csv("PC04(홍길동)_winequality-red.csv")'),
    'df = pd.read_csv("file_001.csv")',
  );
  assert.equal(
    mapper.sanitizeText(`df = pd.read_csv("${csv.filename.normalize('NFD')}")`),
    'df = pd.read_csv("file_001.csv")',
  );
  assert.equal(
    mapper.sanitizeText('다시 읽기: file_001.csv'),
    '다시 읽기: file_001.csv',
  );

  assert.deepEqual(
    artifactIntroStripOptions({ artifactStripIntroBlocks: true, pdfRedactionTopCm: 0 }),
    { skipFirstTableRow: true, skipFirstMarkdownCell: true },
  );
  assert.deepEqual(
    artifactIntroStripOptions({ artifactStripIntroBlocks: false, pdfRedactionTopCm: 0 }),
    { skipFirstTableRow: false, skipFirstMarkdownCell: false },
  );

  const notebook = Buffer.from(JSON.stringify({
    cells: [
      { cell_type: 'markdown', source: ['이름: 홍길동\n', '학번: 10101'] },
      { cell_type: 'code', source: ['print("학생 코드")'] },
    ],
  }));
  const maskedNotebookText = extractIpynbInputText(notebook, { skipFirstMarkdownCell: true });
  assert.doesNotMatch(maskedNotebookText, /홍길동|10101/);
  assert.match(maskedNotebookText, /print\("학생 코드"\)/);

  const preparation = await prepareArtifactPromptContents([], [], {
    artifactStripIntroBlocks: true,
    pdfRedactionTopCm: 0,
  });
  assert.deepEqual(preparation, { ok: true, hasContent: false, attachments: [] });
}

run().then(() => console.log('artifact prompt privacy tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
