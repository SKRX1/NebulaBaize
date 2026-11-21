#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_css_no_line_comments.py - CSS must never use `//` as a comment (the swallowed-rule bug).

Root cause, measured on the running 8099 build before the fix: app.css carried

    #bugbox-list .debug-item--bug { ... }   // perf: off-screen rows skip layout/paint

CSS has no line-comment syntax. The stray `//` token is parsed as part of the NEXT rule's
prelude, so the following selector was swallowed whole: getComputedStyle of
.debug-bug__verdict reported bg=rgba(0,0,0,0) pad=0px (the probe title read
VERDICT-UNSTYLED). After rewriting it as /* */ the same probe read pad=6px with the amber
background applied. One character in a trailing comment cost an element its entire style.

The rule this guard enforces, repo-wide: in any shipped CSS (serve/web/*.css) and in any
inline <style> block of an HTML page, `//` must not appear outside a /* */ comment body and
outside a URL scheme.

False positives were the whole difficulty, and each exemption is justified by a case that
exists in the real corpus, not by speculation:
  * url(https://x)  - 6 url() uses across app.css/tokens.css carry schemes;
  * url(//cdn/x)    - the protocol-relative form (preceded by `url(`, with optional quote);
  * a `//` inside a comment body - app.css:576 literally quotes the old bad form
    (`The comment used to be written "// ..."`), so a guard that scanned comment bodies
    would be red against the fix that introduced it. Comment bodies are BLANKED (not
    deleted), which keeps every reported line number exact.

The differential is built in: the same detector, fed the exact defect text from the commit
it locks, must report it. A guard that only proves "the tree is clean today" is decorative.
"""
import io
import os
import re
import sys

AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(AGENT, "serve", "web")
STYLE = re.compile(r"<style[^>]*>(.*?)</style>", re.I | re.S)
SKIP_DIRS = {"node_modules", "_site", ".git"}


def strip_comments(text):
    """Blank out each /* ... */ body, keeping newlines so line numbers survive exactly."""
    out, i, n = [], 0, len(text)
    while i < n:
        j = text.find("/*", i)
        if j < 0:
            out.append(text[i:])
            break
        out.append(text[i:j])
        k = text.find("*/", j + 2)
        body = text[j:k] if k >= 0 else text[j:]
        out.append("".join(ch if ch == "\n" else " " for ch in body))
        i = (k + 2) if k >= 0 else n
    return "".join(out)


def violations(text):
    """1-based line numbers where `//` is used as a comment (the defect shape)."""
    clean = strip_comments(text)
    hits = []
    for m in re.finditer(r"//", clean):
        head = clean[:m.start()]
        if head.endswith(":"):
            continue                              # https://, ftp:// -- a URL scheme
        if re.search(r"url\(\s*['\"]?$", head):
            continue                              # protocol-relative url(//cdn/x)
        hits.append(clean[:m.start()].count("\n") + 1)
    return hits


def read(path):
    return io.open(path, "rb").read().decode("utf-8", "replace")


def corpus():
    """(label, kind, text) for every shipped CSS file and every inline <style> block."""
    for dp, dn, fn in os.walk(WEB):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in sorted(fn):
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, AGENT).replace(os.sep, "/")
            if f.endswith(".css"):
                yield (rel, "css", read(p))
            elif f.endswith(".html"):
                t = read(p)
                for bi, blk in enumerate(STYLE.findall(t)):
                    pre = t[:t.find(blk)].count("\n")
                    yield ("%s#style%d" % (rel, bi), "style", (" " * 0) + ("\n" * 0) + blk
                           if pre == 0 else "\n" * pre + blk)


Fails = []


def ck(name, cond):
    sys.__stdout__.write(("PASS " if cond else "FAIL ") + name + "\n")
    sys.__stdout__.flush()
    if not cond:
        Fails.append(name)


def main():
    # 1) the real corpus is clean today (the guard's day-one green)
    found = []
    n_css = n_style = 0
    for label, kind, text in corpus():
        if kind == "css":
            n_css += 1
        else:
            n_style += 1
        for ln in violations(text):
            found.append("%s:%d" % (label, ln))
    ck("G1 the shipped CSS corpus carries no line comment (%d css + %d inline style blocks)"
       % (n_css, n_style), not found)
    for f in found:
        sys.__stdout__.write("     at " + f + "\n")
    ck("G2 the corpus is not empty (a scan that found zero files would pass G1 vacuously)",
       n_css >= 3 and n_style >= 1)

    # 3) THE DEFERENTIAL: the exact shape from the commit this guard locks must be caught.
    defect = ("#bugbox-list .debug-item--bug { content-visibility: auto; }"
              "   // perf: off-screen rows skip layout/paint\n"
              ".debug-bug__verdict { margin-top: 6px; padding: 6px 8px; }")
    hits = violations(defect)
    ck("G3 DIFFERENTIAL: the real defect text (app.css:575 as it shipped) is reported on line 1",
       hits == [1])
    ck("G4 the SAME text with the comment rewritten as /* */ is clean (the fix shape)",
       violations(defect.replace("   // perf: off-screen rows skip layout/paint",
                                 "   /* perf: off-screen rows skip layout/paint */")) == [])

    # 5) the exemptions, each one justified by a shape that exists in the corpus
    for text, want, label in [
        ("a{background:url(https://x/y.png)}", 0, "url(https://…): exists in app.css/tokens.css"),
        ("a{background:url(//cdn/x.png)}", 0, "protocol-relative url(//cdn/…)"),
        ("a{background:url( '//cdn/x.png' )}", 0, "protocol-relative inside a quoted url()"),
        ('/* the old form was written "// ..." */ .a{}', 0,
         "literal // inside a comment body (app.css:576 does exactly this)"),
        (".a{color:red}\n.b{color:blue} // oops\n.c{}", 1, "a defect on a LATER line, counted per line"),
    ]:
        got = len(violations(text))
        ck("G5 exemption shape: %s" % label, got == want)

    # 6) line numbers must survive comment blanking (a guard that mislocates is useless)
    numbered = ".a{}\n/* block\n   spanning lines */\n.b{} // bad\n"
    ck("G6 line numbers stay exact across a multi-line comment (expected 4, got %s)" %
       violations(numbered), violations(numbered) == [4])

    print("CSS-NO-LINE-COMMENTS: " + ("ALL GREEN" if not Fails else "RED -> " + ", ".join(Fails)))
    return 0 if not Fails else 1


if __name__ == "__main__":
    sys.exit(main())
