import path from 'node:path';
import multer from 'multer';
import { HttpError } from './errors.js';

const ALLOWED_EXTENSIONS = new Set(['.txt', '.csv', '.pdf']);

/** Builds the multer middleware: one in-memory file per request, size-limited. */
export function createUploadMiddleware({ maxBytes }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5, fieldSize: 1024 },
  }).single('file');
}

/** Reduces a client file name to a safe display name. */
export function cleanUploadName(original) {
  const base = path.basename(String(original ?? '').replace(/\\/g, '/'));
  return base.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100) || 'upload';
}

function isUtf8Text(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks the extension against the allowlist and the field, then checks the
 * content signature. Returns the file in the form passed to the agents service:
 * text as UTF-8, PDF as base64.
 */
export function inspectUpload(file, field) {
  const name = cleanUploadName(file.originalname);
  const extension = path.extname(name).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(extension) || !field.extensions.includes(extension)) {
    throw new HttpError(415, 'unsupported_file', `This input accepts only ${field.extensions.join(', ')} files.`);
  }
  if (file.size === 0) throw new HttpError(400, 'empty_file', 'The file is empty.');

  if (extension === '.pdf') {
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new HttpError(415, 'bad_signature', 'The file content is not a PDF document.');
    }
    return { filename: name, contentType: 'application/pdf', encoding: 'base64', content: file.buffer.toString('base64') };
  }

  if (!isUtf8Text(file.buffer)) {
    throw new HttpError(415, 'bad_signature', 'The file content is not plain UTF-8 text.');
  }
  const contentType = extension === '.csv' ? 'text/csv' : 'text/plain';
  return { filename: name, contentType, encoding: 'utf8', content: file.buffer.toString('utf8') };
}
