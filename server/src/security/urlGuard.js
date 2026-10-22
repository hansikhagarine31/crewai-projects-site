import dns from 'node:dns/promises';
import net from 'node:net';

export class UrlGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UrlGuardError';
    this.code = code;
  }
}

const MAX_URL_LENGTH = 2048;
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.goog']);

function v4ToInt(address) {
  return address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

// IPv4 ranges as [network, prefix length]. Includes loopback, private, link-local
// (which covers the 169.254.169.254 metadata address), carrier-grade NAT
// (which covers 100.100.100.200) and other non-public blocks.
const BLOCKED_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

function v4Blocked(address) {
  const value = v4ToInt(address);
  return BLOCKED_V4.some(([base, bits]) => value >= base && value < base + 2 ** (32 - bits));
}

/** Expands an IPv6 address to eight 16-bit groups. */
function parseV6(address) {
  let text = address.split('%')[0].toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const [head, rest] = text.split('::');
  const headParts = head ? head.split(':') : [];
  if (rest === undefined) return headParts.map((part) => parseInt(part, 16));
  const restParts = rest ? rest.split(':') : [];
  const fill = Array(8 - headParts.length - restParts.length).fill('0');
  return [...headParts, ...fill, ...restParts].map((part) => parseInt(part, 16));
}

function v4FromGroups(high, low) {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function v6Blocked(address) {
  const g = parseV6(address);
  const zeros = (from, to) => g.slice(from, to).every((group) => group === 0);

  if (zeros(0, 7) && g[7] <= 1) return true; // :: and ::1
  if (zeros(0, 5) && g[5] === 0xffff) return v4Blocked(v4FromGroups(g[6], g[7])); // IPv4-mapped
  if (zeros(0, 6)) return true; // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4Blocked(v4FromGroups(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4Blocked(v4FromGroups(g[1], g[2])); // 6to4
  if (g[0] === 0x100 && zeros(1, 4)) return true; // discard 100::/64
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7 (includes fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when the literal IP address is not a public unicast address. */
export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return v4Blocked(address);
  if (family === 6) return v6Blocked(address);
  return true;
}

/**
 * Validates a user-supplied URL before the agents service fetches it.
 * Returns the normalised URL string; throws UrlGuardError otherwise.
 * `lookup` is injectable for tests.
 */
export async function validateInputUrl(input, { lookup = dns.lookup } = {}) {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH) {
    throw new UrlGuardError('invalid_url', 'The URL is missing or too long.');
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UrlGuardError('invalid_url', 'The URL could not be parsed.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlGuardError('bad_scheme', 'Only http and https URLs are accepted.');
  }
  if (url.username || url.password) {
    throw new UrlGuardError('credentials', 'URLs containing credentials are not accepted.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new UrlGuardError('invalid_url', 'The URL has no host.');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw new UrlGuardError('blocked_host', 'This host is not permitted.');
  }

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new UrlGuardError('blocked_address', 'This address is not permitted.');
    }
    return url.href;
  }

  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UrlGuardError('unresolvable', 'The host name could not be resolved.');
  }
  if (!records.length) throw new UrlGuardError('unresolvable', 'The host name could not be resolved.');
  if (records.some((record) => isBlockedAddress(record.address))) {
    throw new UrlGuardError('blocked_address', 'This host resolves to an address that is not permitted.');
  }
  return url.href;
}
