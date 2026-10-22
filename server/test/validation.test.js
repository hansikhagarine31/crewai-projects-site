import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRunRequest } from '../src/validation.js';

const project = {
  inputs: [
    { key: 'mode', label: 'Mode', type: 'select', required: true, options: [{ value: 'short', label: 'Short' }, { value: 'long', label: 'Long' }] },
    { key: 'notes', label: 'Notes', type: 'file', required: false, extensions: ['.txt'], maxFiles: 1 },
  ],
};

describe('validateRunRequest: select fields', () => {
  it('accepts a listed option', async () => {
    const { inputs } = await validateRunRequest(project, { inputs: { mode: 'short' } });
    assert.deepEqual(inputs, { mode: 'short' });
  });

  it('rejects an unlisted option and a missing value', async () => {
    await assert.rejects(() => validateRunRequest(project, { inputs: { mode: 'medium' } }), { code: 'validation_failed' });
    await assert.rejects(() => validateRunRequest(project, { inputs: {} }), { code: 'validation_failed' });
  });

  it('keeps an optional file field optional', async () => {
    const { expectedFiles } = await validateRunRequest(project, { inputs: { mode: 'long' } });
    assert.deepEqual(expectedFiles, {});
  });
});
