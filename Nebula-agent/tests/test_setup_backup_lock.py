# -*- coding: utf-8 -*-
"""Setup rewrite-backup regression: setup_env.py overwrites config/mcp_servers.json (a file
every MCP server reads at start) and the fs allowlist, so a wrong install-root guess needs an
undo. setup_env.py keeps a one-shot .bak via backup_once(); this locks that the backup is made
AND is never overwritten on a re-run, plus that reset_fs_allowed_roots collapses a stale
allowlist onto this machine's live roots (+install root) and honours --keep.

  T1  backup_once: first call copies src->src.bak (returns True); a SECOND call after src has
      been rewritten returns False and leaves src.bak holding the ORIGINAL.
        load-bearing: dropping the exists-guard makes the 2nd call clobber the backup -> RED.
  T2  the real step-3 flow (load cfg -> rewrite_mcp_install_paths -> backup_once -> dump) on a
      synthetic config: src.bak keeps the shipped stale-ROOT content, the live file is re-rooted,
      and re-running the whole flow does not touch src.bak.
        load-bearing: if backup_once were skipped, src.bak would not exist -> RED.
  T3  reset_fs_allowed_roots: on a fresh machine (none of the old personal dirs exist) it
      collapses to just [root]; keep=True leaves the file byte-for-byte; a second default pass
      is idempotent (returns False, no re-backup); and entries that DO still exist are kept.
        load-bearing: keep=True must NOT rewrite; if the guard dropped it would add root and the
        file would change -> RED.

Run standalone: python tests/test_setup_backup_lock.py   (also registered in tools/run_tests.py)
"""
import sys, os, json, tempfile, shutil, importlib.util
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # .../Nebula-agent
FAILS = []
def check(desc, cond):
    print(("  PASS " if cond else "  FAIL ") + desc)
    if not cond:
        FAILS.append(desc)

def load_setup_env():
    spec = importlib.util.spec_from_file_location(
        "setup_env_under_test2", os.path.join(ROOT, "setup_env.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

m = load_setup_env()
OLD = r"E:\OldBox"
NEW = r"D:\fresh\clone"
venv = NEW + r"\Nebula-agent\.venv\Scripts\python.exe"

# ---------------- T1: backup_once one-shot ----------------
print("T1: backup_once one-shot + never-overwrite")
tmp = tempfile.mkdtemp(prefix="backuplock_t1_")
src = os.path.join(tmp, "mcp_servers.json")
orig = json.dumps({"mcpServers": {"filesystem": {"command": OLD + r"\Nebula-agent\.venv\python.exe",
                                                  "args": [OLD + r"\Nebula-agent\servers\fs_server.py"]}}},
                  indent=2)
open(src, "w", encoding="utf-8").write(orig)
first = m.backup_once(src)
bak = src + ".bak"
check("T1 first backup_once returns True and creates .bak", first is True and os.path.exists(bak))
check("T1 .bak holds the ORIGINAL shipped content", open(bak, encoding="utf-8").read() == orig)
# rewrite src in place, then a SECOND backup_once must be a no-op (this is the load-bearing bit)
open(src, "w", encoding="utf-8").write("{rewritten by setup}")
second = m.backup_once(src)
check("T1 second backup_once returns False (one-shot)", second is False)
check("T1 .bak STILL the original after rewrite+2nd call (not clobbered)",
      open(bak, encoding="utf-8").read() == orig)

# ---------------- T2: real step-3 flow ----------------
print("\nT2: step-3 rewrite flow keeps a .bak of the shipped stale config")
tmp2 = tempfile.mkdtemp(prefix="backuplock_t2_")
mj = os.path.join(tmp2, "mcp_servers.json")
cfg = {"mcpServers": {
    "filesystem": {"command": OLD + r"\Nebula-agent\.venv\python.exe",
                   "args": [OLD + r"\Nebula-agent\servers\fs_server.py"],
                   "cwd": OLD + r"\Nebula-agent",
                   "env": {"FS_ROOT": OLD + r"\Nebula-agent", "FS_ALLOW": r"E:\personal"}}}}
shipped_text = json.dumps(cfg, indent=2, ensure_ascii=False)
open(mj, "w", encoding="utf-8").write(shipped_text)

def run_step3_once():
    with open(mj, "r", encoding="utf-8") as f:
        c = json.load(f)
    if m.rewrite_mcp_install_paths(c, NEW, venv_py=venv):
        m.backup_once(mj)
        with open(mj, "w", encoding="utf-8") as f:
            json.dump(c, f, indent=2, ensure_ascii=False)
            f.write("\n")
        return True
    return False

r1 = run_step3_once()
check("T2 first run reports a change", r1 is True)
check("T2 .bak exists and is the SHIPPED stale text",
      os.path.exists(mj + ".bak") and open(mj + ".bak", encoding="utf-8").read() == shipped_text)
live = json.load(open(mj, encoding="utf-8"))
check("T2 live file re-rooted to NEW install",
      live["mcpServers"]["filesystem"]["args"][0] == NEW + r"\Nebula-agent\servers\fs_server.py")
check("T2 FS_ALLOW left untouched in live file",
      live["mcpServers"]["filesystem"]["env"]["FS_ALLOW"] == r"E:\personal")
live_after = open(mj, encoding="utf-8").read()
bak_after = open(mj + ".bak", encoding="utf-8").read()
r2 = run_step3_once()   # re-run on already-rewritten box
check("T2 re-run makes no further change (idempotent rewrite)", r2 is False)
check("T2 re-run did NOT clobber .bak (still shipped original)",
      open(mj + ".bak", encoding="utf-8").read() == bak_after)

# ---------------- T3: reset_fs_allowed_roots ----------------
print("\nT3: reset_fs_allowed_roots fresh-machine collapse + --keep + idempotent")
tmp3 = tempfile.mkdtemp(prefix="backuplock_t3_")
root3 = os.path.join(tmp3, "NebulaBaize")   # pretend install root; make it real so isdir passes
os.makedirs(root3)
faf = os.path.join(tmp3, "fs_allowed_roots.txt")
gone1 = os.path.join(tmp3, "does_not_exist_1")   # never created -> treated as absent on fresh box
gone2 = os.path.join(tmp3, "does_not_exist_2")
live_dir = os.path.join(tmp3, "still_here")      # a personal dir that DOES still exist
os.makedirs(live_dir)
open(faf, "w", encoding="utf-8").write(
    "\n".join([gone1, live_dir, gone2]) + "\n")

# keep=True: file untouched (load-bearing: an ungarded keep would append root -> change)
keep_ret = m.reset_fs_allowed_roots(faf, root3, keep=True)
after_keep = open(faf, encoding="utf-8").read()
check("T3 keep=True returns False and leaves the file byte-for-byte",
      keep_ret is False and after_keep == gone1 + "\n" + live_dir + "\n" + gone2 + "\n")
check("T3 keep=True made NO .bak", not os.path.exists(faf + ".bak"))

# default collapse: drops the two non-existent dirs, keeps the one that exists, ensures root
ret = m.reset_fs_allowed_roots(faf, root3, keep=False)
lines = [l.strip() for l in open(faf, encoding="utf-8") if l.strip()]
check("T3 default pass returns True (changed)", ret is True)
check("T3 collapsed to exactly [still_here, root3] (stale dirs dropped, root appended)",
      lines == [live_dir, root3])
check("T3 a .bak was written before the rewrite", os.path.exists(faf + ".bak"))
bak_content = open(faf + ".bak", encoding="utf-8").read()
check("T3 .bak holds the ORIGINAL shipped allowlist",
      bak_content == gone1 + "\n" + live_dir + "\n" + gone2 + "\n")

# idempotent second pass
ret2 = m.reset_fs_allowed_roots(faf, root3, keep=False)
check("T3 second default pass returns False (already matches machine)", ret2 is False)
check("T3 .bak not re-written on the idempotent 2nd pass",
      open(faf + ".bak", encoding="utf-8").read() == bak_content)

# fresh-box worst case: ALL old dirs gone -> collapse to just [root]
faf2 = os.path.join(tmp3, "faf_fresh.txt")
open(faf2, "w", encoding="utf-8").write(gone1 + "\n" + gone2 + "\n")
m.reset_fs_allowed_roots(faf2, root3, keep=False)
lines2 = [l.strip() for l in open(faf2, encoding="utf-8") if l.strip()]
check("T3 on a truly fresh box (no old dirs exist) allowlist collapses to just [root]",
      lines2 == [root3])

# cleanup
for d in (tmp, tmp2, tmp3):
    try: shutil.rmtree(d)
    except Exception: pass

print("\n---- setup-backup-lock summary ----")
if FAILS:
    for f in FAILS:
        print("FAIL:", f)
    print("TOTAL FAILS: %d" % len(FAILS))
    sys.exit(1)
print("ALL PASSED")
sys.exit(0)
