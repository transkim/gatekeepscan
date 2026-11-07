const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildPdf } = require('../app/js/pdf.js');

const jpeg = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.jpg')));

function parse(bytes) {
  return Buffer.from(bytes).toString('latin1');
}

test('builds a valid multi-page PDF with a correct xref table', () => {
  const pdf = buildPdf([
    { jpeg, width: 40, height: 30 },
    { jpeg, width: 40, height: 30, words: [{ text: 'Invoice', x0: 2, y0: 2, x1: 30, y1: 10 }] },
  ], { pageSize: 'a4', title: 'Test – scan' });
  const s = parse(pdf);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/Count 2/);
  const xrefPos = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.strictEqual(s.slice(xrefPos, xrefPos + 4), 'xref');
  const entries = s.slice(xrefPos).split('\n').slice(2).filter((l) => / n $/.test(l));
  entries.forEach((line, i) => {
    const off = Number(line.slice(0, 10));
    assert.strictEqual(s.slice(off, off + String(i + 1).length + 6), (i + 1) + ' 0 obj', 'object ' + (i + 1));
  });
});

test('OCR words become extractable text', (t) => {
  let has = true;
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { has = false; }
  if (!has) return t.skip('pdftotext not installed');
  const pdf = buildPdf([{ jpeg, width: 40, height: 30, words: [{ text: 'Receipt', x0: 2, y0: 2, x1: 30, y1: 10 }] }], { pageSize: 'fit' });
  const f = path.join(require('os').tmpdir(), 'pk-test.pdf');
  fs.writeFileSync(f, pdf);
  const text = execFileSync('pdftotext', [f, '-']).toString();
  assert.match(text, /Receipt/);
});
