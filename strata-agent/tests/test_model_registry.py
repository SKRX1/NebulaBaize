"""model_registry: the one list of models both server flavours share.

What must hold:
  - a first run with no file still yields a usable list (never an exception)
  - ids stay unique and stable; `selected` always points at a real entry
  - the browser NEVER receives an api_key (only `api_key_set`)
  - an edit that omits api_key keeps the stored one; "" clears it
  - the file is written atomically (a half-written models.json would break both modes)

Run standalone: python tests/test_model_registry.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "serve"))

import model_registry as mr  # noqa: E402

FAIL = []


def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (("  " + str(extra)) if extra else ""))
    if not cond:
        FAIL.append(label)


tmp = tempfile.mkdtemp(prefix="models-test-")
CFG = os.path.join(tmp, "models.json")
os.environ["STRATA_MODELS_CONFIG"] = CFG

print("\n=== T1: a first run with no file still works ===")
doc = mr.load()
check("a list came back", isinstance(doc.get("models"), list) and len(doc["models"]) >= 1)
check("selected points at a real entry", doc["selected"] in [m["id"] for m in doc["models"]])
check("the file was NOT created by a read", not os.path.exists(CFG))

print("\n=== T2: save / load round trip ===")
saved = mr.save({"selected": "b", "models": [
    {"id": "a", "name": "A", "kind": "local", "base_url": "", "model": "a"},
    {"id": "b", "name": "B", "kind": "custom", "base_url": "https://x.example/v1",
     "model": "gpt-4o", "api_key": "sk-secret", "tools": True, "ctx_in": 128000},
]})
check("the file exists", os.path.exists(CFG))
again = mr.load()
check("selected survived", again["selected"] == "b")
check("the key survived", any(m.get("api_key") == "sk-secret" for m in again["models"]))
check("numbers survived", [m for m in again["models"] if m["id"] == "b"][0].get("ctx_in") == 128000)
check("nothing half-written is left behind", not [f for f in os.listdir(tmp) if f.startswith(".models-")])

print("\n=== T3: ids are unique, selected is repaired ===")
doc = mr.normalize_doc({"selected": "nope", "models": [
    {"id": "same", "name": "one", "kind": "local", "base_url": "", "model": "m"},
    {"name": "same", "kind": "local", "base_url": "http://127.0.0.1:8081", "model": "m2"},
]})
ids = [m["id"] for m in doc["models"]]
check("duplicate ids were made unique  " + json.dumps(ids), len(set(ids)) == len(ids))
check("a bad `selected` fell back to an entry", doc["selected"] in ids, doc["selected"])

print("\n=== T4: the browser never sees a key ===")
pub = mr.public(again)
check("no api_key in the public view", all("api_key" not in m for m in pub["models"]))
check("but the page is told one exists", [m for m in pub["models"] if m["id"] == "b"][0]["api_key_set"] is True)
check("the local entry reports no key", [m for m in pub["models"] if m["id"] == "a"][0]["api_key_set"] is False)

print("\n=== T5: an edit keeps the stored key unless it says otherwise ===")
old = mr.find(again, "b")
kept = mr.merge(again, {"id": "b", "name": "B2", "kind": "custom", "base_url": "https://x.example/v1",
                        "model": "gpt-4o"})
check("omitting api_key keeps it", kept.get("api_key") == "sk-secret")
cleared = mr.merge(again, {"id": "b", "name": "B3", "kind": "custom", "base_url": "https://x.example/v1",
                           "model": "gpt-4o", "api_key": ""})
check("an empty api_key clears it", "api_key" not in cleared)

print("\n=== T6: bad input is rejected, not silently stored ===")
for bad, why in [({"kind": "custom"}, "a custom model without a base_url"),
                 ({"kind": "magic", "base_url": "https://x"}, "an unknown kind"),
                 ({"kind": "custom", "base_url": "ftp://x"}, "a non-http base_url")]:
    try:
        mr.normalize_entry(dict(bad))
        check("rejected: " + why, False)
    except ValueError:
        check("rejected: " + why, True)

print("\n=== T7: find() accepts the id and the upstream model name ===")
check("by id", mr.find(again, "b")["id"] == "b")
check("by the upstream model name", mr.find(again, "gpt-4o")["id"] == "b")
check("unknown -> None", mr.find(again, "nothing") is None)

print("\n=== T8: thinking levels are validated, unknown ones never stored ===")
e = mr.normalize_entry({"kind": "custom", "base_url": "https://x.example/v1", "model": "m",
                        "think_modes": ["low", "HIGH", "bogus"], "think_default": "high"})
check("known levels kept, unknown dropped  " + json.dumps(e.get("think_modes")),
      e.get("think_modes") == ["low", "high"])
check("the default survived", e.get("think_default") == "high")
e2 = mr.normalize_entry({"kind": "custom", "base_url": "https://x.example/v1", "model": "m",
                         "think_default": "extreme"})
check("an unknown default falls back to auto  " + json.dumps(e2.get("think_default")),
      e2.get("think_default") == "auto")

print("")
print("MODEL REGISTRY: " + (f"{len(FAIL)} FAILED" if FAIL else "ALL PASSED"))
sys.exit(1 if FAIL else 0)
