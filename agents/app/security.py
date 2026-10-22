"""Shared-secret authentication and the public-URL guard.

The URL rules match server/src/security/urlGuard.js: http and https only, no
embedded credentials, and no loopback, private, link-local, carrier-grade NAT,
metadata or otherwise non-public address, for IPv4 and IPv6. Redirects are
followed one hop at a time and every hop is checked again.
"""
import hmac
import ipaddress
import json
import socket
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit

import requests

from app import config

OPEN_PATHS = {"/health"}


class SharedSecretMiddleware:
    """Pure ASGI middleware: rejects every HTTP request except /health unless x-agent-secret matches.

    Written as plain ASGI, not BaseHTTPMiddleware, so streaming responses and
    client disconnects pass through untouched.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] in OPEN_PATHS:
            return await self.app(scope, receive, send)

        expected = config.AGENT_SHARED_SECRET
        if not expected:
            return await self._reject(send, 503, "AGENT_SHARED_SECRET is not configured.")
        supplied = dict(scope["headers"]).get(b"x-agent-secret", b"")
        if not hmac.compare_digest(supplied, expected.encode()):
            return await self._reject(send, 401, "Invalid or missing x-agent-secret header.")
        return await self.app(scope, receive, send)

    @staticmethod
    async def _reject(send, status: int, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})


# ---------------------------------------------------------------------------
# Public-URL guard
# ---------------------------------------------------------------------------


class UrlGuardError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


MAX_URL_LENGTH = 2048
BLOCKED_HOSTNAMES = {"localhost", "metadata.google.internal", "metadata.goog"}

# Blocked even where Python's is_global would allow them (or to be explicit).
_EXTRA_BLOCKED_V4 = [
    ipaddress.ip_network("192.0.0.0/24"),  # IETF protocol assignments, includes the Oracle metadata address
    ipaddress.ip_network("100.64.0.0/10"),  # carrier-grade NAT, includes 100.100.100.200
]
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_TEREDO = ipaddress.ip_network("2001::/32")
_DISCARD = ipaddress.ip_network("100::/64")

Resolver = Callable[[str], list[str]]


def default_resolver(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return sorted({info[4][0] for info in infos})


def is_blocked_address(address: str) -> bool:
    """True when the literal IP address is not a public unicast address."""
    try:
        ip = ipaddress.ip_address(address.split("%")[0])
    except ValueError:
        return True

    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return is_blocked_address(str(ip.ipv4_mapped))
        if ip.sixtofour is not None:
            return is_blocked_address(str(ip.sixtofour))
        if ip in _NAT64:
            return is_blocked_address(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
        if ip in _TEREDO or ip in _DISCARD:
            return True
        # Deprecated IPv4-compatible addresses (::a.b.c.d) and anything else non-global.
        if int(ip) >> 32 == 0:
            return True
        return not ip.is_global or ip.is_multicast

    if any(ip in network for network in _EXTRA_BLOCKED_V4):
        return True
    return not ip.is_global or ip.is_multicast


def _numeric_host(host: str) -> str | None:
    """Normalises legacy numeric IPv4 forms (2130706433, 0x7f.1, 127.1) the way a resolver would."""
    try:
        return socket.inet_ntoa(socket.inet_aton(host))
    except OSError:
        return None


def validate_public_url(url: str, resolver: Resolver = default_resolver) -> str:
    """Returns the URL when it is safe to fetch; raises UrlGuardError otherwise."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise UrlGuardError("invalid_url", "The URL is missing or too long.")
    try:
        parts = urlsplit(url.strip())
        host = parts.hostname
        parts.port  # noqa: B018 - raises ValueError for an invalid port
    except ValueError:
        raise UrlGuardError("invalid_url", "The URL could not be parsed.") from None

    if not parts.scheme:
        raise UrlGuardError("invalid_url", "The URL could not be parsed.")
    if parts.scheme not in ("http", "https"):
        raise UrlGuardError("bad_scheme", "Only http and https URLs are accepted.")
    if parts.username or parts.password:
        raise UrlGuardError("credentials", "URLs containing credentials are not accepted.")
    if not host:
        raise UrlGuardError("invalid_url", "The URL has no host.")

    host = host.rstrip(".").lower()
    if host in BLOCKED_HOSTNAMES or host.endswith(".localhost"):
        raise UrlGuardError("blocked_host", "This host is not permitted.")

    literal = host if _is_ip(host) else _numeric_host(host)
    if literal is not None:
        if is_blocked_address(literal):
            raise UrlGuardError("blocked_address", "This address is not permitted.")
        return url.strip()

    try:
        addresses = resolver(host)
    except OSError:
        raise UrlGuardError("unresolvable", "The host name could not be resolved.") from None
    if not addresses:
        raise UrlGuardError("unresolvable", "The host name could not be resolved.")
    if any(is_blocked_address(address) for address in addresses):
        raise UrlGuardError("blocked_address", "This host resolves to an address that is not permitted.")
    return url.strip()


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


_REDIRECT_CODES = {301, 302, 303, 307, 308}


def _probe_session() -> requests.Session:
    """A session that ignores proxy settings and, where crewai-tools provides it, pins each
    connection to the address that was validated so DNS cannot change between check and use."""
    try:
        from crewai_tools.security.safe_requests import create_safe_session

        return create_safe_session()
    except ImportError:
        session = requests.Session()
        session.trust_env = False
        return session


def resolve_final_url(
    url: str,
    *,
    resolver: Resolver = default_resolver,
    session: requests.Session | None = None,
    max_redirects: int = config.SCRAPE_MAX_REDIRECTS,
    timeout: float = 10,
) -> str:
    """Follows redirects by hand and validates the starting URL and every hop.

    Returns the final URL. Bodies are never read. Raises UrlGuardError if any hop
    is not a public http or https URL, or if there are too many redirects.
    """
    session = session or _probe_session()
    current = validate_public_url(url, resolver)
    for _ in range(max_redirects + 1):
        response = session.get(current, allow_redirects=False, stream=True, timeout=timeout)
        try:
            location = response.headers.get("Location")
            if response.status_code not in _REDIRECT_CODES or not location:
                return current
        finally:
            response.close()
        current = validate_public_url(urljoin(current, location), resolver)
    raise UrlGuardError("too_many_redirects", "The URL redirects too many times.")
