import assert from 'node:assert/strict';
import { pdftoppmCandidates } from './pdfRenderer';

const configured = pdftoppmCandidates('darwin', {
  ASSESSMENT_PDFTOPPM: '/custom/poppler/bin/pdftoppm',
});
assert.equal(configured[0], '/custom/poppler/bin/pdftoppm');
assert.equal(configured.at(-1), 'pdftoppm');
assert.equal(new Set(configured).size, configured.length);

const windows = pdftoppmCandidates('win32', {});
assert.deepEqual(windows, ['pdftoppm']);
