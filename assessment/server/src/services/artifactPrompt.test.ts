import assert from 'node:assert/strict';
import { createArtifactPrivacyMapper, prepareArtifactPromptContents, type ArtifactRow } from './artifactPrompt';

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

  const preparation = await prepareArtifactPromptContents([], [], {
    artifactStripIntroBlocks: true,
    artifactStripIntroBlocksDeprecated: false,
    pdfRedactionTopCm: 0,
  });
  assert.deepEqual(preparation, { ok: true, hasContent: false, attachments: [] });
}

run().then(() => console.log('artifact prompt privacy tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
