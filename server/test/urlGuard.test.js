import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBlockedAddress, UrlGuardError, validateInputUrl } from '../src/security/urlGuard.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const lookupOf = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

const rejects = (url, code, options) =>
  assert.rejects(
    () => validateInputUrl(url, options),
    (error) => error instanceof UrlGuardError && (code === undefined || error.code === code),
  );

describe('validateInputUrl: scheme and shape', () => {
  it('accepts http and https URLs with a public address', async () => {
    assert.equal(await validateInputUrl('https://example.com/a?b=1', { lookup: publicLookup }), 'https://example.com/a?b=1');
    assert.equal(await validateInputUrl('http://example.com', { lookup: publicLookup }), 'http://example.com/');
  });

  it('rejects other schemes', async () => {
    for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://example.com/']) {
      await rejects(url, 'bad_scheme', { lookup: publicLookup });
    }
  });

  it('rejects embedded credentials', async () => {
    await rejects('https://user:pass@example.com/', 'credentials', { lookup: publicLookup });
    await rejects('https://user@example.com/', 'credentials', { lookup: publicLookup });
  });

  it('rejects empty, malformed and oversized input', async () => {
    await rejects('', 'invalid_url');
    await rejects('not a url', 'invalid_url');
    await rejects(undefined, 'invalid_url');
    await rejects(`https://example.com/${'a'.repeat(3000)}`, 'invalid_url');
  });
});

describe('validateInputUrl: IPv4 literals', () => {
  const blocked = {
    loopback: 'http://127.0.0.1/',
    'loopback range': 'http://127.5.4.3/',
    'unspecified address': 'http://0.0.0.0/',
    'private 10/8': 'http://10.1.2.3/',
    'private 172.16/12': 'http://172.16.0.1/',
    'private 172.31': 'http://172.31.255.255/',
    'private 192.168/16': 'http://192.168.1.1/',
    'link-local': 'http://169.254.1.1/',
    'cloud metadata': 'http://169.254.169.254/latest/meta-data/',
    'carrier-grade NAT low': 'http://100.64.0.1/',
    'carrier-grade NAT high': 'http://100.127.255.255/',
    'alibaba metadata': 'http://100.100.100.200/',
    multicast: 'http://224.0.0.1/',
    broadcast: 'http://255.255.255.255/',
    'decimal loopback': 'http://2130706433/',
    'hexadecimal loopback': 'http://0x7f000001/',
    'short loopback': 'http://127.1/',
  };
  for (const [name, url] of Object.entries(blocked)) {
    it(`rejects ${name}`, () => rejects(url, 'blocked_address'));
  }

  it('accepts public addresses next to blocked ranges', async () => {
    for (const url of ['http://172.15.255.255/', 'http://172.32.0.1/', 'http://100.63.255.255/', 'http://100.128.0.1/', 'http://8.8.8.8/']) {
      assert.ok(await validateInputUrl(url));
    }
  });
});

describe('validateInputUrl: IPv6 literals', () => {
  const blocked = {
    loopback: 'http://[::1]/',
    unspecified: 'http://[::]/',
    'link-local': 'http://[fe80::1]/',
    'unique local fc00': 'http://[fc00::1]/',
    'unique local fd': 'http://[fd12:3456:789a::1]/',
    'aws metadata': 'http://[fd00:ec2::254]/',
    multicast: 'http://[ff02::1]/',
    'documentation range': 'http://[2001:db8::1]/',
    'IPv4-mapped loopback': 'http://[::ffff:127.0.0.1]/',
    'IPv4-mapped metadata (hex form)': 'http://[::ffff:a9fe:a9fe]/',
    'IPv4-mapped private': 'http://[::ffff:10.0.0.1]/',
    'NAT64 private': 'http://[64:ff9b::192.168.0.1]/',
    '6to4 loopback': 'http://[2002:7f00:1::]/',
    'IPv4-compatible': 'http://[::127.0.0.1]/',
  };
  for (const [name, url] of Object.entries(blocked)) {
    it(`rejects ${name}`, () => rejects(url, 'blocked_address'));
  }

  it('accepts a public address', async () => {
    assert.ok(await validateInputUrl('http://[2606:4700:4700::1111]/'));
    assert.ok(await validateInputUrl('http://[::ffff:8.8.8.8]/'));
  });
});

describe('validateInputUrl: host names', () => {
  it('rejects localhost and metadata names without resolving them', async () => {
    const lookup = async () => assert.fail('must not resolve');
    await rejects('http://localhost/', 'blocked_host', { lookup });
    await rejects('http://LOCALHOST:8000/', 'blocked_host', { lookup });
    await rejects('http://localhost./', 'blocked_host', { lookup });
    await rejects('http://app.localhost/', 'blocked_host', { lookup });
    await rejects('http://metadata.google.internal/', 'blocked_host', { lookup });
  });

  it('rejects names that resolve to a blocked IPv4 address', async () => {
    await rejects('http://internal.example/', 'blocked_address', { lookup: lookupOf('10.0.0.5') });
    await rejects('http://meta.example/', 'blocked_address', { lookup: lookupOf('169.254.169.254') });
    await rejects('http://loop.example/', 'blocked_address', { lookup: lookupOf('127.0.0.1') });
  });

  it('rejects names that resolve to a blocked IPv6 address', async () => {
    await rejects('http://loop6.example/', 'blocked_address', { lookup: lookupOf('::1') });
    await rejects('http://ula.example/', 'blocked_address', { lookup: lookupOf('fd00::1') });
  });

  it('rejects when any one of several addresses is blocked', async () => {
    await rejects('http://mixed.example/', 'blocked_address', { lookup: lookupOf('93.184.216.34', '192.168.0.10') });
  });

  it('rejects names that cannot be resolved', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    };
    await rejects('http://nonexistent.example/', 'unresolvable', { lookup });
    await rejects('http://empty.example/', 'unresolvable', { lookup: async () => [] });
  });
});

describe('isBlockedAddress', () => {
  it('treats anything that is not an IP address as blocked', () => {
    assert.equal(isBlockedAddress('example.com'), true);
    assert.equal(isBlockedAddress(''), true);
  });
});
