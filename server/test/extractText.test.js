import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractText, MAX_TEXT_CHARS, tidy } from '../src/extractText.js';
import { makePdf } from './makePdf.js';

const pdfUpload = (buffer, filename = 'resume.pdf') => ({
  filename,
  contentType: 'application/pdf',
  encoding: 'base64',
  content: buffer.toString('base64'),
});
const textUpload = (content, filename = 'resume.txt') => ({ filename, contentType: 'text/plain', encoding: 'utf8', content });

const LINES = ['Sample Candidate', 'Data analyst with five years of experience', 'Skills: SQL, Python, dashboards'];

describe('extractText: .txt', () => {
  it('returns the text with the file name and no raw content', async () => {
    const result = await extractText(textUpload('  Skills: SQL and Python for reporting.\n\n\n\nExperience: five years.  '));
    assert.deepEqual(Object.keys(result).sort(), ['filename', 'text']);
    assert.equal(result.text, 'Skills: SQL and Python for reporting.\n\nExperience: five years.');
  });

  it('refuses empty, too short and too long text', async () => {
    await assert.rejects(() => extractText(textUpload('   \n  ')), { code: 'no_text' });
    await assert.rejects(() => extractText(textUpload('Too short.')), { code: 'text_too_short' });
    await assert.rejects(() => extractText(textUpload('word '.repeat(MAX_TEXT_CHARS / 4))), { code: 'text_too_long' });
  });
});

describe('extractText: .pdf', () => {
  it('reads the text of a PDF in Node', async () => {
    const result = await extractText(pdfUpload(makePdf(LINES)));
    assert.equal(result.filename, 'resume.pdf');
    for (const line of LINES) assert.ok(result.text.includes(line), line);
  });

  it('keeps the line breaks of a simple document', async () => {
    const { text } = await extractText(pdfUpload(makePdf(LINES)));
    assert.ok(text.split('\n').length >= 3);
  });

  it('says so when a PDF holds no text, as a scanned document does', async () => {
    await assert.rejects(() => extractText(pdfUpload(makePdf([]))), { code: 'no_text', status: 422 });
  });

  it('refuses a damaged PDF with a clear message', async () => {
    const damaged = Buffer.from('%PDF-1.4\nthis is not a real document\n');
    await assert.rejects(() => extractText(pdfUpload(damaged)), (error) => error.code === 'unreadable_pdf' && /damaged or protected/.test(error.message));
  });

  it('refuses a truncated PDF', async () => {
    const whole = makePdf(LINES);
    await assert.rejects(() => extractText(pdfUpload(whole.subarray(0, 120))), { code: 'unreadable_pdf' });
  });
});

describe('tidy', () => {
  it('removes control characters and collapses blank lines', () => {
    assert.equal(tidy('a\u0000b\r\n\r\n\r\n\r\nc  \n'), 'ab\n\nc');
  });
});
