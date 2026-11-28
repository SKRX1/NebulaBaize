#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_ce_input_overflow_lock.py - the shared contenteditable body (.ce-input) must be scrollable.

Root cause (statically proven 2026-11-28): the edit-modal input #edit-area carries
class="st-textarea ce-input" (app.js:8704) and the autosize() helper pins its inline height
to min(scrollHeight, innerHeight*0.4) (app.js:5575). Before this fix, the ONLY rule giving a
ce-input an overflow window was scoped `.st-composer .ce-input { max-height:40vh;
overflow-y:auto; overflow-x:hidden; }` -- which matches the composer (#input, wrapped in
.st-composer) but NOT #edit-area (the modal body sits in .st-modal__body, not .st-composer).
With its height clamped by autosize and content taller than the clamp, #edit-area's overflow was
`visible` (the default, painted OUTSIDE the box -- confirmed by the absence of any max-height /
overflow rule for .ce-input outside .st-composer): long edited text rendered below the card edge
and, being `visible` not `auto`, could not be scrolled. So "cannot view the full content after
editing" = text overflowed the pinned box and was unreachable.

Fix: add an UNscoped `.ce-input { max-height:40vh; overflow-y:auto; overflow-x:hidden; }`.
Its specificity (0,1,0) is lower than `.st-composer .ce-input` (0,2,0), so the composer keeps the
identical value via the higher-specificity rule (no behaviour change) while #edit-area -- and any
future .ce-input used outside .st-composer -- gets the same scrollable clamp.

Why a static gate: jsdom/sim do NOT compute CSS layout, so a real browser is the only way to see
the scrollbar. This guard keeps the FIX from being silently washed away by a refactor.

The rule: app.css MUST contain at least one rule whose selector list is exactly `.ce-input`
(NOT `.st-composer .ce-input`) and whose body sets BOTH an overflow-y:auto/scroll AND an
overflow-x (cross-axis pin, consistent with test_css_scroll_x_lock.py's invariant). The
DIFFERENTIAL strips that overflow-x and proves the lock flips red -> it is load-bearing.

Note we deliberately do NOT reuse test_css_scroll_x_lock.py's REQUIRED list for `.ce-input`:
its find_block() returns the FIRST exact-match block, and the plain `.ce-input` base block
(line ~1508, no overflow at all) precedes our new fallback block, so REQUIRED would bind to the
base block and go red. This gate instead checks "does SOME `.ce-input` block carry the scroll
window", which is the actual intent.
"""
import io
import os
import re
import sys

AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPCSS = os.path.join(AGENT, "serve", "web", "app.css")

RULE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.S)
Y_SCROLL = re.compile(r"\boverflow-y\s*:\s*(auto|scroll)\b", re.I)
X_ANY = re.compile(r"\boverflow-x\s*:", re.I)


def strip_comments(text):
    """Blank each /* ... */ body, keeping newlines so reported line numbers stay exact."""
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


def blocks(css_text):
    """Yield (selector_set_norm_tuple, body) for every rule, comments blanked."""
    clean = strip_comments(css_text)
    for m in RULE.finditer(clean):
        sels = tuple(" ".join(p.split()) for p in " ".join(m.group(1).split()).split(","))
        yield sels, m.group(2)


def has_ce_scroll_window(css_text):
    """True if SOME rule whose selector list contains exactly '.ce-input' (not a descendant of
    it like '.ce-input img' / not '.st-composer .ce-input') declares overflow-y:auto/scroll AND
    an overflow-x pin."""
    for sels, body in blocks(css_text):
        if ".ce-input" not in sels:
            continue  # exact selector only: '.ce-input img' / '.st-composer .ce-input' are skipped
        if Y_SCROLL.search(body) and X_ANY.search(body):
            return True
    return False


Fails = []


def ck(name, cond):
    sys.__stdout__.write(("PASS " if cond else "FAIL ") + name + "\n")
    sys.__stdout__.flush()
    if not cond:
        Fails.append(name)


def main():
    if not os.path.isfile(APPCSS):
        sys.__stdout__.write("FAIL app.css missing\n"); sys.__stdout__.flush()
        return 1
    raw = io.open(APPCSS, "rb").read().decode("utf-8", "replace")

    # C1 the shared .ce-input body is scrollable (the fix is present)
    ck("C1_ce_input_has_scroll_window", has_ce_scroll_window(raw))

    # C2 the composer-scoped rule still exists too (so the composer is unchanged, and its
    #    higher-specificity rule is what actually governs #input)
    composer_ok = any(
        ".st-composer .ce-input" in sels and Y_SCROLL.search(body) and X_ANY.search(body)
        for sels, body in blocks(raw)
    )
    ck("C2_st_composer_ce_input_still_pinned", composer_ok)

    # C3 DIFFERENTIAL: drop the overflow-x pin from every unscoped `.ce-input` block that carries
    #    the scroll window; the base gate C1 MUST flip red. Proves the pin (and this gate) is
    #    load-bearing, not a green-by-accident assertion.
    import re as _re
    mutated = raw
    # crude but surgical: strip overflow-x declarations from blocks whose selector is exactly
    # '.ce-input'. We rebuild block by block to only touch the intended one.
    def mutate_once(css):
        out = []
        i = 0
        for m in RULE.finditer(css):
            out.append(css[i:m.start()])
            sels = tuple(" ".join(p.split()) for p in " ".join(m.group(1).split()).split(","))
            head = css[m.start():m.start(2)]
            body = m.group(2)
            if ".ce-input" in sels and Y_SCROLL.search(body) and X_ANY.search(body):
                body = _re.sub(r"\boverflow-x\s*:[^;}]*;?", "", body, flags=_re.I)
            out.append(head + body + "}")
            i = m.end()
        out.append(css[i:])
        return "".join(out)

    mutated = mutate_once(raw)
    mutated_changed = (mutated != raw)
    ck("C3_mutation_actually_stripped_something", mutated_changed)
    ck("C3_differential_flip", (not has_ce_scroll_window(mutated)))
    # control: the UN-mutated CSS still passes (single-variable flip)
    ck("C3_control_original_passes", has_ce_scroll_window(raw))

    if Fails:
        sys.__stdout__.write("FAILED %d\n" % len(Fails)); sys.__stdout__.flush()
        return 1
    sys.__stdout__.write("ALL GREEN\n"); sys.__stdout__.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
