import { HttpError } from './errors.js';
import { validateInputUrl } from './security/urlGuard.js';

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

async function checkField(field, value, validateUrl) {
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') throw new Error('must be text');
      const text = value.trim();
      if (CONTROL_CHARACTERS.test(text)) throw new Error('contains control characters');
      if (text.length < (field.minLength ?? 1)) throw new Error(`must contain at least ${field.minLength ?? 1} characters`);
      if (text.length > field.maxLength) throw new Error(`must contain at most ${field.maxLength} characters`);
      return text;
    }
    case 'url':
      return validateUrl(value);
    case 'urls': {
      if (!Array.isArray(value)) throw new Error('must be a list of URLs');
      if (value.length < (field.minItems ?? 1)) throw new Error(`must contain at least ${field.minItems ?? 1} URL`);
      if (value.length > field.maxItems) throw new Error(`must contain at most ${field.maxItems} URLs`);
      return Promise.all(value.map((item) => validateUrl(item)));
    }
    case 'select': {
      if (typeof value !== 'string' || !field.options?.some((option) => option.value === value)) {
        throw new Error('must be one of the listed options');
      }
      return value;
    }
    default:
      throw new Error('has an unsupported type');
  }
}

/**
 * Validates a run request against the project definition.
 * `body.inputs` holds text and URL fields; `body.files` declares how many files
 * will be uploaded for each file field, for example { "resumes": 3 }.
 * Returns { inputs, expectedFiles }.
 */
export async function validateRunRequest(project, body, { validateUrl = validateInputUrl } = {}) {
  const supplied = body?.inputs ?? {};
  const declared = body?.files ?? {};
  if (typeof supplied !== 'object' || Array.isArray(supplied) || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new HttpError(400, 'validation_failed', 'The request body is malformed.');
  }

  const problems = [];
  const inputs = {};
  const expectedFiles = {};
  const fields = new Map(project.inputs.map((field) => [field.key, field]));

  for (const key of [...Object.keys(supplied), ...Object.keys(declared)]) {
    if (!fields.has(key)) problems.push({ field: key, message: 'is not an input of this project' });
  }

  for (const field of project.inputs) {
    if (field.type === 'file') {
      const count = declared[field.key];
      if (count === undefined || count === 0) {
        if (field.required && !project.requireAnyOf?.includes(field.key)) {
          problems.push({ field: field.key, message: 'is required' });
        }
        continue;
      }
      if (!Number.isInteger(count) || count < 1 || count > field.maxFiles) {
        problems.push({ field: field.key, message: `must declare between 1 and ${field.maxFiles} files` });
        continue;
      }
      expectedFiles[field.key] = count;
      continue;
    }

    const value = supplied[field.key];
    const missing = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (missing) {
      // Fields that are alternatives to one another are checked together, below.
      if (field.required && !project.requireAnyOf?.includes(field.key)) problems.push({ field: field.key, message: 'is required' });
      continue;
    }
    try {
      inputs[field.key] = await checkField(field, value, validateUrl);
    } catch (error) {
      problems.push({ field: field.key, message: error.message });
    }
  }

  if (project.requireAnyOf) {
    // An alternative that was supplied but is invalid has its own message; do not also say that none was given.
    const present = project.requireAnyOf.some(
      (key) => inputs[key] !== undefined || expectedFiles[key] !== undefined || problems.some((problem) => problem.field === key),
    );
    if (!present) {
      problems.push({ field: project.requireAnyOf.join(' or '), message: 'one of these is required' });
    }
  }

  if (problems.length) throw new HttpError(400, 'validation_failed', 'The inputs are not valid.', problems);
  return { inputs, expectedFiles };
}

export const FEEDBACK_MAX_LENGTH = 2000;

/** Validates a reviewer's decision: { decision: "approved" | "revise", feedback }. Feedback is required to revise. */
export function validateDecision(body) {
  const decision = body?.decision;
  if (decision !== 'approved' && decision !== 'revise') {
    throw new HttpError(400, 'validation_failed', 'The decision must be "approved" or "revise".', [
      { field: 'decision', message: 'must be "approved" or "revise"' },
    ]);
  }
  if (decision === 'approved') return { decision, feedback: '' }; // any feedback sent with an approval is ignored

  const feedback = body.feedback;
  const problem =
    typeof feedback !== 'string'
      ? 'is required to request a revision'
      : !feedback.trim()
        ? 'is required to request a revision'
        : feedback.trim().length > FEEDBACK_MAX_LENGTH
          ? `must contain at most ${FEEDBACK_MAX_LENGTH} characters`
          : CONTROL_CHARACTERS.test(feedback.trim())
            ? 'contains control characters'
            : null;
  if (problem) throw new HttpError(400, 'validation_failed', 'The decision is not valid.', [{ field: 'feedback', message: problem }]);
  return { decision, feedback: feedback.trim() };
}
