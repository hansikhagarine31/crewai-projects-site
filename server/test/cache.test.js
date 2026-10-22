import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cacheKey, createCache } from '../src/cache.js';

describe('cacheKey', () => {
  it('is a SHA-256 hex digest', () => {
    assert.match(cacheKey('demo', { topic: 'a' }), /^[0-9a-f]{64}$/);
  });

  it('ignores key order, surrounding space and repeated whitespace', () => {
    const a = cacheKey('demo', { topic: 'AI in  farming', audience: 'farmers' });
    const b = cacheKey('demo', { audience: ' farmers ', topic: 'AI in farming' });
    assert.equal(a, b);
  });

  it('separates projects and different inputs', () => {
    assert.notEqual(cacheKey('demo', { topic: 'a' }), cacheKey('other', { topic: 'a' }));
    assert.notEqual(cacheKey('demo', { topic: 'a' }), cacheKey('demo', { topic: 'b' }));
    assert.notEqual(cacheKey('demo', { urls: ['https://a.example/', 'https://b.example/'] }), cacheKey('demo', { urls: ['https://b.example/', 'https://a.example/'] }));
  });

  it('identifies uploaded files by content, not by name', () => {
    const file = (filename, content) => [{ filename, contentType: 'text/plain', encoding: 'utf8', content }];
    assert.equal(cacheKey('demo', { t: file('a.txt', 'same') }), cacheKey('demo', { t: file('b.txt', 'same') }));
    assert.notEqual(cacheKey('demo', { t: file('a.txt', 'one') }), cacheKey('demo', { t: file('a.txt', 'two') }));
  });
});

describe('cache', () => {
  const clockCache = (options) => {
    const clock = { time: 0 };
    return { cache: createCache({ ...options, now: () => clock.time }), clock };
  };

  it('returns a stored entry before the time-to-live elapses', () => {
    const { cache, clock } = clockCache({ ttlMs: 1_000 });
    cache.set('k', { events: [1], result: 'r', files: [] });
    clock.time = 999;
    assert.deepEqual(cache.get('k').events, [1]);
  });

  it('drops an entry after the time-to-live', () => {
    const { cache, clock } = clockCache({ ttlMs: 1_000 });
    cache.set('k', { events: [], result: null, files: [] });
    clock.time = 1_001;
    assert.equal(cache.get('k'), undefined);
    assert.equal(cache.size(), 0);
  });

  it('evicts the oldest entry beyond the maximum', () => {
    const { cache } = clockCache({ maxEntries: 2 });
    cache.set('a', {});
    cache.set('b', {});
    cache.set('c', {});
    assert.equal(cache.get('a'), undefined);
    assert.ok(cache.get('b') && cache.get('c'));
  });

  it('returns undefined for unknown keys', () => {
    assert.equal(createCache().get('missing'), undefined);
  });
});
