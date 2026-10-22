# -*- coding: utf-8 -*-
# PERMANENT GATE — lock the recoverable-archive design so it can never regress:
#   HARD 1  real write_tool_log_text -> read_tool_log round-trip is BYTE-FOR-BYTE (zero loss)
#   HARD 2  the whitelist N stays == 3 in app.js (the hard rule that keeps recent decisions)
#   HARD 3  archiveOn stays default TRUE in app.js (the design's whole point; must not flip off)
#   HARD 4  the whitelist keyword regex keeps catching decisions/task-state (simulate it)
# Deterministic: no upstream needed, so no self-skip. ASCII prints + a report file (convention).
import os, re, sys, tempfile, json
ROOT = r"E:\WorkBuddy\星云智能体\strata-agent"
sys.path.insert(0, os.path.join(ROOT, "runtime"))
from memory.session import write_tool_log_text, read_tool_log

APPP = os.path.join(ROOT, "serve", "web", "app.js")

def read_src(path):
    return open(path, encoding="utf-8").read()

def main():
    out = []
    hard_pass = True

    # ---- HARD 1: real-function byte-for-byte round-trip (the recoverability claim) ----
    scratch = tempfile.mkdtemp(prefix="archive_gate_")
    payload = "".join("line %d of archived history \u2014 \u51b3\u7b56\u4e8b\u5b9e mixed CJK/EN\n" % i
                      for i in range(200))
    tid = write_tool_log_text(scratch, payload)
    back = read_tool_log(scratch, tid) if tid else None
    h1 = (back == payload)
    hard_pass = hard_pass and h1
    out.append("HARD1 byte-for-byte round-trip via real functions : %s" % ("PASS" if h1 else "FAIL"))

    src = read_src(APPP)

    # ---- HARD 2: the whitelist hard rule stays N == 3 ----
    m = re.search(r"ARCHIVE_WHITELIST_N\s*=\s*(\d+)", src)
    h2 = bool(m) and int(m.group(1)) == 3
    hard_pass = hard_pass and h2
    out.append("HARD2 ARCHIVE_WHITELIST_N still == 3 in app.js      : %s (found=%s)"
               % ("PASS" if h2 else "FAIL", m.group(1) if m else "None"))

    # ---- HARD 3: archiveOn stays default TRUE (the feature's whole purpose) ----
    # match the DEFAULTS object entry, not the save/load runtime reads.
    m2 = re.search(r"\barchiveOn:\s*true\b", src)
    h3 = bool(m2)
    hard_pass = hard_pass and h3
    out.append("HARD3 archiveOn stays default TRUE in app.js        : %s" % ("PASS" if h3 else "FAIL"))

    # ---- HARD 4: simulate the whitelist regex on constructed input ----
    # mirror of app.js line ~6510 keyword regex (kept in lockstep; if the source regex's
    # keywords change, update this mirror and the test intent together).
    WL_RE = re.compile(r"(decision|chose|decided|=>|->|fix|\u51b3\u7b56|\u51b3\u5b9a|\u91c7\u7eb3|\u9009\u62e9|todo|next|\u5f85\u529e|\u4e0b\u4e00\u6b65|\u8ba1\u5212)", re.I)
    # 3 planted durable lines the whitelist MUST keep, + noise that must NOT be kept
    dropped_lines = [
        "just re-read the file structure to confirm current state, nothing actionable here",
        "DECISION: chose the shared escNum path for all number spans",
        "trying three css variants, all failed, revert",
        "decision: anchor hit-count must == 1 else abort",
        "pure process narration, echoing tool output, no lasting fact",
        "TASK next step: land the archive gate into run_tests",
    ]
    kept = [l for l in dropped_lines if WL_RE.search(l)]
    # the 3 durable lines (indices 1,3,5) must survive; the 3 narration lines must not
    expected_kept = {dropped_lines[1], dropped_lines[3], dropped_lines[5]}
    h4 = set(kept) == expected_kept and len(kept) <= 3   # whitelist keeps exactly the decisions
    hard_pass = hard_pass and h4
    out.append("HARD4 whitelist regex keeps the 3 decisions, drops  : %s (kept=%d)"
               % ("PASS" if h4 else "FAIL", len(kept)))

    out.append("")
    out.append("ARCHIVE-GATE: " + ("ALL GREEN (write/read zero-loss + whitelist N=3 + default-on, all locked)"
                                   if hard_pass else "RED - a hard contract broke"))
    open(os.path.join(ROOT, "tools", "_archive_gate_report.txt"), "w", encoding="utf-8").write("\n".join(out) + "\n")
    print("\n".join(out))
    return 0 if hard_pass else 1

if __name__ == "__main__":
    sys.exit(main())
