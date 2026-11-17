# -*- coding: utf-8 -*-
"""编码端到端自检（startup encoding canary）
挂在 run_standalone.bat 启动时运行（也手动可跑）。
每个环节输出"磁盘字节 -> 期望中文 -> 实测回读"三方对照，任何一跳乱码立刻可见。
退出码：0=全部绿；1=有环节乱码（打印在启动日志与 logs/encoding_canary.jsonl）。
"""
from __future__ import annotations
import io, json, os, subprocess, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Nebula-agent\
sys.path.insert(0, os.path.join(ROOT, "runtime"))
from textenc import smart_decode  # noqa: E402

CANARY = "编码自检中文测试"                      # pure intended output
LOG = os.path.join(ROOT, "logs", "encoding_canary.jsonl")
results = []

def record(stage: str, got: str, want: str) -> None:
    ok = (got == want)
    results.append({"stage": stage, "ok": ok, "got": got[:120]})
    print(f"  [{'OK ' if ok else 'BAD'}] {stage}: {got[:80]!r}")

# env sanity
print("== encoding canary ==")
print(f"  PYTHONUTF8={os.environ.get('PYTHONUTF8','-')}  PYTHONIOENCODING={os.environ.get('PYTHONIOENCODING','-')}")

# 1) my own stdout round trip (what the launcher window / log will show)
line = subprocess.run([sys.executable, "-c", f"print({CANARY!r})"],
                      capture_output=True, cwd=ROOT)
record("py-child-stdout", smart_decode(line.stdout).strip(), CANARY)

# 2) cmd.exe built-in echo (OEM codec path)
c = subprocess.run(f'echo {CANARY}', shell=True, capture_output=True, cwd=ROOT)
record("cmd-echo", smart_decode(c.stdout).strip(), CANARY)

# 3) PowerShell -Command Write-Output (UTF8-via-pipe path)
p = subprocess.run(["powershell", "-NoProfile", "-Command", f"Write-Output '{CANARY}'"],
                   capture_output=True, cwd=ROOT)
record("ps-command", smart_decode(p.stdout).strip(), CANARY)

# 4) PowerShell -File reading a UTF-8 NO-BOM script (known-bad on PS5.1)
tmp = os.path.join(ROOT, "tools", "_canary_probe.ps1")
with open(tmp, "wb") as f:
    f.write(f"Write-Host '{CANARY}'\r\n".encode("utf-8"))
pf = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp],
                    capture_output=True, cwd=ROOT)
got = smart_decode(pf.stdout).strip()
# reference the KNOWN PS5.1 -File no-BOM behaviour: only a warning here
warn = got != CANARY
results.append({"stage": "ps-file-nobom", "ok": not warn, "got": got[:120],
                "note": "PS5.1 -File reads no-BOM UTF-8 as GBK (known)"})
print(f"  [{'OK ' if not warn else 'WARN'}] ps-file-nobom: {got[:80]!r}  (known PS5.1 -File behavior, not counted in verdict)")

# 5) filesystem read of a UTF-8 no-BOM text file through OUR fs_server decode path
tmpf = os.path.join(ROOT, "tools", "_canary_probe.txt")
with open(tmpf, "wb") as f:
    f.write((CANARY + "\n").encode("utf-8"))
with open(tmpf, "rb") as f:
    record("fs-read-utf8-nobom", smart_decode(f.read()).strip(), CANARY)

# cleanup own probes (they are scratch, not permanent files)
for t in (tmp, tmpf):
    try: os.remove(t)
    except OSError: pass

# verdict + log
bad = [r for r in results if not r["ok"] and r["stage"] != "ps-file-nobom"]
verdict = "GREEN" if not bad else "RED"
print(f"== canary verdict: {verdict} "
      f"({len(results)-len(bad)}/{len(results)} stages ok) ==")
os.makedirs(os.path.dirname(LOG), exist_ok=True)
with open(LOG, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"ts": datetime.datetime.now().isoformat(),
                         "verdict": verdict, "stages": results}, ensure_ascii=False) + "\n")
sys.exit(0 if verdict == "GREEN" else 1)
