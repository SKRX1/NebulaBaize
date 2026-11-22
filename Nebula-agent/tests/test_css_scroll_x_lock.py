#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_css_scroll_x_lock.py - a vertical scroll container must pin its cross axis (overflow-x).

Root cause, measured on the running 8099 build: app.css declared

    .chat-scroll { flex: 1; min-height: 0; overflow-y: auto; }   # no overflow-x

CSS computes the OTHER axis of a scroll container from `visible` to `auto` whenever one axis
is auto/scroll. So a transient horizontal overflow inside the message area (a wide image / an
SVG / a code card mid-paint) sprouted a stray horizontal scrollbar that landed right ABOVE the
composer. Fix: declare overflow-x: hidden on the vertical scroller. The real horizontal
scrollers each own their own overflow (.st-code pre -> auto, .table-wrap -> overflow-x:auto),
so pinning the OUTER axis never truncates content that legitimately needs to scroll sideways.
A real-browser probe confirmed it: with the rule the container's computed overflow-x is hidden
and scrollWidth>clientWidth no longer draws a bar; the same container WITHOUT the rule computes
overflow-x:auto and does draw one. The fix was also extended repo-wide to every outer vertical
scroller (.view--scroll, .st-sidebar__list, .st-inspector, .st-modal__card, the admin lists, ...)
that had the identical latent shape.

Why a static gate and not a runtime one: jsdom/sim do NOT compute CSS layout, so only a real
browser can observe the bar -- which makes the rule expensive to verify each run but trivial to
lock textually. This guard keeps the FIX from being silently washed away by a refactor.

The rule: in any shipped CSS (serve/web/*.css), a rule block that sets overflow-y to auto/scroll
MUST also set overflow-x -- unless its selector is in the documented EXEMPTIONS below (every
exemption is a container that INTENTIONALLY scrolls on one axis, or one whose cross axis is
supplied by another rule on the same element). The differential proves each lock is load-bearing:
removing the overflow-x from .chat-scroll, or from any hardened selector, flips it red.
"""
import io
import os
import re
import sys

AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(AGENT, "serve", "web")
STYLE = re.compile(r"<style[^>]*>(.*?)</style>", re.I | re.S)
RULE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.S)

# Selectors that intentionally scroll on ONE axis, or whose cross axis comes from a sibling rule
# on the same element. Each is justified against a real shape in the shipped corpus -- these are
# NOT exempted to make the gate green, they are exempted because the single-axis rule is their
# intended, correct design:
EXEMPTIONS = {
    ".st-header .st-tabs",            # horizontal tab strip: overflow-x:auto IS the point (overflow-y never needed)
    ".img-gallery__grid--strip",      # horizontal image strip: overflow-x:auto is the intended one-axis scroller
    ".table-wrap",                    # horizontal table scroller: overflow-x:auto by design
    ".table-wrap.all",                # same element as .table-wrap (above); .table-wrap supplies overflow-x, .all adds overflow-y -> both axes present when combined
}

Y_SCROLL = re.compile(r"\boverflow-y\s*:\s*(auto|scroll)\b", re.I)
X_ANY = re.compile(r"\boverflow-x\s*:", re.I)
SHORT = re.compile(r"\boverflow\s*:", re.I)
# Selectors the gate MUST find and lock (the fixed .chat-scroll + every container hardened in the
# same pass). A missing one means a refactor deleted or renamed the rule -> the gate must go red.
REQUIRED = [
    ".chat-scroll", ".view--scroll", ".sidebar-settings__list", ".st-sidebar__list",
    ".st-inspector", ".st-modal__card", ".ws-browse__list", ".kb-panel__list",
    "#adm-servers", "#adm-skills", ".st-composer .ce-input", ".sched-manage-list",
    ".arc-hist__body", ".img-seedbook",
]


def strip_comments(text):
    """Blank out each /* ... */ body, keeping newlines so reported line numbers stay exact."""
    out, i, n = [], 0, len(text)
    while i < n:
        j = text.find("/*", i)
        if j < 0:
            out.append(text[i:]); break
        out.append(text[i:j])
        k = text.find("*/", j + 2)
        body = text[j:k] if k >= 0 else text[j:]
        out.append("".join(ch if ch == "\n" else " " for ch in body))
        i = (k + 2) if k >= 0 else n
    return "".join(out)


def read(path):
    return io.open(path, "rb").read().decode("utf-8", "replace")


def norm_sel(s):
    return " ".join(s.split())


def rule_blocks(css_text):
    """Yield (selector, body, line_no) for every CSS rule block, comments blanked."""
    clean = strip_comments(css_text)
    for m in RULE.finditer(clean):
        sel = norm_sel(m.group(1))
        line = clean[:m.start()].count("\n") + 1
        yield sel, m.group(2), line


def offenders(css_text):
    """[(selector,line)] of blocks that set overflow-y:auto/scroll but never set overflow-x nor the
    overflow shorthand, and are not in EXEMPTIONS."""
    bad = []
    for sel, body, line in rule_blocks(css_text):
        if not Y_SCROLL.search(body):
            continue
        if X_ANY.search(body) or SHORT.search(body):
            continue
        if sel in EXEMPTIONS:
            continue
        # an :is()/media sub-selector list -- exempt if EVERY listed selector is exempt
        parts = [norm_sel(p) for p in sel.split(",")]
        if all(p in EXEMPTIONS for p in parts):
            continue
        bad.append((sel, line))
    return bad


def find_block(css_text, selector):
    """The body of the first rule whose selector list contains `selector` exactly, or None."""
    clean = strip_comments(css_text)
    for m in RULE.finditer(clean):
        sels = [norm_sel(p) for p in norm_sel(m.group(1)).split(",")]
        if selector in sels:
            return m.group(2)
    return None


Fails = []


def ck(name, cond):
    sys.__stdout__.write(("PASS " if cond else "FAIL ") + name + "\n")
    sys.__stdout__.flush()
    if not cond:
        Fails.append(name)


def corpus_css():
    """(rel_path, text) for every shipped .css under serve/web."""
    out = []
    for dp, dn, fn in os.walk(WEB):
        dn[:] = [d for d in dn if d not in {"node_modules", "_site", ".git"}]
        for f in sorted(fn):
            if f.endswith(".css"):
                p = os.path.join(dp, f)
                out.append((os.path.relpath(p, AGENT).replace(os.sep, "/"), read(p)))
    return out


def main():
    css = corpus_css()
    appcss = next((t for rel, t in css if rel.endswith("app.css")), "")

    # G1 — the day-one green: no vertical scroller in the shipped corpus leaks a cross axis
    # (except the documented, intentional single-axis containers).
    all_bad = []
    for rel, t in css:
        for sel, line in offenders(t):
            all_bad.append("%s:%d %s" % (rel, line, sel))
    ck("G1 no vertical scroller leaves overflow-x undeclared (%d css files scanned)" % len(css),
       not all_bad)
    for f in all_bad:
        sys.__stdout__.write("     at " + f + "\n")
    ck("G2 the corpus actually contains app.css (else G1 passes vacuously)", bool(appcss))

    # G3 — every hardened / fixed selector still EXISTS and still carries overflow-x. A rename or
    # a refactor that drops the rule is exactly the regression this gate must catch.
    missing = []
    for sel in REQUIRED:
        body = find_block(appcss, sel)
        if body is None:
            missing.append("MISSING rule: " + sel)
        elif not (X_ANY.search(body) or SHORT.search(body)):
            missing.append("rule lost overflow-x: " + sel)
    ck("G3 the %d pinned scroll containers all exist AND declare overflow-x" % len(REQUIRED),
       not missing)
    for m in missing:
        sys.__stdout__.write("     " + m + "\n")

    # G4 DIFFERENTIAL — strip the overflow-x from .chat-scroll; both G1 and G3 MUST go red.
    defect = appcss.replace(
        ".chat-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }",
        ".chat-scroll { flex: 1; min-height: 0; overflow-y: auto; }", 1)
    ck("G4a DIFFERENTIAL: .chat-scroll without overflow-x is reported by the cross-axis scan",
       any(s == ".chat-scroll" for s, _ in offenders(defect)))
    ck("G4b DIFFERENTIAL: .chat-scroll without overflow-x fails the REQUIRED pin",
       ".chat-scroll" not in [s for s in REQUIRED if (lambda b: b and (X_ANY.search(b) or SHORT.search(b)))(find_block(defect, s))])

    # G5 — an EXEMPTED container (intentional single axis) must NOT be reported, and a genuinely
    # broken NEW vertical scroller (not in EXEMPTIONS) MUST be, so the gate is neither a no-op nor
    # so broad it would block the horizontal strips / tables it must not touch.
    for text, want, label in [
        (".st-tabs{overflow-x:auto}", 0, "horizontal strip is exempted, not scanned"),
        (".foo{overflow-y:auto}", 1, "a new vertical scroller with no cross axis IS caught"),
        (".bar{overflow-y:auto; overflow-x:hidden}", 0, "a properly pinned vertical scroller passes"),
        (".baz{overflow-y:auto; overflow:auto}", 0, "the overflow shorthand counts as cross-axis coverage"),
    ]:
        got = len(offenders(text))
        ck("G5 %s (expect %d)" % (label, want), got == want)

    print("CSS-SCROLL-X-LOCK: " + ("ALL GREEN" if not Fails else "RED -> " + ", ".join(Fails)))
    return 0 if not Fails else 1


if __name__ == "__main__":
    sys.exit(main())
