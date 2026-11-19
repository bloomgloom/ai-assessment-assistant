import assert from 'node:assert/strict';
import { createArtifactPrivacyMapper, type ArtifactRow } from './artifactPrompt';
import { storedArtifactFilename } from './artifactStorageFilename';

const stored = storedArtifactFilename(20101, '홍길동', 'b.csv', {
  now: 1795000000000,
  randomHex: 'a8f31c92d5e7401b',
});
assert.equal(stored, '1795000000000_20101_홍길동_a8f31c92d5e7401b_b.csv');

const longStored = storedArtifactFilename(20101, '홍길동', `${'아주긴이름'.repeat(80)}.ipynb`, {
  now: 1795000000000,
  randomHex: 'a8f31c92d5e7401b',
});
assert.ok(Buffer.byteLength(longStored) <= 240);
assert.ok(longStored.endsWith('.ipynb'));

const artifacts: ArtifactRow[] = [
  {
    id: 1,
    filename: 'a.ipynb',
    filepath: `uploads/artifacts/1795000000000_20101_홍길동_a8f31c92d5e7401b_a.ipynb`,
    mime_type: 'application/x-ipynb+json',
  },
  {
    id: 2,
    filename: 'b.csv',
    filepath: `uploads/artifacts/1795000000001_20101_홍길동_b9f31c92d5e7401c_b.csv`,
    mime_type: 'text/csv',
  },
];
const mapper = createArtifactPrivacyMapper(artifacts);
assert.equal(mapper.artifactName(artifacts[0]), 'file_001.ipynb');
assert.equal(mapper.artifactName(artifacts[1]), 'file_002.csv');
assert.equal(mapper.sanitizeText('df = pd.read_csv("b.csv")'), 'df = pd.read_csv("file_002.csv")');
assert.ok(!mapper.sanitizeText('df = pd.read_csv("b.csv")').includes('1795000000001'));
