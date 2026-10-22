import multer from 'multer';
import { HttpError } from '../errors.js';

export const body = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });

export function notFound(_req, res) {
  res.status(404).json(body('not_found', 'The requested resource does not exist.'));
}

/** Converts errors to JSON responses. Stack traces and internal messages are never returned. */
export function errorHandler(log = console) {
  // Express identifies error handlers by their four parameters.
  return (error, req, res, _next) => {
    if (res.headersSent) return res.end();

    if (error instanceof HttpError) {
      if (error.status === 503) res.set('Retry-After', '30');
      return res.status(error.status).json(body(error.code, error.message, error.details));
    }
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res
        .status(tooLarge ? 413 : 400)
        .json(body(tooLarge ? 'file_too_large' : 'upload_rejected', tooLarge ? 'The file exceeds the size limit.' : 'The upload was rejected.'));
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json(body('payload_too_large', 'The request body is too large.'));
    }
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json(body('invalid_json', 'The request body is not valid JSON.'));
    }

    log.error(`${req.method} ${req.path}: ${error.stack ?? error}`);
    return res.status(500).json(body('internal_error', 'An internal error occurred.'));
  };
}
