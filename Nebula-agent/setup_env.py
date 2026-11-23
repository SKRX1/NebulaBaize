#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Nebula Agent environment setup helper.

Run by setup.bat after a Python >=3.10 is located (or auto-installed):
  1. create a project-local venv at <agent>/.venv (if missing)
  2. install the pinned runtime deps from requirements.txt into the venv
     (pillow / psutil / PySocks) so a FRESH CLONE is runnable, not just the
     dev box that already has them
  3. rewrite config/mcp_servers.json + the .bat launchers so every
     component uses <agent>/.venv/Scripts/python.exe
  4. verify the venv python can import all servers + the gateway

Idempotent: re-running is safe (paths already pointing at the venv are
left untouched).
"""
import sys, os, json, re, subprocess, shutil

AGENT = os.path.dirname(os.path.abspath(__file__))      # .../Nebula-agent
ROOT = os.path.dirname(AGENT)                            # .../星云智能体
VENV = os.path.join(AGENT, ".venv")
# venv layout is platform-specific: Windows uses Scripts/python.exe, POSIX uses
# bin/python. Derive both from sys.platform so `setup` runs on Win11/Linux/macOS.
_BIN = "Scripts" if sys.platform == "win32" else "bin"
_EXE = "python.exe" if sys.platform == "win32" else "python"
VENV_PY = os.path.join(VENV, _BIN, _EXE)


def log(msg):
    print(msg, flush=True)


def _looks_abs(p):
    """True if p is a Windows drive-anchored absolute path string."""
    return bool(re.match(r"^[A-Za-z]:[\\/]", p)) if isinstance(p, str) else False


def rewrite_mcp_install_paths(cfg, root, venv_py=None):
    r"""Re-point every install-dependent absolute path in an mcp_servers config dict so it
    follows `root` (this install's project root). Mutates cfg in place; returns True when
    anything changed.

    Rules (verified by tests/test_install_portable_paths.mjs's python twin):
      * command            -> venv_py (when supplied).
      * cwd, args[], and env values that START WITH the stale signature-machine root ->
        re-rooted onto `root` (tail preserved verbatim), so e.g.
        <old>\Nebula-agent\servers\fs_server.py becomes <root>\Nebula-agent\servers\fs_server.py.
      * The stale root is INFERRED from the config's own absolute paths (the longest-
        common prefix right before "Nebula-agent\"), so the dev box's drive is never
        hardcoded here -- it works no matter where the repo was originally authored.
      * LEFT UNTOUCHED by design: env FS_ALLOW (the user's personal extra-root allowlist,
        e.g. their own workspace folders) and env STRATA_PROXY (a URL, not a filesystem
        path). Repointing those would corrupt personal config / rewrite a URL.
    """
    servers = cfg.get("mcpServers", {}) or {}

    # infer the old (signature-machine) project root from the absolute paths still baked
    # into the config: the shortest "<X>\Nebula-agent\" prefix wins.
    old_root = None
    for s in servers.values():
        cands = [s.get("command"), s.get("cwd")] + list(s.get("args", []) or []) + list((s.get("env") or {}).values())
        for c in cands:
            if _looks_abs(c):
                m = re.match(r"^(.*?)[\\/]Nebula-agent[\\/]", c)
                if m:
                    cand = m.group(1)
                    if old_root is None or len(cand) < len(old_root):
                        old_root = cand

    def _repoint(p):
        if not _looks_abs(p) or not old_root:
            return p, False
        if p.lower().startswith(old_root.lower()):
            np = root + p[len(old_root):]
            return np, (np != p)
        return p, False

    changed = False
    for s in servers.values():
        if venv_py and s.get("command") != venv_py:
            s["command"] = venv_py
            changed = True
        np, ch = _repoint(s.get("cwd"))
        if ch:
            s["cwd"] = np; changed = True
        args = s.get("args")
        if isinstance(args, list):
            na = []
            for a in args:
                np, ch = _repoint(a)
                na.append(np); changed = changed or ch
            s["args"] = na
        env = s.get("env")
        if isinstance(env, dict):
            for ek, ev in list(env.items()):
                if ek in ("FS_ALLOW", "STRATA_PROXY"):   # personal allowlist / URL: never repoint
                    continue
                np, ch = _repoint(ev)
                if ch:
                    env[ek] = np; changed = True
    return changed


def backup_once(src):
    """One-shot backup: copy src -> src + ".bak" ONLY when no .bak exists yet.

    Returns True when a backup was written, False when one already existed. The
    exists-guard is the point: a re-run of setup on an already-rewritten box must not
    clobber the ORIGINAL first-run backup with the (now-correct) rewritten copy. Both
    the mcp_servers.json rewrite and the fs_allowed_roots reset use this so the
    "back up once, never overwrite" rule lives in exactly one tested place.
    """
    if os.path.exists(src + ".bak"):
        return False
    shutil.copyfile(src, src + ".bak")
    return True


def reset_fs_allowed_roots(path, root, keep=False):
    r"""Make the file-operation allowlist usable on THIS machine after a path move.

    The repo ships fs_allowed_roots.txt carrying the ORIGINAL author's personal workspace
    folders (E:\星云\..., each project dir). On a fresh clone / new drive those paths mostly
    do not exist, so the file tools start with an allowlist naming nothing the new user can
    actually operate -- the one step a path-move used to require editing by hand.

    Semantics (the "reset to this install's root / optionally keep" switch):
      * keep=True  -> leave the file EXACTLY as-is, return False. Used by --keep-roots so a
                      hand-curated allowlist is never clobbered by a re-run of setup.
      * keep=False -> rewrite to: every OLD entry that STILL EXISTS on this machine, plus the
                      install ROOT (deduped, order preserved). On a fresh machine the old
                      personal dirs are gone, so it collapses to just [ROOT] -- the project is
                      then operable out of the box. On the original box the old dirs still
                      exist so the list stays effectively intact (idempotent). A one-shot .bak
                      of the shipped original is kept (only if none exists), matching the
                      mcp_servers.json backup convention. Returns True when content changed.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            old = [l.strip() for l in f if l.strip()]
    except OSError:
        return False
    if keep:
        return False
    kept = [d for d in old if os.path.isdir(d)]
    if not any(d.lower() == root.lower() for d in kept):
        kept.append(root)
    new_text = "".join(d + "\n" for d in kept)
    old_text = "".join(d + "\n" for d in old)
    if new_text == old_text:
        return False
    backup_once(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    return True


def main():
    # 1) create venv if missing
    if not os.path.exists(VENV_PY):
        log("[setup] creating project venv at: " + VENV)
        try:
            subprocess.run([sys.executable, "-m", "venv", VENV], check=True)
        except subprocess.CalledProcessError as e:
            log("[setup] FAILED to create venv: " + str(e))
            sys.exit(1)
    else:
        log("[setup] venv already exists: " + VENV_PY)

    if not os.path.exists(VENV_PY):
        log("[setup] ERROR: venv python not found after creation")
        sys.exit(1)

    # 2) install the pinned runtime deps into the venv so a FRESH CLONE runs
    #    (the dev box already has them, a clone does not). Best-effort on pip
    #    network blips; step 4's import probe is the real gate -- if a hard dep
    #    (pillow/psutil/PySocks) is missing the probe goes RED with a clear trace.
    req = os.path.join(AGENT, "requirements.txt")
    if os.path.exists(req):
        log("[setup] installing pinned requirements into the venv (pillow/psutil/PySocks) ...")
        try:
            subprocess.run([VENV_PY, "-m", "pip", "install", "-r", req], check=True)
            log("[setup] requirements installed")
        except subprocess.CalledProcessError as e:
            log("[setup] WARN: pip install failed (network / offline?): " + str(e))
            log("[setup]       retry manually:  " + VENV_PY + " -m pip install -r " + req)
    else:
        log("[setup] WARN: requirements.txt not found, skipping dependency install")

    # 3) rewrite mcp_servers.json so EVERY path field follows this install's location.
    #    The repo stores the dev box's absolute paths; a fresh clone dropped in another
    #    folder would keep those stale and the 8 servers would fail to start. The pure
    #    helper rewrite_mcp_install_paths() re-points command/args/cwd and install-derived
    #    env (FS_ROOT / FS_ALLOW_FILE / ...), while leaving the user's personal FS_ALLOW
    #    allowlist and the STRATA_PROXY URL untouched. It is a module-level pure function
    #    so a regression test can feed it a synthetic config + fake root without building
    #    a venv or running pip.
    mj = os.path.join(AGENT, "config", "mcp_servers.json")
    if os.path.exists(mj):
        with open(mj, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if rewrite_mcp_install_paths(cfg, ROOT, venv_py=VENV_PY):
            # The rewrite overwrites a config every MCP server reads at start. Keep a
            # one-shot .bak of the shipped original so a wrong install-root guess stays
            # recoverable. Only the FIRST run backs up: re-running setup on an already-
            # rewritten box must not clobber the original first-run backup with the
            # (now-correct) rewritten copy.
            if backup_once(mj):
                log("[setup] backed up mcp_servers.json -> mcp_servers.json.bak")
            with open(mj, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
                f.write("\n")
            log("[setup] mcp_servers.json -> this install's paths + venv python")
        else:
            log("[setup] mcp_servers.json already points to this install")
    else:
        log("[setup] WARN: " + mj + " not found, skipped")

    # 4) rewrite the .bat launchers
    py_re = re.compile(r'[A-Za-z]:\\[^\s"\'<>|]*?python\.exe')
    set_re = re.compile(r'(?m)^set\s+PYTHON=.*$')
    bats = [
        os.path.join(AGENT, "run_standalone.bat"),
    ]
    for b in bats:
        if not os.path.exists(b):
            continue
        with open(b, "r", encoding="utf-8") as f:
            t = f.read()
        t2 = set_re.sub(lambda m: "set PYTHON=" + VENV_PY, t)
        t2 = py_re.sub(lambda m: VENV_PY, t2)
        if t2 != t:
            with open(b, "w", encoding="utf-8") as f:
                f.write(t2)
            log("[setup] rewrote " + os.path.basename(b))
        else:
            log("[setup] " + os.path.basename(b) + " already correct")

    # 3.5) reset the file-operation allowlist so the project is operable out of the box
    #      after a path move. --keep-roots leaves it untouched (protect a hand-curated
    #      allowlist); otherwise entries still existing on THIS machine are kept and the
    #      install root is added, collapsing to just the root on a fresh clone.
    keep_roots = ("--keep-roots" in sys.argv) or ("--keep-allow" in sys.argv)
    faf = os.path.join(ROOT, "fs_allowed_roots.txt")
    if os.path.exists(faf):
        if keep_roots:
            log("[setup] fs_allowed_roots.txt kept as-is (--keep-roots)")
        elif reset_fs_allowed_roots(faf, ROOT, keep=False):
            log("[setup] fs_allowed_roots.txt reset to this machine's live roots (+install root)")
        else:
            log("[setup] fs_allowed_roots.txt already matches this machine")
    else:
        log("[setup] WARN: " + faf + " not found, skipped")

    # 5) verify venv python can import everything
    log("[setup] verifying venv python loads all components ...")
    servers_dir = os.path.join(AGENT, "servers")
    mods = [
        "fs_server", "shell_server", "websearch_server", "memory_server",
        "browser_server", "schedule_server", "skillhub_server", "registry_server",
        "runtime.gateway", "runtime.executor",
    ]
    probe = (
        "import importlib, sys; "
        "sys.path.insert(0, r'" + servers_dir + "'); "
        "sys.path.insert(0, r'" + AGENT + "'); "
        "[importlib.import_module(n) for n in " + repr(mods) + "]; "
        "print('IMPORT_OK')"
    )
    r = subprocess.run([VENV_PY, "-c", probe], capture_output=True, text=True)
    if "IMPORT_OK" in (r.stdout or ""):
        log("[setup] VERIFY OK: all 8 servers + gateway/executor import under venv python")
    else:
        log("[setup] VERIFY FAILED:\n" + ((r.stderr or r.stdout)[:600]))
        sys.exit(1)

    log("")
    log("[setup] DONE. interpreter in use: " + VENV_PY)
    log("[setup] Next step: run 星云白泽.bat")


if __name__ == "__main__":
    main()
