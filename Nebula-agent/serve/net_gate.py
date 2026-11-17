# -*- coding: utf-8 -*-
"""Host / Origin / API-key security gate (the network-admission layer).

Split out of serve/server.py (refactor plan-B block 2, 2026-11-17): the DNS-rebinding
Host check, the browser-Origin check, the API-key parsing/matching helpers, and the
allowed_hosts / origins config parsers. AST dependency analysis first (the same
discipline that scoped plan-B block 1) proved this cluster closes over ONLY stdlib
(socket / hmac / ipaddress) + its own members + the LOOPBACK_NAMES constant -- it
touches NO engine/session/MCP process state -- so it moves as a pure, self-contained
module. server.py re-imports these names unchanged, so every call site (including
the ones at server.py L3077 / L7672) is untouched.

This is an equivalence move, not a rewrite: the function bodies are byte-for-byte the
originals, verified against server.py before committing.
"""
import hmac
import socket


# The names that always mean "this machine" -- kept here because both the Host and
# Origin checks consult them (originally server.py's module constant of the same name).
LOOPBACK_NAMES = ("localhost", "127.0.0.1", "::1")


def host_name(value) -> str:
    """The name in a Host header (or an origin's host[:port]): "Example.com:8080" -> "example.com",
    "[::1]:8095" -> "::1"; "" when it is malformed."""
    v = (value or "").strip().lower()
    if v.startswith("["):
        name, sep, rest = v[1:].partition("]")
        return name if sep and (not rest or (rest[:1] == ":" and rest[1:].isdigit())) else ""
    if v.count(":") == 1:
        v, port = v.split(":")
        if not port.isdigit():
            return ""
    elif ":" in v:                                       # a bare IPv6 address (a config entry)
        return v
    v = v.rstrip(".")
    return v if v and all(c.isalnum() or c in "-._" for c in v) else ""


def lan_addresses() -> list[str]:
    """This PC's IPv4 addresses on its networks (what another device types in), without loopback/link-local."""
    import socket
    first, ips = None, set()
    try:                                                # the address of the default route; sends nothing (UDP)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            first = s.getsockname()[0]
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    ok = lambda ip: ip and not ip.startswith(("127.", "169.254.", "0."))
    return ([first] if ok(first) else []) + sorted(ip for ip in ips if ok(ip) and ip != first)


def _is_ip(name: str) -> bool:
    import ipaddress
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


def _name_in(name: str, names) -> bool:
    """`name` is one of `names`, or below an entry that starts with a dot (".example.com")."""
    return name in names or any(n.startswith(".") and (name.endswith(n) or name == n[1:]) for n in names)


def allowed_hosts_of(value, env: str = "") -> list[str]:
    """The config's allowed_hosts (a name or a list) plus $STRATA_ALLOWED_HOSTS (comma-separated): host names, "*" or
    ".example.com" (it and every name below it).  A scheme, port or path is dropped ("https://a.example.com:8443/"
    -> "a.example.com"); a wrong entry stops the start (ValueError)."""
    items = [] if value in (None, "") else [value] if isinstance(value, str) else value
    if not isinstance(items, list) or not all(isinstance(x, str) for x in items):
        raise ValueError("allowed_hosts: expected a host name or a list of them")
    out = []
    for raw in items + [x for x in env.split(",") if x.strip()]:
        x = raw.strip().lower()
        if x == "*":
            out.append(x)
            continue
        x = x.split("://", 1)[-1].split("/", 1)[0]
        dot = x.startswith(".")
        name = host_name(x[1:] if dot else x)
        if not name:
            raise ValueError(f"allowed_hosts: {raw!r} is not a host name like strata.example.com")
        out.append("." + name if dot else name)
    return list(dict.fromkeys(out))


def host_names_for(bind_host: str, allowed_hosts=(), trusted_origins=()) -> set[str]:
    """Every name this server answers to besides an IP address: localhost, the address it listens on, the config's
    allowed_hosts and trusted_origins' hosts, and - listening beyond this PC (0.0.0.0 or a LAN address) - this PC's
    name and LAN addresses (the LAN addresses matter for the Origin check, which takes no IP on trust)."""
    names = set(LOOPBACK_NAMES)
    bind = host_name(bind_host)
    if bind and bind not in ("0.0.0.0", "::"):
        names.add(bind)
    if bind not in LOOPBACK_NAMES:
        try:
            pc = socket.gethostname().lower()
            names.update((pc, pc + ".local"))
        except OSError:
            pass
        names.update(("host.docker.internal", *lan_addresses()))
    names.update(x for x in allowed_hosts if x != "*")
    names.update(filter(None, (host_name(o.split("://", 1)[-1]) for o in trusted_origins)))
    return names


def host_allowed(host, names, any_host=False) -> bool:
    """DNS rebinding: a web page of another site whose name its DNS points at 127.0.0.1 reaches this server as the
    same origin, so the browser lets it read every answer.  Its requests carry that site's name in Host, so only
    the names this server answers to pass.  An IP address passes (a page served from an IP is that IP's own page;
    rebinding needs a name), as does "*.localhost" (browsers never ask DNS for it) and a request without a Host
    header (HTTP/1.0 clients; browsers always send one)."""
    if any_host or not (host or "").strip():
        return True
    name = host_name(host)
    return bool(name) and (_is_ip(name) or name == "localhost" or name.endswith(".localhost")
                           or _name_in(name, names))


def key_list(value) -> list[str]:
    """#1344: the keys a server accepts.  --api-key / STRATA_API_KEY / "api_key" take llama.cpp's form, several keys
    separated by commas ("k1,k2"; spaces around each are dropped), or a list in the config ("api_key": ["k1", "k2"],
    the way to give a key that contains a comma).  A list is taken as it is."""
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        return [str(k) for k in value if str(k)]
    return [k.strip() for k in str(value).split(",") if k.strip()]


def api_key_of(value):
    """The key as a client can send it (#725).  An HTTP header loses the spaces and line ends around its value, so a
    key kept with them (a config file or an environment file with CRLF line ends, a quoted " key ") matched no
    request: every client got 401 with the right key.  A value that is only such characters raises ValueError, it
    never means "no key" (#213).  #1344: a config list of keys returns the list (each key stripped, none empty); a
    string stays a string (its commas separate keys, see key_list)."""
    if isinstance(value, (list, tuple)):
        keys = [str(k).strip() for k in value]
        if not keys or any(not k for k in keys):
            raise ValueError("an API key was given but it is empty")
        return keys
    key = "" if value is None else str(value)
    if key and not key_list(key):
        raise ValueError("an API key was given but it is empty")
    return key.strip()


def key_matches(given: str, key) -> bool:
    """given: a header's value as http.server read it, each byte one character.  A key with characters outside ASCII
    arrives as UTF-8 from most clients and as Latin-1 from some; the right key passes in both forms (#725: the
    bytes were re-encoded before, so a UTF-8 key never matched).  Constant-time (#213).  #1344: `key` may name several
    keys (see key_list); the given one must match any, and every key is compared whatever the outcome."""
    raw = given.encode("latin-1", "replace")
    ok = False
    for k in key_list(key):
        ok |= hmac.compare_digest(raw, k.encode())
        try:
            ok |= hmac.compare_digest(raw, k.encode("latin-1"))
        except UnicodeEncodeError:
            pass
    return ok


def origin_allowed(origin: str, host, names, origins=()) -> bool:
    """A browser page's Origin that may use the model without an API key: this server's own page (the Origin is the
    request's own Host), a page on one of the names this server answers to (any port), or an origin the config lists
    (trusted_origins, cors_origins).  Unlike the Host check no IP passes on trust: a page served from any other IP is
    another site.  "null" (a sandboxed frame, a file:// page) does not pass: any site can send it.  An origin of another
    scheme (chrome-extension://, moz-extension://, an Electron app's app://) does: no web site can send one."""
    origin = (origin or "").strip().rstrip("/")
    if origin in origins or "*" in origins:             # cors_origins ["*"]: the config lets every page in
        return True
    scheme, sep, rest = origin.lower().partition("://")
    if not sep or not scheme:
        return False
    if scheme not in ("http", "https"):
        return True
    if host and rest == host.strip().lower():
        return True
    name = host_name(rest)
    return bool(name) and (name in LOOPBACK_NAMES or name.endswith(".localhost") or _name_in(name, names))


def origins_of(value, key: str, wildcard: bool) -> list[str]:
    """#321: a config's origin list ("https://chat.example.com" or a list of them) - scheme://host[:port], no path;
    "*" only where `wildcard` allows it.  A wrong entry stops the start rather than opening less or more than meant."""
    if value is None or value == "" or value == []:
        return []
    items = [value] if isinstance(value, str) else value
    if not isinstance(items, list) or not all(isinstance(x, str) for x in items):
        raise SystemExit(f"[strata] {key}: expected an origin or a list of origins")
    out = []
    for x in items:
        x = x.strip().rstrip("/")
        if x == "*" and wildcard:
            out.append(x)
            continue
        scheme, sep, rest = x.partition("://")
        if scheme not in ("http", "https") or not sep or not rest or "/" in rest or "*" in rest:
            raise SystemExit(f"[strata] {key}: {x!r} is not an origin like https://chat.example.com"
                             + ("" if wildcard else " (no wildcards here)"))
        out.append(x)
    return out
