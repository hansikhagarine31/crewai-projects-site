/**
 * Client-side validation of a project's input form. The server validates again; these
 * checks exist so that mistakes are reported before anything is uploaded.
 *
 * Values by field type: text, url, select: string; urls: string[]; file: File[].
 * Messages are formal British English.
 */

/** The server's default upload limit (UPLOAD_MAX_BYTES in server/src/config.js). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** A label as it reads inside a sentence: "Support ticket" becomes "support ticket", "URL" stays. */
export function inSentence(label) {
  const [first = '', second = ''] = label;
  const acronym = first === first.toUpperCase() && second === second.toUpperCase() && /[A-Z]/.test(second);
  return acronym ? label : first.toLowerCase() + label.slice(1);
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const sizeLimit = `${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`;

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** True for a missing value, an empty string, or a list whose items are all blank (an empty list too). */
export const isEmptyValue = (value) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.every((item) => item === '' || item === undefined));

/** Returns an error message for one https address, or null when it is acceptable. */
export function checkHttpsUrl(text) {
  const message = 'Enter a web address that begins with https://.';
  const value = text.trim();
  if (value.length > MAX_URL_LENGTH) return `The web address must not exceed ${MAX_URL_LENGTH} characters.`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return message;
  }
  if (url.protocol !== 'https:' || !url.hostname) return message;
  if (url.username || url.password) return 'The web address must not contain a user name or a password.';
  return null;
}

function checkText(field, value) {
  const name = inSentence(field.label);
  if (typeof value !== 'string' || value.trim() === '') return field.required ? `The ${name} is required.` : null;
  const text = value.trim();
  if (CONTROL_CHARACTERS.test(text)) return `The ${name} must not contain control characters.`;
  if (field.minLength && text.length < field.minLength) {
    return `The ${name} must contain at least ${plural(field.minLength, 'character', 'characters')}.`;
  }
  if (field.maxLength && text.length > field.maxLength) {
    return `The ${name} must not exceed ${plural(field.maxLength, 'character', 'characters')}.`;
  }
  return null;
}

function checkUrl(field, value) {
  if (isEmptyValue(value)) return field.required ? `The ${inSentence(field.label)} is required.` : null;
  return checkHttpsUrl(value);
}

function checkUrls(field, value) {
  const items = (value ?? []).map((item) => item.trim()).filter(Boolean);
  const min = field.minItems ?? 1;
  const max = field.maxItems ?? 3;
  if (items.length === 0) return field.required ? `Provide at least ${plural(min, 'web address', 'web addresses')}.` : null;
  if (items.length < min) return `Provide at least ${plural(min, 'web address', 'web addresses')}.`;
  if (items.length > max) return `Provide no more than ${plural(max, 'web address', 'web addresses')}.`;
  for (const [index, item] of items.entries()) {
    const problem = checkHttpsUrl(item);
    if (problem) return `Address ${index + 1}: ${problem[0].toLowerCase()}${problem.slice(1)}`;
  }
  return null;
}

function checkFiles(field, value) {
  const files = value ?? [];
  if (files.length === 0) return field.required ? (field.maxFiles > 1 ? 'Select at least one file.' : 'Select a file.') : null;
  if (files.length > field.maxFiles) return `No more than ${plural(field.maxFiles, 'file', 'files')} may be selected.`;
  const accepted = field.extensions.map((extension) => extension.toLowerCase());
  for (const file of files) {
    const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
    if (!accepted.includes(extension)) {
      return `The file ${file.name} is not an accepted type. Accepted types: ${accepted.join(', ')}.`;
    }
    if (file.size === 0) return `The file ${file.name} is empty.`;
    if (file.size > MAX_UPLOAD_BYTES) return `The file ${file.name} exceeds the limit of ${sizeLimit}.`;
  }
  return null;
}

function checkSelect(field, value) {
  const listed = (field.options ?? []).some((option) => option.value === value);
  if (value === undefined || value === '') return field.required ? `Select a ${inSentence(field.label)}.` : null;
  return listed ? null : `Select one of the listed options for the ${inSentence(field.label)}.`;
}

const CHECKS = { text: checkText, url: checkUrl, urls: checkUrls, file: checkFiles, select: checkSelect };

/** Error message for one field, or null. */
export function validateField(field, value) {
  return CHECKS[field.type](field, value);
}

/**
 * Validates every field. Returns { errors, form } where errors maps field keys to messages and
 * form is a message about the form as a whole (for projects that need one of several inputs).
 */
export function validateForm(project, values) {
  const errors = {};
  const alternatives = new Set(project.requireAnyOf ?? []);

  for (const field of project.inputs) {
    // Alternatives are each optional on their own; the group is checked below.
    const effective = alternatives.has(field.key) ? { ...field, required: false } : field;
    const message = validateField(effective, values[field.key]);
    if (message) errors[field.key] = message;
  }

  let form = null;
  if (alternatives.size > 0) {
    const supplied = project.inputs.some((field) => alternatives.has(field.key) && !isEmptyValue(values[field.key]));
    if (!supplied) {
      const labels = project.inputs.filter((field) => alternatives.has(field.key)).map((field) => field.label);
      const listed = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}` : labels[0];
      form = `Provide one of the following: ${listed}.`;
    }
  }
  return { errors, form, valid: Object.keys(errors).length === 0 && form === null };
}

/** The empty value for a field type. */
export function emptyValue(field) {
  if (field.type === 'urls') return [''];
  if (field.type === 'file') return [];
  return '';
}

export const initialValues = (project) => Object.fromEntries(project.inputs.map((field) => [field.key, emptyValue(field)]));

/** Splits form values into the request body the server expects, and the files to upload. */
export function buildRequest(project, values) {
  const inputs = {};
  const files = [];
  for (const field of project.inputs) {
    const value = values[field.key];
    if (field.type === 'file') {
      if (value?.length) files.push({ field: field.key, files: value });
    } else if (field.type === 'urls') {
      const items = value.map((item) => item.trim()).filter(Boolean);
      if (items.length) inputs[field.key] = items;
    } else if (typeof value === 'string' && value.trim() !== '') {
      inputs[field.key] = value.trim();
    }
  }
  const counts = Object.fromEntries(files.map((entry) => [entry.field, entry.files.length]));
  return { inputs, counts: files.length ? counts : undefined, files };
}
