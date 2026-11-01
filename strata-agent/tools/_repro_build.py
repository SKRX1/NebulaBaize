# -*- coding: utf-8 -*-
# ONE-SHAPE-AT-A-TIME repro. Each shape gets its own page and its own browser call.
# Probe reports on THREE channels: console.log (authoritative), document.title, <pre id=probe-out>.
# Usage: python tools/_repro_build.py <shape>   (baseline|starsRun|starStorm|bigStars|hugePara|fenceNear|mixedHuge|incr)
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "serve", "web", "index.html")

SHAPES = {
    "baseline":  '("word ".repeat(200))',
    "starsRun":  '("*word* ".repeat(60000))',
    "starStorm": '("**a** *b* c".repeat(40000))',
    "bigStars":  '("* " + "x ".repeat(300) + "\\n").repeat(3000)',
    "hugePara":  '("word ".repeat(100000))',
    "fenceNear": '("```py\\n" + "code ".repeat(40000) + "\\n```\\n\\n").repeat(3)',
    "mixedHuge": '("para ".repeat(30000) + "\\n\\n|a|b|\\n|-|-|\\n|1|2|\\n\\n").repeat(8)',
    "incr":      '("word ".repeat(3000) + "\\n\\n* item".repeat(2000) + "\\n\\n```py\\n" + "q ".repeat(3000) + "\\n```")',
}

# The incr shape is exercised through the STREAMING hot path (frame-by-frame safeCut), not one shot.
STREAM_SHAPES = {"incr"}

shape = sys.argv[1] if len(sys.argv) > 1 else "baseline"
if shape not in SHAPES:
    print("unknown shape: " + shape)
    sys.exit(2)

src = open(SRC, encoding="utf-8").read()

if shape in STREAM_SHAPES:
    body = [
        '  var input = ' + SHAPES[shape] + ';',
        '  rec("shape=' + shape + ' len=" + input.length);',
        '  var thrown = 0, frames = 0, firstThrow = "";',
        '  try {',
        '    for(var n=200;n<=input.length;n+=200){',
        '      frames++;',
        '      var cut = safeCut(input.slice(0,n), Math.max(0, n-200));',
        '      markdown(input.slice(0,cut)); markdown(input.slice(cut));',
        '    }',
        '  } catch(e){ thrown = 1; firstThrow = (e&&e.message) + "::TOP[" + (String((e&&e.stack||"").split("\\n")[1]||"").trim()) + "]"; }',
        '  rec("frames=" + frames + " thrown=" + thrown + (thrown ? (" :: " + firstThrow) : ""));',
    ]
else:
    body = [
        '  var input = ' + SHAPES[shape] + ';',
        '  rec("shape=' + shape + ' len=" + input.length);',
        '  try { markdown(input); rec("RESULT::NO-THROW"); }',
        '  catch(e){ rec("RESULT::THROW::" + (e&&e.message) + "::TOP[" + (String((e&&e.stack||"").split("\\n")[1]||"").trim()) + "]"); }',
    ]

js = [
    '(function(){',
    '  function emit(s){ console.log("PROBE::" + s); }',
    '  var t0 = performance.now();',
    '  var LOG = [];',
    '  function rec(s){ LOG.push(s); emit(s); }',
    '  rec("TOPLEVEL markdown=" + (typeof markdown) + " t=" + (typeof t) + " safeCut=" + (typeof safeCut) + " HL_MAX_ok=" + (function(){try{return 1+HL_MAX}catch(e){return "TDZ"}})());',
] + body + [
    '  rec("ms=" + (performance.now()-t0).toFixed(1));',
    '  var pre = document.createElement("pre");',
    '  pre.id = "probe-out";',
    '  pre.textContent = LOG.join(" | ");',
    '  document.body.appendChild(pre);',
    '  document.title = LOG.join(" || ");',
    '})();',
]
probe = "<script>\n" + "\n".join(js) + "\n</script>\n"
out = src.rstrip()
idx = out.rfind("</body>")
assert idx > 0, "no </body> found"
out = out[:idx] + probe + out[idx:]
dest = os.path.join(ROOT, "serve", "_repro_" + shape + ".html")
open(dest, "w", encoding="utf-8").write(out)
print("built " + dest)
