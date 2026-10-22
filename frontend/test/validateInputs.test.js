import { describe, expect, it } from 'vitest';
import { demoProject, getProject } from '../src/data/projects.js';
import { formatWait, noticeFromApiError, retryMessage } from '../src/lib/notices.js';
import { ApiError, parseRetryAfter } from '../src/lib/api.js';
import {
  buildRequest,
  formatBytes,
  inSentence,
  initialValues,
  MAX_UPLOAD_BYTES,
  validateField,
  validateForm,
} from '../src/lib/validateInputs.js';

const file = (name, size = 10) => ({ name, size });
const text = { key: 'topic', label: 'Topic', type: 'text', required: true, minLength: 3, maxLength: 20 };

describe('inSentence', () => {
  it('lower-cases the first letter but keeps acronyms', () => {
    expect(inSentence('Support ticket')).toBe('support ticket');
    expect(inSentence('URL')).toBe('URL');
    expect(inSentence('Article URL')).toBe('article URL');
  });
});

describe('text fields', () => {
  it('requires a value when the field is required', () => {
    expect(validateField(text, '')).toBe('The topic is required.');
    expect(validateField(text, '   ')).toBe('The topic is required.');
  });

  it('accepts an empty optional field', () => {
    expect(validateField({ ...text, required: false }, '')).toBeNull();
  });

  it('enforces minimum and maximum length on the trimmed text', () => {
    expect(validateField(text, ' ab ')).toBe('The topic must contain at least 3 characters.');
    expect(validateField(text, 'x'.repeat(21))).toBe('The topic must not exceed 20 characters.');
    expect(validateField(text, 'x'.repeat(20))).toBeNull();
  });

  it('uses the singular for a single character', () => {
    expect(validateField({ ...text, minLength: 1 }, '')).toBe('The topic is required.');
    expect(validateField({ ...text, minLength: 1, maxLength: 1 }, 'ab')).toBe('The topic must not exceed 1 character.');
  });

  it('rejects control characters', () => {
    expect(validateField(text, 'ab\u0000c')).toBe('The topic must not contain control characters.');
  });
});

describe('url fields', () => {
  const field = { key: 'site', label: 'Lead website', type: 'url', required: true };

  it('accepts https addresses', () => {
    expect(validateField(field, 'https://example.com/page?x=1')).toBeNull();
  });

  it.each(['http://example.com', 'example.com', 'ftp://example.com', 'javascript:alert(1)', 'https://'])('rejects %s', (value) => {
    expect(validateField(field, value)).toBe('Enter a web address that begins with https://.');
  });

  it('rejects embedded credentials', () => {
    expect(validateField(field, 'https://user:pass@example.com/')).toBe('The web address must not contain a user name or a password.');
  });
});

describe('url-list fields', () => {
  const field = { key: 'competitors', label: 'Competitor websites', type: 'urls', required: true, minItems: 1, maxItems: 3 };

  it('requires at least one address', () => {
    expect(validateField(field, [''])).toBe('Provide at least 1 web address.');
    expect(validateField(field, [])).toBe('Provide at least 1 web address.');
  });

  it('accepts one to three https addresses and ignores blank rows', () => {
    expect(validateField(field, ['https://a.example/', '', 'https://b.example/'])).toBeNull();
    expect(validateField(field, ['https://a.example/', 'https://b.example/', 'https://c.example/'])).toBeNull();
  });

  it('rejects more than three addresses', () => {
    const four = ['a', 'b', 'c', 'd'].map((x) => `https://${x}.example/`);
    expect(validateField(field, four)).toBe('Provide no more than 3 web addresses.');
  });

  it('names the address that is not valid', () => {
    expect(validateField(field, ['https://a.example/', 'http://b.example/'])).toBe('Address 2: enter a web address that begins with https://.');
  });
});

describe('file fields', () => {
  const field = { key: 'transcript', label: 'Meeting transcript', type: 'file', required: true, extensions: ['.txt'], maxFiles: 1 };

  it('requires a file', () => {
    expect(validateField(field, [])).toBe('Select a file.');
    expect(validateField({ ...field, maxFiles: 5 }, [])).toBe('Select at least one file.');
  });

  it('accepts a permitted type regardless of letter case', () => {
    expect(validateField(field, [file('notes.txt')])).toBeNull();
    expect(validateField(field, [file('NOTES.TXT')])).toBeNull();
  });

  it('rejects other types and names without an extension', () => {
    expect(validateField(field, [file('notes.pdf')])).toBe('The file notes.pdf is not an accepted type. Accepted types: .txt.');
    expect(validateField(field, [file('notes')])).toContain('not an accepted type');
    expect(validateField(field, [file('notes.txt.exe')])).toContain('not an accepted type');
  });

  it('enforces the 2 MB limit before upload', () => {
    expect(validateField(field, [file('a.txt', MAX_UPLOAD_BYTES)])).toBeNull();
    expect(validateField(field, [file('a.txt', MAX_UPLOAD_BYTES + 1)])).toBe('The file a.txt exceeds the limit of 2 MB.');
  });

  it('rejects empty files and too many files', () => {
    expect(validateField(field, [file('a.txt', 0)])).toBe('The file a.txt is empty.');
    expect(validateField(field, [file('a.txt'), file('b.txt')])).toBe('No more than 1 file may be selected.');
  });

  it('accepts an empty selection for an optional field', () => {
    expect(validateField({ ...field, required: false }, [])).toBeNull();
  });
});

describe('select fields', () => {
  const field = { key: 'tone', label: 'Tone', type: 'select', required: true, options: [{ value: 'formal', label: 'Formal' }] };

  it('requires a listed option', () => {
    expect(validateField(field, '')).toBe('Select a tone.');
    expect(validateField(field, 'casual')).toBe('Select one of the listed options for the tone.');
    expect(validateField(field, 'formal')).toBeNull();
  });
});

describe('validateForm', () => {
  it('reports every field at once', () => {
    const project = getProject('resume-screening-flow');
    const { errors, valid } = validateForm(project, initialValues(project));
    expect(valid).toBe(false);
    expect(Object.keys(errors)).toEqual(['job_description', 'resumes']);
  });

  it('treats alternatives as a group: one of them is enough', () => {
    const project = getProject('content-repurposing-flow');
    const none = validateForm(project, initialValues(project));
    expect(none.valid).toBe(false);
    expect(none.form).toBe('Provide one of the following: Article address, Article text or Article file.');

    const withUrl = validateForm(project, { ...initialValues(project), article_url: 'https://example.com/post' });
    expect(withUrl.valid).toBe(true);
    const withFile = validateForm(project, { ...initialValues(project), article_file: [file('a.txt')] });
    expect(withFile.valid).toBe(true);
  });

  it('still reports a bad alternative that was filled in', () => {
    const project = getProject('content-repurposing-flow');
    const { errors, valid } = validateForm(project, { ...initialValues(project), article_url: 'http://insecure.example' });
    expect(valid).toBe(false);
    expect(errors.article_url).toContain('https://');
  });

  it('accepts a complete demonstration form with an optional file left out', () => {
    expect(validateForm(demoProject, { topic: 'Farming', notes: [] }).valid).toBe(true);
  });
});

describe('buildRequest', () => {
  it('trims text, drops blank addresses and declares file counts', () => {
    const project = {
      inputs: [
        { key: 'topic', type: 'text' },
        { key: 'sites', type: 'urls' },
        { key: 'notes', type: 'file' },
        { key: 'empty', type: 'text' },
      ],
    };
    const upload = [file('a.txt'), file('b.txt')];
    const request = buildRequest(project, { topic: '  Farming ', sites: ['https://a.example/', ' '], notes: upload, empty: '' });
    expect(request.inputs).toEqual({ topic: 'Farming', sites: ['https://a.example/'] });
    expect(request.counts).toEqual({ notes: 2 });
    expect(request.files).toEqual([{ field: 'notes', files: upload }]);
  });

  it('declares no files when none were chosen', () => {
    const request = buildRequest(demoProject, { topic: 'x', notes: [] });
    expect(request.counts).toBeUndefined();
    expect(request.files).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('uses bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024)).toBe('50 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('notices', () => {
  it('describes waiting times', () => {
    expect(formatWait(1)).toBe('1 second');
    expect(formatWait(30)).toBe('30 seconds');
    expect(formatWait(61)).toBe('about 2 minutes');
    expect(formatWait(2520)).toBe('about 42 minutes');
    expect(formatWait(7200)).toBe('about 2 hours');
  });

  it('says when the visitor may retry, using the Retry-After value', () => {
    const now = new Date(2026, 9, 22, 14, 30, 0).getTime();
    const notice = noticeFromApiError(new ApiError(429, 'x', { retryAfter: 2520 }), now);
    expect(notice.kind).toBe('rate-limit');
    expect(notice.message).toBe('The limit on runs for this address has been reached. You may try again at 15:12 (in about 42 minutes).');
  });

  it('falls back gracefully without a Retry-After header', () => {
    expect(retryMessage(null)).toBe('Please try again later.');
    expect(noticeFromApiError(new ApiError(429, 'x')).message).toContain('Please try again later.');
  });

  it('reports capacity, connection and server faults without raw server text', () => {
    expect(noticeFromApiError(new ApiError(503, 'x', { retryAfter: 30 })).kind).toBe('capacity');
    expect(noticeFromApiError(new ApiError(0, '')).kind).toBe('connection');
    const fault = noticeFromApiError(new ApiError(500, 'TypeError at /srv/app/index.js:12'));
    expect(fault.message).not.toContain('index.js');
  });

  it('lists the fields the server did not accept', () => {
    const notice = noticeFromApiError(new ApiError(400, 'x', { details: [{ field: 'topic', message: 'is required' }] }));
    expect(notice.message).toContain('topic: is required');
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:30:00 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(120);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});
