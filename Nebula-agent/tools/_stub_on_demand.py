# -*- coding: utf-8 -*-
"""Isolation stub: temporarily remove low-freq servers from mcp_servers.json,
run full regression, then restore. Reports what breaks."""
import json, os, sys, subprocess, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Nebula-agent/
CFG = os.path.join(ROOT, "config", "mcp_servers.json")
BAK = CFG + ".stub_bak"

REMOVE = ["schedule", "skillhub", "registry", "example-server"]

# Backup
shutil.copy2(CFG, BAK)

cfg = json.load(open(CFG, encoding="utf-8"))
servers = cfg.get("mcpServers", cfg)
print(f"BEFORE: {sorted(servers.keys())}")

for r in REMOVE:
    if r in servers:
        servers.pop(r)

with open(CFG, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)

verify = json.load(open(CFG, encoding="utf-8"))
print(f"AFTER:  {sorted(verify.get('mcpServers', verify).keys())}")
print(f"Running full regression on stripped config...")
print()

# Run full suite
result = subprocess.run(
    [sys.executable, os.path.join(ROOT, "tools", "run_tests.py")],
    cwd=ROOT,
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
    timeout=300,
)

# Restore
shutil.move(BAK, CFG)
print("Config restored.")
print()

# Print results
lines = (result.stdout + result.stderr).splitlines()
# Show only lines with PASS/FAIL/SUITE/REGRESSION/GREEN/RED or the suite names
for l in lines:
    if any(k in l.upper() for k in ["PASS", "FAIL", "SUITE", "REGRESSION", "GREEN", "RED", "OK", "ERROR", "TIMEOUT"]):
        print(l)

exit_code = result.returncode
print(f"\nEXIT CODE: {exit_code}")
if exit_code != 0:
    print("\nFull output tail:")
    print("\n".join(lines[-30:]))
