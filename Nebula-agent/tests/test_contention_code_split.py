# -*- coding: utf-8 -*-
"""Differential lock for the contention-vs-overflow CODE split (2026-11, "low-occupancy
refusal still compacted" report).

Root cause it locks: a low-occupancy upstream 400 is SHARED-KV-pool contention, NOT a full
window. Before the fix both branches emitted the SAME notice code "context_overflow", and the
frontend keys context_overflow on "compact first" (continueTask) and EXCLUDES it from auto-resume
(maybeAutoResume). So a modest conversation was forced through compaction -- a no-op against pool
pressure -- and could not auto-resume. The fix: the contention branch emits a DISTINCT code
"contention -> context_contention"; the frontend's existing branches then route it correctly with
NO frontend change (it is not "context_overflow", so continueTask continues in place and
auto-resume's `code !== "context_overflow"` guard lets it through).

This gate is a source-level DIFFERENTIAL (it never runs the long-lived server; it imports the
pure helper and reads the stream source as text), matching the ASCII-word rule -- the Chinese
wording itself is never matched:
  * overflow_action still returns "notice_contention" for under-line + already-retried  (unchanged pure decision)
  * the stream source calls notice("context_contention", text=_CONTENTION_TEXT) EXACTLY once
  * _CONTENTION_TEXT is NEVER paired with notice("context_overflow"  (the crux: the split happened)
  * a genuine-overflow notice("context_overflow" STILL exists (the split did not clobber the real path)
  * the i18n resume-command key chat.resume.cmd.context_contention exists in BOTH dicts, paired
  * the frontend continueTask still keys ONLY context_overflow (it must NOT special-case the new
    code -- relying on fall-through is the whole design; a future edit that special-cases it breaks this)
Pure standard library. Registers in tools/run_tests.py.
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
from http_server import overflow_action  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + ((" -> " + extra) if extra else ""))
    if not cond:
        fails.append(name)


def read_text(rel):
    return io.open(os.path.join(ROOT, rel), "rb").read().decode("utf-8")


WIN = 131072
UNDER = 70000  # ~53%, the report's panel value

# ── The pure decision is untouched: under-line + already retried STILL says contention ──
check("overflow_action(under-line, already-retried) == notice_contention",
      overflow_action(UNDER, WIN, True) == "notice_contention",
      overflow_action(UNDER, WIN, True))

# ── Source split: the contention notice carries the DISTINCT code, exactly once ──
stream_src = read_text("runtime/http_server.py")
n_contention = stream_src.count('notice("context_contention", text=_CONTENTION_TEXT)')
check("contention branch -> notice(\"context_contention\", text=_CONTENTION_TEXT) exactly once",
      n_contention == 1, "count=%d" % n_contention)

# ── CRUX differential: _CONTENTION_TEXT is NEVER emitted under context_overflow ──
# (a single-arg notice with that text under the old code would be count>0; the split must drop it)
bad_pair = stream_src.count('notice("context_overflow", text=_CONTENTION_TEXT)')
check("no _CONTENTION_TEXT under context_overflow (the split happened)",
      bad_pair == 0, "count=%d" % bad_pair)

# ── The genuine-overflow path is NOT clobbered: a context_overflow notice still exists ──
check("genuine context_overflow notice still present (real path intact)",
      stream_src.count('notice("context_overflow"') >= 1,
      "count=%d" % stream_src.count('notice("context_overflow"'))

# ── i18n: the resume-command key exists and is PAIRED (zh count == en count, both == 1) ──
i18n = read_text("serve/web/i18n.js")
key = '"chat.resume.cmd.context_contention"'
nkey = i18n.count(key)
check("chat.resume.cmd.context_contention present exactly twice (zh+en pair)",
      nkey == 2, "count=%d" % nkey)

# ── Frontend rely-on-fall-through: continueTask keys ONLY context_overflow, never the new code ──
app = read_text("serve/web/app.js")
check("continueTask keys only context_overflow for compaction",
      'if (m && m.notice && m.notice.code === "context_overflow") {' in app)
# Scope "no special-case" to continueTask's OWN body (a slice between its definition and the next
# function). A whole-file count==0 lock is now wrong: Plan-A (2026-11) deliberately added a
# context_contention exclusion into maybeAutoResume's mainResumable guard, so the token legitimately
# appears elsewhere -- but continueTask must STILL continue in place for it (rely on fall-through).
_ct_start = app.index("function continueTask(")
_ct_end = app.index("\nfunction ", _ct_start + 1)
_ct_body = app[_ct_start:_ct_end]
check("continueTask body does NOT special-case context_contention (fall-through is the design)",
      "context_contention" not in _ct_body)
# auto-resume STILL excludes context_overflow; Plan-A additionally excludes context_contention so a
# shared-pool wall is parked for the human instead of auto-bricked every 3s and spamming the banner.
check("auto-resume excludes context_overflow (true overflow never auto-resumes)",
      'm.notice.resumable && m.notice.code !== "context_overflow"' in app)
check("Plan-A: auto-resume ALSO excludes context_contention (no banner-spam loop)",
      'm.notice.code !== "context_overflow" && m.notice.code !== "context_contention"' in app)

if fails:
    print("\nFAILED: " + ", ".join(fails))
    sys.exit(1)
print("\nALL CONTENTION-CODE-SPLIT TESTS PASSED")
