"""model_registry.py - the list of models this UI can talk to, shared by BOTH server flavours.

Parasitic mode (serve/server.py inside Strata) and standalone mode (runtime/http_server.py) each
serve the same frontend, so they must agree on one list. The list lives in one JSON file:

    {"selected": "<id>", "models": [ {...entry...}, ... ]}

An entry is either

    local   - a Strata instance: `base_url` is "" for THIS one, or "http://127.0.0.1:8081" for a
              sibling instance started from another bat (same protocol, its own loaded GGUF).
    custom  - any OpenAI-compatible endpoint (cloud API, Ollama, LM Studio, ...): `base_url` +
              optional `api_key`; `tools` says whether the server should run local MCP tools for it.

Routing rule (used by both servers): the frontend always posts to the server that served it and
names a model id; the server resolves the id here and decides - answer itself, relay to a sibling,
or forward to an external endpoint. That keeps the browser same-origin (no CORS) and keeps one
code path for "another local model" and "a cloud model".

Resolution order for the file (first hit wins):
    1. $STRATA_MODELS_CONFIG
    2. $STRATA_PROJECT/config/models.json      (set by both bats)
    3. <this file>/../config/models.json       (package layout)
    4. <this file>/models.json                 (last resort, beside the code)
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request

KINDS = ("local", "custom")
THINK_LEVELS = ("off", "low", "medium", "high")   # what Strata itself understands; an endpoint may take fewer
_LOCK = threading.Lock()


# --------------------------------------------------------------------------- paths

def config_path() -> str:
    p = os.environ.get("STRATA_MODELS_CONFIG")
    if p:
        return os.path.abspath(p)
    proj = os.environ.get("STRATA_PROJECT")
    if proj:
        return os.path.join(os.path.abspath(proj), "config", "models.json")
    here = os.path.dirname(os.path.abspath(__file__))
    pkg = os.path.join(os.path.dirname(here), "config", "models.json")
    if os.path.isdir(os.path.dirname(pkg)):
        return pkg
    return os.path.join(here, "models.json")


# --------------------------------------------------------------------------- normalise

def _slug(text: str, fallback: str = "model") -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", str(text or "").strip().lower()).strip("-")
    return s or fallback


def normalize_entry(raw: dict, taken: set | None = None) -> dict:
    """One entry, defaults filled in and the id made unique. Raises ValueError on a bad kind."""
    if not isinstance(raw, dict):
        raise ValueError("each model must be an object")
    kind = str(raw.get("kind") or "custom").strip().lower()
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    model = str(raw.get("model") or "").strip()
    base = str(raw.get("base_url") or "").strip().rstrip("/")
    if kind == "local" and base and not re.match(r"^https?://", base):
        raise ValueError("base_url must start with http:// or https://")
    if kind == "custom" and not re.match(r"^https?://", base):
        raise ValueError("a custom model needs an http(s) base_url")
    name = str(raw.get("name") or model or base or "model").strip()
    rid = _slug(raw.get("id") or name or model)
    taken = taken if taken is not None else set()
    base_id, n = rid, 2
    while rid in taken:
        rid, n = f"{base_id}-{n}", n + 1
    taken.add(rid)
    out = {"id": rid, "name": name, "kind": kind, "base_url": base, "model": model or name}
    key = str(raw.get("api_key") or "").strip()
    if key:
        out["api_key"] = key
    for flag in ("tools", "vision"):
        if flag in raw:
            out[flag] = bool(raw[flag])
    modes = raw.get("think_modes")
    if isinstance(modes, list):
        clean = [x for x in (str(v).strip().lower() for v in modes) if x in THINK_LEVELS]
        if clean:
            out["think_modes"] = list(dict.fromkeys(clean))
    level = str(raw.get("think_default") or "auto").strip().lower()
    out["think_default"] = level if level in ("auto",) + THINK_LEVELS else "auto"
    for num in ("ctx_in", "ctx_out", "native_ctx"):
        if raw.get(num) not in (None, ""):
            try:
                v = int(raw[num])
                if v > 0:
                    out[num] = v
            except (TypeError, ValueError):
                raise ValueError(f"{num} must be a positive integer")
    if raw.get("note"):
        out["note"] = str(raw["note"])[:200]
    return out


def normalize_doc(raw: dict) -> dict:
    """The whole file, defaults filled in and ids made unique."""
    if not isinstance(raw, dict):
        raise ValueError("models.json must be an object")
    taken: set = set()
    models = [normalize_entry(e, taken) for e in (raw.get("models") or []) if isinstance(e, dict)]
    ids = [m["id"] for m in models]
    sel = raw.get("selected")
    sel = str(sel) if isinstance(sel, str) else ""
    if sel not in ids:
        sel = next((m["id"] for m in models if m["kind"] == "local" and not m["base_url"]), "")
        if not sel:
            sel = ids[0] if ids else ""
    return {"selected": sel, "models": models}


def example_doc() -> dict:
    """What a fresh install starts with: this instance, plus its sibling run config if it is around."""
    return normalize_doc({"selected": "", "models": [
        {"id": "self", "name": "swift-1.5-iq3_s", "kind": "local", "base_url": "", "model": "swift-1.5-iq3_s"},
        {"id": "iq3-xxs", "name": "swift-1.5-iq3_xxs", "kind": "local",
         "base_url": "http://127.0.0.1:8081", "model": "swift-1.5-iq3_xxs",
         "note": "第二个 bat（另一端口）启动后可用"},
    ]})


# --------------------------------------------------------------------------- io

def load(path: str | None = None) -> dict:
    """Read the registry; a missing file yields the example list (never an exception for a first run)."""
    p = path or config_path()
    try:
        with open(p, "r", encoding="utf-8") as f:
            return normalize_doc(json.load(f))
    except (OSError, ValueError):
        return example_doc()


def save(doc: dict, path: str | None = None) -> dict:
    """Validate, then write atomically (a crash mid-write must not eat the list)."""
    p = path or config_path()
    clean = normalize_doc(doc)
    d = os.path.dirname(p)
    if d:
        os.makedirs(d, exist_ok=True)
    with _LOCK:
        fd, tmp = tempfile.mkstemp(dir=d or ".", prefix=".models-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(clean, f, ensure_ascii=False, indent=2)
                f.write("\n")
            os.replace(tmp, p)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    return clean


# --------------------------------------------------------------------------- public / merge

def public(doc: dict) -> dict:
    """What the browser may see: keys are replaced by a boolean (never ship a secret to a page)."""
    out = {"selected": doc.get("selected", ""), "models": []}
    for m in doc.get("models", []):
        e = {k: v for k, v in m.items() if k != "api_key"}
        e["api_key_set"] = bool(m.get("api_key"))
        out["models"].append(e)
    return out


def find(doc: dict, model_id: str | None) -> dict | None:
    """An entry by id (also accept the upstream model name, which is what an outside client sends)."""
    if not model_id:
        return None
    for m in doc.get("models", []):
        if m.get("id") == model_id:
            return m
    for m in doc.get("models", []):
        if m.get("model") == model_id:
            return m
    return None


def merge(existing: dict, incoming: dict) -> dict:
    """Apply a browser edit: an absent api_key keeps the stored one, "" clears it."""
    out = {k: v for k, v in incoming.items() if k != "api_key"}
    if "api_key" in incoming:
        k = str(incoming.get("api_key") or "").strip()
        if k:
            out["api_key"] = k
    else:
        old = find(existing, incoming.get("id"))
        if old and old.get("api_key"):
            out["api_key"] = old["api_key"]
    return out


# --------------------------------------------------------------------------- probe

def probe(entry: dict, timeout: float = 8.0) -> tuple[bool, str]:
    """GET <base>/models and report what came back - the "测试连接" button's whole job."""
    base = str(entry.get("base_url") or "").rstrip("/")
    if not base:
        return False, "base_url is empty"
    url = base + ("/models" if base.endswith("/v1") else "/v1/models")
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    key = entry.get("api_key")
    if key:
        req.add_header("Authorization", "Bearer " + key)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(200000).decode("utf-8", "replace")
        data = json.loads(body)
        ids = [m.get("id") for m in (data.get("data") or []) if isinstance(m, dict)]
        ids = [i for i in ids if i]
        want = entry.get("model")
        if want and ids and want not in ids:
            return True, f"connected; model '{want}' not listed (saw: {', '.join(ids[:6])})"
        return True, "connected" + (f"; {len(ids)} model(s)" if ids else "")
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code} {e.reason}"
    except urllib.error.URLError as e:
        return False, f"unreachable: {e.reason}"
    except Exception as e:                                   # noqa: BLE001 - report, never raise
        return False, f"{type(e).__name__}: {e}"
