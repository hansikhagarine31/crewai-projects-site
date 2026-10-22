import { PDFParse } from 'pdf-parse';
import { HttpError } from './errors.js';

export const MAX_TEXT_CHARS = 20000;
export const MIN_TEXT_CHARS = 20;
const MAX_PDF_PAGES = 10;
const PDF_TIMEOUT_MS = 15000;

// Control characters other than tab and newline, and the replacement character PDFs often yield.
const NOISE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�]/g;

/** Tidies extracted text: no control characters, no trailing spaces, no long runs of blank lines. */
export function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(NOISE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function pdfText(base64) {
  const parser = new PDFParse({ data: new Uint8Array(Buffer.from(base64, 'base64')) });
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), PDF_TIMEOUT_MS);
    });
    const result = await Promise.race([parser.getText({ first: MAX_PDF_PAGES, pageJoiner: '\n\n' }), timeout]);
    return result.text ?? '';
  } catch (error) {
    if (error.message === 'timeout') {
      throw new HttpError(422, 'pdf_timeout', 'The PDF took too long to read. Please upload a simpler or text version.');
    }
    throw new HttpError(422, 'unreadable_pdf', 'The PDF could not be read. It may be damaged or protected by a password.');
  } finally {
    clearTimeout(timer);
    await parser.destroy().catch(() => {});
  }
}

/**
 * Extracts plain text from an inspected upload (see inspectUpload): a .txt file already holds text,
 * a .pdf is parsed in this process. Raw files are never passed on; only the text is.
 * Returns the upload with `text` in place of `content`.
 */
export async function extractText(file) {
  const raw = file.encoding === 'base64' ? await pdfText(file.content) : file.content;
  const text = tidy(raw);

  if (text.length === 0) {
    throw new HttpError(
      422,
      'no_text',
      'No text could be found in the file. A scanned document is an image; please upload a text version.',
    );
  }
  if (text.length < MIN_TEXT_CHARS) {
    throw new HttpError(400, 'text_too_short', `The text of the file must contain at least ${MIN_TEXT_CHARS} characters.`);
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new HttpError(400, 'text_too_long', `The text of the file exceeds the limit of ${MAX_TEXT_CHARS} characters.`);
  }
  return { filename: file.filename, text };
}
