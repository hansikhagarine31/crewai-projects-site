import { rateLimit } from 'express-rate-limit';
import { body } from './errors.js';

function limiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json(body('rate_limited', message)),
  });
}

/** Limits how many runs one client address may start per window. */
export const runLimiter = ({ rateLimitRuns, rateLimitWindowMs }) =>
  limiter({
    windowMs: rateLimitWindowMs,
    limit: rateLimitRuns,
    message: 'The limit on runs for this address has been reached. Please try again later.',
  });

/** A generous ceiling for all other API requests from one address. */
export const apiLimiter = () =>
  limiter({ windowMs: 15 * 60 * 1000, limit: 1000, message: 'Too many requests. Please try again later.' });
