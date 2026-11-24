#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Static lock: the shipped DEFAULTS.persona (默认人设 出厂默认) carries the owner persona.

ROOT (2026-11-24): the owner (时空) asked that the boot default persona be set to the
"星云白泽/星云, 主人时空, 资深前后端工程师" line. It lives ONLY in app.js DEFAULTS.persona
(settings.persona default; the drawer's s-persona textarea and apiMessages both fall back to it,
injecting it as the 【人设与长期偏好】 system message when no per-session persona is set). A
refactor or an accidental blank would silently drop the owner's standing identity.

This gate reads the shipped app.js, extracts the DEFAULTS.persona literal, asserts it is
non-empty AND carries every load-bearing identity token. Each token check is load-bearing by
construction: deleting any identity term from the value turns that check red (substring match,
so normal punctuation re-flow does not break it -- only loss of an identity term does).
Pure stdlib; reads shipped files only.
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APPJS = os.path.join(HERE, os.pardir, "serve", "web", "app.js")


def read(p):
    with io.open(p, "rb") as f:
        return f.read().decode("utf-8", "replace")


def default_persona(app_src):
    m = re.search(r'designAuto: true, persona: "([^"]*)",', app_src)
    return m.group(1) if m else None


# identity tokens that must survive (owner intent) -- substrings, tolerant of punctuation re-flow
TOKENS = [u"星云白泽", u"星云", u"时空象容", u"时空", u"主人", u"资深", u"前端", u"后端", u"可运行代码"]

app_src = read(APPJS)
fails = []
p = default_persona(app_src)

if p is None:
    fails.append("G0 DEFAULTS.persona literal not found in app.js (anchor drift?)")
else:
    if not p.strip():
        fails.append("G1 DEFAULTS.persona is empty -- the owner persona was dropped")
    for tok in TOKENS:
        if tok not in p:
            fails.append("G2 DEFAULTS.persona missing identity token: %s" % tok)

if fails:
    for f in fails:
        print("FAIL " + f)
    print("\n%d check(s) failed" % len(fails))
    sys.exit(1)

print("DEFAULT-PERSONA-LOCK: ALL GREEN  (DEFAULTS.persona non-empty; %d identity tokens present: %s)"
      % (len(TOKENS), ", ".join(TOKENS)))
