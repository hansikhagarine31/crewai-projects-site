import pytest

from app.security import UrlGuardError, is_blocked_address, resolve_final_url, validate_public_url


def public(_host):
    return ["93.184.216.34"]


def resolves_to(*addresses):
    return lambda _host: list(addresses)


def rejected(url, code, resolver=public):
    with pytest.raises(UrlGuardError) as info:
        validate_public_url(url, resolver)
    assert info.value.code == code


class TestSchemeAndShape:
    def test_accepts_public_http_and_https(self):
        assert validate_public_url("https://example.com/a?b=1", public) == "https://example.com/a?b=1"
        assert validate_public_url("http://example.com", public) == "http://example.com"

    @pytest.mark.parametrize("url", ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "gopher://example.com/"])
    def test_rejects_other_schemes(self, url):
        rejected(url, "bad_scheme")

    @pytest.mark.parametrize("url", ["https://user:pass@example.com/", "https://user@example.com/"])
    def test_rejects_credentials(self, url):
        rejected(url, "credentials")

    @pytest.mark.parametrize("url", ["", "not a url", None, "https://example.com/" + "a" * 3000, "http://example.com:99999/"])
    def test_rejects_malformed_input(self, url):
        rejected(url, "invalid_url")


class TestIPv4Literals:
    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1/",
            "http://127.5.4.3/",
            "http://0.0.0.0/",
            "http://10.1.2.3/",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://192.168.1.1/",
            "http://169.254.1.1/",
            "http://169.254.169.254/latest/meta-data/",  # cloud metadata
            "http://100.64.0.1/",  # carrier-grade NAT
            "http://100.127.255.255/",
            "http://100.100.100.200/",  # Alibaba metadata
            "http://192.0.0.192/",  # Oracle metadata
            "http://224.0.0.1/",
            "http://255.255.255.255/",
            "http://2130706433/",  # decimal loopback
            "http://0x7f000001/",  # hexadecimal loopback
            "http://127.1/",  # short form
        ],
    )
    def test_rejects(self, url):
        rejected(url, "blocked_address")

    @pytest.mark.parametrize(
        "url", ["http://172.15.255.255/", "http://172.32.0.1/", "http://100.63.255.255/", "http://100.128.0.1/", "http://8.8.8.8/"]
    )
    def test_accepts_public_addresses_next_to_blocked_ranges(self, url):
        assert validate_public_url(url, public) == url


class TestIPv6Literals:
    @pytest.mark.parametrize(
        "url",
        [
            "http://[::1]/",
            "http://[::]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
            "http://[fd12:3456:789a::1]/",
            "http://[fd00:ec2::254]/",  # AWS metadata
            "http://[ff02::1]/",
            "http://[2001:db8::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:a9fe:a9fe]/",  # 169.254.169.254 in hex form
            "http://[::ffff:10.0.0.1]/",
            "http://[64:ff9b::192.168.0.1]/",  # NAT64
            "http://[2002:7f00:1::]/",  # 6to4 loopback
            "http://[::127.0.0.1]/",  # IPv4-compatible
        ],
    )
    def test_rejects(self, url):
        rejected(url, "blocked_address")

    @pytest.mark.parametrize("url", ["http://[2606:4700:4700::1111]/", "http://[::ffff:8.8.8.8]/"])
    def test_accepts_public_addresses(self, url):
        assert validate_public_url(url, public) == url


class TestHostNames:
    def test_rejects_localhost_and_metadata_names_without_resolving(self):
        def fail(_host):
            raise AssertionError("must not resolve")

        for url in [
            "http://localhost/",
            "http://LOCALHOST:8000/",
            "http://localhost./",
            "http://app.localhost/",
            "http://metadata.google.internal/",
        ]:
            rejected(url, "blocked_host", fail)

    @pytest.mark.parametrize("address", ["10.0.0.5", "169.254.169.254", "127.0.0.1", "::1", "fd00::1"])
    def test_rejects_names_that_resolve_to_blocked_addresses(self, address):
        rejected("http://internal.example/", "blocked_address", resolves_to(address))

    def test_rejects_when_any_one_address_is_blocked(self):
        rejected("http://mixed.example/", "blocked_address", resolves_to("93.184.216.34", "192.168.0.10"))

    def test_rejects_names_that_cannot_be_resolved(self):
        def missing(_host):
            raise OSError("not found")

        rejected("http://nonexistent.example/", "unresolvable", missing)
        rejected("http://empty.example/", "unresolvable", resolves_to())


def test_is_blocked_address_treats_non_addresses_as_blocked():
    assert is_blocked_address("example.com")
    assert is_blocked_address("")


class FakeResponse:
    def __init__(self, status=200, location=None):
        self.status_code = status
        self.headers = {"Location": location} if location else {}
        self.closed = False

    def close(self):
        self.closed = True


class FakeSession:
    """Serves a fixed map of URL -> response and records what was requested."""

    def __init__(self, pages):
        self.pages = pages
        self.requested = []

    def get(self, url, **kwargs):
        assert kwargs["allow_redirects"] is False
        self.requested.append(url)
        return self.pages[url]


def redirect(to, status=302):
    return FakeResponse(status, to)


class TestRedirects:
    def final(self, pages, start, resolver=public, **kwargs):
        session = FakeSession(pages)
        return resolve_final_url(start, resolver=resolver, session=session, **kwargs), session

    def test_returns_the_start_url_when_there_is_no_redirect(self):
        url, session = self.final({"https://example.com/": FakeResponse()}, "https://example.com/")
        assert url == "https://example.com/"
        assert session.requested == ["https://example.com/"]

    def test_follows_redirects_between_public_hosts(self):
        pages = {
            "http://a.example/": redirect("https://a.example/home", 301),
            "https://a.example/home": redirect("/final", 307),
            "https://a.example/final": FakeResponse(),
        }
        url, _ = self.final(pages, "http://a.example/")
        assert url == "https://a.example/final"

    @pytest.mark.parametrize(
        "target",
        [
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1:8001/health",
            "http://localhost/admin",
            "http://[::1]/",
            "http://10.0.0.1/",
            "http://192.168.1.1/",
            "http://100.100.100.200/",
        ],
    )
    def test_rejects_a_redirect_to_an_internal_address(self, target):
        pages = {"https://example.com/": redirect(target)}
        session = FakeSession(pages)
        with pytest.raises(UrlGuardError) as info:
            resolve_final_url("https://example.com/", resolver=public, session=session)
        assert info.value.code in {"blocked_address", "blocked_host"}
        assert session.requested == ["https://example.com/"]  # the internal target was never requested

    def test_rejects_a_redirect_to_a_host_that_resolves_to_a_private_address(self):
        def resolver(host):
            return ["10.0.0.7"] if host == "internal.example" else ["93.184.216.34"]

        pages = {"https://example.com/": redirect("https://internal.example/")}
        with pytest.raises(UrlGuardError) as info:
            resolve_final_url("https://example.com/", resolver=resolver, session=FakeSession(pages))
        assert info.value.code == "blocked_address"

    def test_rejects_a_redirect_to_another_scheme(self):
        for target in ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/"]:
            pages = {"https://example.com/": redirect(target)}
            with pytest.raises(UrlGuardError) as info:
                resolve_final_url("https://example.com/", resolver=public, session=FakeSession(pages))
            assert info.value.code == "bad_scheme"

    def test_rejects_a_redirect_that_adds_credentials(self):
        pages = {"https://example.com/": redirect("https://user:pw@example.org/")}
        with pytest.raises(UrlGuardError) as info:
            resolve_final_url("https://example.com/", resolver=public, session=FakeSession(pages))
        assert info.value.code == "credentials"

    def test_rejects_a_redirect_loop(self):
        pages = {"https://example.com/": redirect("https://example.com/")}
        with pytest.raises(UrlGuardError) as info:
            resolve_final_url("https://example.com/", resolver=public, session=FakeSession(pages), max_redirects=3)
        assert info.value.code == "too_many_redirects"

    def test_rejects_a_blocked_start_url_without_any_request(self):
        session = FakeSession({})
        with pytest.raises(UrlGuardError):
            resolve_final_url("http://169.254.169.254/", resolver=public, session=session)
        assert session.requested == []

    def test_closes_every_response(self):
        first, second = redirect("https://a.example/two"), FakeResponse()
        pages = {"https://a.example/": first, "https://a.example/two": second}
        self.final(pages, "https://a.example/")
        assert first.closed and second.closed


class TestEveryRouteRequiresTheSecret:
    """Walks the routes that are registered, so a route added later is covered without a change here."""

    @staticmethod
    def _routes():
        from starlette.routing import Mount

        from app.main import app

        found = []

        def walk(routes):
            for route in routes:
                if isinstance(route, Mount):  # a mounted application would need its own check
                    raise AssertionError(f"Mounted application at {route.path} is not covered by the test.")
                if hasattr(route, "original_router"):  # an included router
                    walk(route.original_router.routes)
                    continue
                path = getattr(route, "path", None)
                if path:
                    for method in getattr(route, "methods", None) or {"GET"}:
                        if method not in ("HEAD", "OPTIONS"):
                            found.append((method, path))

        walk(app.routes)
        return found

    def test_every_route_but_health_refuses_a_request_without_the_secret(self, monkeypatch):
        from fastapi.testclient import TestClient

        from app import config
        from app.main import app

        monkeypatch.setattr(config, "AGENT_SHARED_SECRET", "a-secret-for-the-test")
        client = TestClient(app, raise_server_exceptions=False)
        routes = self._routes()
        assert ("POST", "/run/{project_id}") in routes and ("POST", "/resume/{run_id}") in routes
        for method, path in routes:
            url = path.replace("{project_id}", "demo").replace("{run_id}", "0" * 8 + "-0000-0000-0000-" + "0" * 12)
            without = client.request(method, url)
            wrong = client.request(method, url, headers={"x-agent-secret": "wrong"})
            if path == "/health":
                assert without.status_code == 200
            else:
                assert without.status_code == 401, f"{method} {path} answered {without.status_code} without the secret"
                assert wrong.status_code == 401, f"{method} {path} answered {wrong.status_code} with a wrong secret"

    def test_the_interactive_documentation_is_not_served(self, monkeypatch):
        from fastapi.testclient import TestClient

        from app import config
        from app.main import app

        monkeypatch.setattr(config, "AGENT_SHARED_SECRET", "a-secret-for-the-test")
        client = TestClient(app, raise_server_exceptions=False)
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path, headers={"x-agent-secret": "a-secret-for-the-test"}).status_code == 404

    def test_a_service_without_a_configured_secret_refuses_everything_but_health(self, monkeypatch):
        from fastapi.testclient import TestClient

        from app import config
        from app.main import app

        monkeypatch.setattr(config, "AGENT_SHARED_SECRET", "")
        client = TestClient(app, raise_server_exceptions=False)
        assert client.get("/health").status_code == 200
        assert client.post("/run/demo", json={}, headers={"x-agent-secret": ""}).status_code == 503
