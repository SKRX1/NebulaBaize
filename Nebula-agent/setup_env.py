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
import sys, os, json, re, subprocess

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

    # 3) rewrite mcp_servers.json (set every server's command to venv python)
    mj = os.path.join(AGENT, "config", "mcp_servers.json")
    if os.path.exists(mj):
        with open(mj, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        changed = False
        for name, s in cfg.get("mcpServers", {}).items():
            if s.get("command") != VENV_PY:
                s["command"] = VENV_PY
                changed = True
        if changed:
            with open(mj, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
                f.write("\n")
            log("[setup] mcp_servers.json -> venv python  (8 servers)")
        else:
            log("[setup] mcp_servers.json already points to venv")
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
