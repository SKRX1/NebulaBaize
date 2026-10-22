"""Configuration registry for MCP servers and skills — the backend of the management UI.

Owns all reads and writes of the two files that define what tools the agent has:

  config/mcp_servers.json   MCP servers. Read by BOTH the Strata host (via --mcp-config)
                            and the gateway, so a change here reaches both consumers.
  skills/*.yaml             Skills. Read by the gateway ONLY.

Three reasons this lives in its own module instead of inline in the HTTP handler:

1. Atomicity with backup. A half-written mcp_servers.json takes every tool down at
   once, so writes go to a temp file and os.replace() over the original, after a
   timestamped backup. A crash mid-write can no longer corrupt the only source of truth.

2. The skill/server duality. Strata does not read skills/*.yaml, so in parasitic mode a
   skill would be invisible. To make skills work in BOTH modes, each skill is also
   expanded into a plain mcpServers entry tagged `_skill`, with `$SKILL_DIR` placeholders
   pre-expanded to absolute paths — Strata has no notion of that placeholder, so it must
   be resolved before the entry reaches it. The yaml stays portable; the expanded entry is
   what Strata actually starts. Unknown keys are ignored by Strata, so the tag is inert.

3. It is remote code execution by design. Writing `command`/`args` means "start this
   program on the user's machine", so every mutation is name-validated, backed up and
   audited, and built-in servers are protected from accidental deletion.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from typing import Any, Optional

from config_loader import load_config

# Server and skill names surface as dict keys, as tool prefixes (`<server>__<tool>`), and
# in file names. A conservative alphabet keeps them from escaping any of those contexts.
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")

MAX_BACKUPS = 20

# Marker written into an mcpServers entry expanded from a skill, so the UI can tell the
# two apart and a skill deletion can remove exactly the entries it created.
SKILL_TAG = "_skill"

# Keys accepted from a client-submitted server spec. Everything else is dropped so a
# request cannot smuggle in `_skill` and masquerade as (or corrupt) a skill entry.
SERVER_KEYS = ("command", "args", "cwd", "env")


class RegistryError(Exception):
    """A registry mutation was rejected: bad name, duplicate, conflict, or not found."""


def _check_name(name: Any) -> str:
    n = str(name or "").strip()
    if not n or not SAFE_NAME.match(n):
        raise RegistryError(
            f"invalid name '{name}': use letters, digits, dot, dash, underscore only")
    return n


def _sub(value: Any, skill_dir: str) -> Any:
    """Resolve $SKILL_DIR / ${SKILL_DIR} against a skill's directory."""
    if isinstance(value, str):
        return value.replace("${SKILL_DIR}", skill_dir).replace("$SKILL_DIR", skill_dir)
    return value


def _yq(value: Any) -> str:
    """Quote a scalar for the built-in YAML parser.

    `_scalar()` strips the outer quotes without un-escaping the body, so backslashes must
    NOT be escaped here — Windows paths like E:\\work\\a.py round-trip correctly as-is.
    """
    s = "" if value is None else str(value)
    if '"' not in s:
        return '"' + s + '"'
    return "'" + s.replace("'", "") + "'"


def dump_skill(spec: dict) -> str:
    """Serialize a skill spec into the YAML shape the built-in parser reads back.

    Emits only the subset of YAML that config_loader._minimal_yaml handles: 2-space
    nesting, `- key: value` sequences, and flow collections for lists.
    """
    lines = [f"name: {_yq(spec.get('name', ''))}"]
    if spec.get("description"):
        lines.append(f"description: {_yq(spec['description'])}")

    tools = [t for t in (spec.get("tools") or []) if isinstance(t, dict)]
    if tools:
        lines.append("tools:")
        for t in tools:
            first = True
            for k in ("mcp", "command", "args", "cwd"):
                if k not in t or t[k] in (None, "", []):
                    continue
                v = t[k]
                prefix = "  - " if first else "    "
                if isinstance(v, list):
                    lines.append(f"{prefix}{k}: {json.dumps(v, ensure_ascii=False)}")
                else:
                    lines.append(f"{prefix}{k}: {_yq(v)}")
                first = False

    perms = spec.get("permissions") or {}
    if perms:
        lines.append("permissions:")
        for k, v in perms.items():
            body = json.dumps(v, ensure_ascii=False) if isinstance(v, list) else _yq(v)
            lines.append(f"  {k}: {body}")

    triggers = spec.get("triggers") or []
    if triggers:
        lines.append("triggers:")
        for t in triggers:
            lines.append(f"  - {_yq(t)}")

    env = spec.get("requires_env") or {}
    lines.append("requires_env:" + (" {}" if not env else ""))
    if env:
        for k, v in env.items():
            lines.append(f"  {k}: {_yq(v)}")
    return "\n".join(lines) + "\n"


class Registry:
    """Read/write access to MCP servers and skills for the management endpoints."""

    def __init__(self, config_path: str, skills_dir: str,
                 backup_dir: Optional[str] = None, audit=None):
        self.config_path = os.path.abspath(config_path)
        self.skills_dir = os.path.abspath(skills_dir)
        # <root>/config/mcp_servers.json -> <root>
        self.root = os.path.dirname(os.path.dirname(self.config_path))
        self.backup_dir = backup_dir or os.path.join(
            os.path.dirname(self.config_path), ".backups")
        self.audit = audit

    # ─── Config file: atomic write + rotating backups ──────────────────────────────

    def _read_config(self) -> dict:
        return load_config(self.config_path) or {}

    def _write_config(self, cfg: dict) -> Optional[str]:
        """Persist the config atomically. Returns the backup path (None if no prior file)."""
        backup = self._backup()
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        tmp = f"{self.config_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.config_path)
        return backup

    def _backup(self) -> Optional[str]:
        if not os.path.isfile(self.config_path):
            return None
        os.makedirs(self.backup_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(self.backup_dir, f"mcp_servers.{stamp}.json")
        n = 0
        while os.path.exists(dest):
            n += 1
            dest = os.path.join(self.backup_dir, f"mcp_servers.{stamp}-{n}.json")
        shutil.copy2(self.config_path, dest)
        self._prune_backups()
        return dest

    def _prune_backups(self):
        try:
            files = sorted(f for f in os.listdir(self.backup_dir)
                           if f.startswith("mcp_servers.") and f.endswith(".json"))
        except OSError:
            return
        for f in files[:-MAX_BACKUPS]:
            try:
                os.remove(os.path.join(self.backup_dir, f))
            except OSError:
                pass

    def _note(self, etype: str, **kw):
        """Audit a mutation. Never let logging failure break the write that already happened."""
        if not self.audit:
            return
        try:
            self.audit.event(etype, **kw)
        except Exception:
            pass

    # ─── MCP servers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _servers_of(cfg: dict) -> dict:
        return dict(cfg.get("mcpServers") or cfg.get("mcp_servers") or {})

    def _origin(self, spec: dict) -> str:
        """Classify an entry: generated by a skill, shipped with the project, or user-added."""
        if (spec or {}).get(SKILL_TAG):
            return "skill"
        servers_dir = os.path.join(self.root, "servers")
        for a in ((spec or {}).get("args") or []):
            try:
                if os.path.dirname(os.path.abspath(str(a))).lower() == servers_dir.lower():
                    return "builtin"
            except Exception:
                continue
        return "user"

    def _describe(self, name: str, spec: dict) -> dict:
        spec = spec or {}
        return {"name": name,
                "command": spec.get("command", "") or "",
                "args": list(spec.get("args") or []),
                "cwd": spec.get("cwd") or "",
                "env": dict(spec.get("env") or {}),
                "origin": self._origin(spec),
                "skill": spec.get(SKILL_TAG)}

    @staticmethod
    def _clean_spec(spec: dict) -> dict:
        """Keep only SERVER_KEYS, so a client cannot inject `_skill` or other internals."""
        out = {}
        for k in SERVER_KEYS:
            v = spec.get(k)
            if v in (None, "", [], {}):
                continue
            out[k] = v
        if not out.get("command"):
            raise RegistryError("'command' is required")
        return out

    def list_servers(self) -> list:
        cfg = self._read_config()
        out = [self._describe(n, s) for n, s in self._servers_of(cfg).items()]
        out.sort(key=lambda s: (s["origin"] != "builtin", s["name"]))
        return out

    def get_server(self, name: str) -> dict:
        servers = self._servers_of(self._read_config())
        if name not in servers:
            raise RegistryError(f"server '{name}' not found")
        return self._describe(name, servers[name])

    def add_server(self, name: str, spec: dict) -> dict:
        _check_name(name)
        cfg = self._read_config()
        servers = self._servers_of(cfg)
        if name in servers:
            raise RegistryError(f"server '{name}' already exists")
        servers[name] = self._clean_spec(spec)
        cfg["mcpServers"] = servers
        backup = self._write_config(cfg)
        self._note("mcp_add", extra={"server": name, "backup": backup})
        return {"server": self._describe(name, servers[name]),
                "warnings": self.validate_spec(servers[name]),
                "backup": backup}

    def update_server(self, name: str, spec: dict) -> dict:
        _check_name(name)
        cfg = self._read_config()
        servers = self._servers_of(cfg)
        if name not in servers:
            raise RegistryError(f"server '{name}' not found")
        # Preserve the skill tag: editing an expanded entry must not silently detach it
        # from its skill, or the next skill deletion would fail to clean it up.
        tag = (servers[name] or {}).get(SKILL_TAG)
        updated = self._clean_spec(spec)
        if tag:
            updated[SKILL_TAG] = tag
        servers[name] = updated
        cfg["mcpServers"] = servers
        backup = self._write_config(cfg)
        self._note("mcp_update", extra={"server": name, "backup": backup})
        return {"server": self._describe(name, servers[name]),
                "warnings": self.validate_spec(servers[name]),
                "backup": backup}

    def delete_server(self, name: str) -> dict:
        cfg = self._read_config()
        servers = self._servers_of(cfg)
        if name not in servers:
            raise RegistryError(f"server '{name}' not found")
        spec = servers[name] or {}
        if spec.get(SKILL_TAG):
            raise RegistryError(
                f"'{name}' is generated by skill '{spec[SKILL_TAG]}' — delete the skill instead")
        del servers[name]
        cfg["mcpServers"] = servers
        backup = self._write_config(cfg)
        self._note("mcp_delete", extra={"server": name, "backup": backup})
        return {"deleted": name, "origin": self._origin(spec), "backup": backup}

    def validate_spec(self, spec: dict) -> list:
        """Non-fatal warnings about a spec. Never blocks a save (PATH/npx resolve later)."""
        warns = []
        cmd = str((spec or {}).get("command") or "").strip()
        if not cmd:
            return ["command is empty"]
        if os.path.isabs(cmd):
            if not os.path.exists(cmd):
                warns.append(f"command not found: {cmd}")
        elif not shutil.which(cmd):
            warns.append(f"command not on PATH: {cmd}")
        cwd = (spec or {}).get("cwd")
        if cwd and not os.path.isdir(str(cwd)):
            warns.append(f"cwd does not exist: {cwd}")
        return warns

    def test_server(self, spec: dict, name: str = "probe") -> dict:
        """Start a spec, list its tools, stop it. Never raises — a probe must not 500."""
        try:
            from executor import StdioServer
        except Exception as e:
            return {"ok": False, "tools": [], "error": f"executor unavailable: {e}"}
        srv = None
        try:
            srv = StdioServer(name, str(spec.get("command") or ""),
                              list(spec.get("args") or []),
                              spec.get("env") or None,
                              spec.get("cwd") or None)
            srv.start()
            tools = [{"name": t.get("name", ""),
                      "description": t.get("description", "")} for t in (srv.tools or [])]
            return {"ok": True, "tools": tools, "error": None}
        except Exception as e:
            return {"ok": False, "tools": [], "error": str(e)}
        finally:
            if srv is not None:
                try:
                    srv.stop()
                    # stop() only terminates; reap the child and close its pipes so no
                    # handle/warning lingers (a probe runs on every Test-button click).
                    proc = getattr(srv, "_proc", None)
                    if proc is not None:
                        try:
                            proc.wait(timeout=5)
                        except Exception:
                            pass
                        for pipe in (proc.stdin, proc.stdout, proc.stderr):
                            try:
                                if pipe is not None:
                                    pipe.close()
                            except Exception:
                                pass
                except Exception:
                    pass

    # ─── Skills ───────────────────────────────────────────────────────────────────

    def _skill_path(self, name: str, ext: Optional[str] = None) -> str:
        if ext:
            return os.path.join(self.skills_dir, f"{name}.{ext}")
        for e in ("yaml", "yml", "json"):
            p = os.path.join(self.skills_dir, f"{name}.{e}")
            if os.path.isfile(p):
                return p
        return os.path.join(self.skills_dir, f"{name}.yaml")

    def list_skills(self) -> list:
        if not os.path.isdir(self.skills_dir):
            return []
        out = []
        for fn in sorted(os.listdir(self.skills_dir)):
            if not fn.endswith((".yaml", ".yml", ".json")):
                continue
            raw = load_config(os.path.join(self.skills_dir, fn)) or {}
            tools = [t for t in (raw.get("tools") or []) if isinstance(t, dict)]
            out.append({
                "name": raw.get("name") or os.path.splitext(fn)[0],
                "file": fn,
                "description": raw.get("description") or "",
                "tools": tools,
                "permissions": raw.get("permissions") or {},
                "triggers": list(raw.get("triggers") or []),
                "requires_env": raw.get("requires_env") or {},
                "servers": [t.get("mcp") for t in tools if t.get("mcp")],
            })
        return out

    def _clean_skill(self, name: str, spec: dict) -> dict:
        tools = []
        for t in (spec.get("tools") or []):
            if not isinstance(t, dict):
                continue
            mcp = _check_name(t.get("mcp"))
            if not str(t.get("command") or "").strip():
                raise RegistryError(f"tool '{mcp}' is missing 'command'")
            tools.append({"mcp": mcp,
                          "command": str(t["command"]),
                          "args": list(t.get("args") or []),
                          **({"cwd": t["cwd"]} if t.get("cwd") else {})})
        if not tools:
            raise RegistryError("a skill needs at least one tool")
        return {"name": name,
                "description": str(spec.get("description") or ""),
                "tools": tools,
                "permissions": spec.get("permissions") or {},
                "triggers": [str(x) for x in (spec.get("triggers") or [])],
                "requires_env": spec.get("requires_env") or {}}

    def add_skill(self, name: str, spec: dict) -> dict:
        _check_name(name)
        path = self._skill_path(name)
        if os.path.exists(path):
            raise RegistryError(f"skill '{name}' already exists")
        clean = self._clean_skill(name, spec)
        cfg = self._read_config()
        servers = self._servers_of(cfg)
        for t in clean["tools"]:
            if t["mcp"] in servers:
                raise RegistryError(
                    f"tool server '{t['mcp']}' already exists in mcpServers")
        os.makedirs(self.skills_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(dump_skill(clean))
        backup = self._sync_skill(name, clean, cfg)
        self._note("skill_add", extra={"skill": name, "backup": backup})
        return {"skill": self._read_skill(name), "backup": backup}

    def update_skill(self, name: str, spec: dict) -> dict:
        _check_name(name)
        path = self._skill_path(name)
        if not os.path.isfile(path):
            raise RegistryError(f"skill '{name}' not found")
        clean = self._clean_skill(name, spec)
        cfg = self._read_config()
        servers = self._servers_of(cfg)
        for t in clean["tools"]:
            owner = (servers.get(t["mcp"]) or {}).get(SKILL_TAG)
            if t["mcp"] in servers and owner != name:
                raise RegistryError(
                    f"tool server '{t['mcp']}' already exists"
                    + (f" (owned by skill '{owner}')" if owner else ""))
        with open(path, "w", encoding="utf-8") as f:
            f.write(dump_skill(clean))
        backup = self._sync_skill(name, clean, cfg)
        self._note("skill_update", extra={"skill": name, "backup": backup})
        return {"skill": self._read_skill(name), "backup": backup}

    def delete_skill(self, name: str) -> dict:
        _check_name(name)
        path = self._skill_path(name)
        if not os.path.isfile(path):
            raise RegistryError(f"skill '{name}' not found")
        cfg = self._read_config()
        servers = self._servers_of(cfg)
        # Remove exactly the entries this skill created, matched by tag rather than by
        # name — a rename in the yaml would otherwise leave the old entry orphaned.
        removed = [k for k, v in servers.items() if (v or {}).get(SKILL_TAG) == name]
        for k in removed:
            del servers[k]
        cfg["mcpServers"] = servers
        backup = self._write_config(cfg)
        os.remove(path)
        self._note("skill_delete", extra={"skill": name, "backup": backup})
        return {"deleted": name, "servers_removed": removed, "backup": backup}

    def _read_skill(self, name: str) -> dict:
        for s in self.list_skills():
            if s["name"] == name:
                return s
        return {"name": name}

    def _sync_skill(self, name: str, spec: dict, cfg: Optional[dict] = None) -> Optional[str]:
        """Expand a skill into mcpServers entries so the Strata host can start it too.

        `$SKILL_DIR` is resolved to an absolute path here: the yaml keeps the placeholder
        (so the skill stays portable), but Strata has no idea what it means and would pass
        the literal string to the child process.

        It resolves to the skills directory ITSELF, not <skills>/<name>/ — skills_loader
        derives it from the yaml file's directory, and example.yaml relies on that (its
        example_server.py sits directly in skills/). Expanding to a per-skill subdirectory
        would make the gateway start a different path than the entry Strata reads, so the
        two consumers have to agree on one meaning.
        """
        cfg = self._read_config() if cfg is None else cfg
        servers = self._servers_of(cfg)
        skill_dir = self.skills_dir
        # Drop entries this skill previously created, so a removed tool does not linger.
        for k, v in list(servers.items()):
            if (v or {}).get(SKILL_TAG) == name and k not in {
                    t["mcp"] for t in spec["tools"]}:
                del servers[k]
        for t in spec["tools"]:
            entry = {"command": t["command"],
                     "args": [_sub(a, skill_dir) for a in t.get("args", [])],
                     "cwd": _sub(t.get("cwd") or "$SKILL_DIR", skill_dir),
                     SKILL_TAG: name}
            env = spec.get("requires_env") or {}
            if env:
                entry["env"] = {k: _sub(v, skill_dir) for k, v in env.items()}
            servers[t["mcp"]] = entry
        cfg["mcpServers"] = servers
        return self._write_config(cfg)


def resolve_servers(cfg: dict, skills_dir: Optional[str] = None) -> dict:
    """Merge config mcpServers with skills into one server mapping.

    Moved here from gateway.py so the HTTP layer can rebuild the executor after a config
    change without importing gateway — gateway imports http_server, so the reverse import
    would be circular. Re-exported by gateway for existing callers.
    """
    from skills_loader import load_skills
    s = dict(cfg.get("mcpServers") or cfg.get("mcp_servers") or {})
    if skills_dir:
        try:
            s.update(load_skills(skills_dir))
        except Exception:
            pass
    # Deploy robustness, carried over from gateway: a bare "python" must resolve to the
    # running interpreter, because the managed runtime usually is not on PATH. Without
    # this the reload path would start servers that startup would have resolved fine.
    for entry in s.values():
        if isinstance(entry, dict) and entry.get("command") == "python":
            entry["command"] = sys.executable
    return s
