import assert from 'node:assert/strict';
import { createArtifactPrivacyMapper, type ArtifactRow } from './artifactPrompt';

function artifact(id: number, filename: string): ArtifactRow {
  return { id, filename, filepath: `/tmp/${filename}`, mime_type: 'text/plain' };
}

function run(): void {
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
}

run();
console.log('artifact prompt privacy tests passed');
