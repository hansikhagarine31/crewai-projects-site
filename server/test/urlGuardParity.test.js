import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { validateInputUrl } from '../src/security/urlGuard.js';

const cases = JSON.parse(readFileSync(new URL('../../shared/url-guard-cases.json', import.meta.url), 'utf8'));
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

// The agents service checks the same cases with its own guard (agents/tests/test_url_guard_parity.py).
describe('the URL guard gives the answers in shared/url-guard-cases.json', () => {
  for (const url of cases.accepted) {
    it(`accepts ${url}`, async () => {
      await validateInputUrl(url, { lookup: publicLookup });
    });
  }
  for (const url of cases.rejected) {
    it(`rejects ${JSON.stringify(url)}`, async () => {
      await assert.rejects(() => validateInputUrl(url, { lookup: publicLookup }));
    });
  }
});
