# -*- coding: utf-8 -*-
# PERMANENT GATE - lock the "auto-save workspace rules" per-store switch so it
# can never regress. Pure text-presence assertions (row-agnostic, edit-safe).
#   HARD1 default autoRulesMemory stays TRUE in app.js (the feature's whole point)
#   HARD2 autoWriteOn() routes rules->own switch, knowledge/experience->master autoMemory
#   HARD3 the decision core routes by store through autoWriteOn(store), not a flat check
#   HARD4 i18n key drawer.autorules present in BOTH dicts (en/zh parity)
# Differential proof for HARD2/HARD3: reverting the routing back to a flat
# settings.autoMemory check (the pre-feature code) makes the gate RED.
import io, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPP = os.path.join(ROOT, "serve", "web", "app.js")
I18N = os.path.join(ROOT, "serve", "web", "i18n.js")

def read(p):
    with io.open(p, "r", encoding="utf-8") as f:
        return f.read()

app  = read(APPP)
i18n = read(I18N)

h1 = "autoRulesMemory: true" in app
# helper must branch: rules -> autoRulesMemory, else -> autoMemory
h2 = ("store === \"rules\" ? (settings.autoRulesMemory !== false)" in app) and \
     ": !!settings.autoMemory" in app
# decision core must call the helper (NOT the flat pre-feature `if (settings.autoMemory)`)
h3 = "if (autoWriteOn(store))" in app
# i18n parity: the key appears in BOTH language dicts
h4 = (i18n.count('"drawer.autorules"') >= 2)

out = []
out.append("HARD1 default autoRulesMemory stays TRUE in app.js       : %s" % ("PASS" if h1 else "FAIL"))
out.append("HARD2 autoWriteOn routes rules->own switch, others->master: %s" % ("PASS" if h2 else "FAIL"))
out.append("HARD3 decision core routes by store via autoWriteOn(store) : %s" % ("PASS" if h3 else "FAIL"))
out.append("HARD4 drawer.autorules i18n key present in BOTH dicts      : %s (count=%d)" % ("PASS" if h4 else "FAIL", i18n.count('"drawer.autorules"')))
allok = h1 and h2 and h3 and h4
out.append("")
out.append("AUTORULES-GATE: " + ("ALL GREEN (default-on + per-store routing + i18n parity, all locked)"
                                 if allok else "*** RED ***"))
print("\n".join(out))
sys.exit(0 if allok else 1)
