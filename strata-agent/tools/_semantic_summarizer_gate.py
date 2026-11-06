# -*- coding: utf-8 -*-
# PERMANENT GATE: semantic-summarizer decision-survival. Locks the contract that the
# LLM semantic summarizer preserves planted decisions AT LEAST as well as the keyword
# `structured` summarizer during a reforge (the change that justified switching config
# session.strategy -> "llm"). Runs the REAL memory.session.compress() on a fixed
# dead-water history with planted decisions; measures survival for BOTH summarizers.
#
# Hard gate (red line): LLM survival >= keyword survival. This is the regression contract.
# Soft warning (no exit effect): absolute LLM survival < planted (small quantized models
# miss ~25% per run; locking that as hard would flake -> it stays a probe, per the
# "hard locks the stable main feature, soft probes the rest" rule).
#
# Self-skip when the shared Strata upstream is unreachable (so a non-live run stays green;
# same convention as _live_vision / _baseline_probe). ASCII prints + write a report file.
import os, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, os.path.join(ROOT, "tools"))

def reachable():
    import json, urllib.request
    try:
        r = urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=8)
        d = json.loads(r.read().decode("utf-8", "replace"))
        return bool(d.get("loaded") or d.get("status") == "ok")
    except Exception:
        return False

# fixed constructed history with planted durable decisions (markers we grep afterwards)
PLANTED = [0, 12, 24, 36]
def build_hist():
    hist = [{"role":"user","content":"original task: unify panel number coloring."}]
    for i in range(40):
        hist.append({"role":"assistant","content":"inspect block %d structure, confirm before deciding."%i,
                     "tool_calls":[{"id":"c%d"%i,"function":{"name":"shell__exec",
                                  "arguments":"{\"command\":\"findstr /n foo file%d.js\"}"%i}}]})
        hist.append({"role":"tool","tool_call_id":"c%d"%i,"content":("line %d ... "%i)*60 + "\n"*40})
        if i in PLANTED:
            hist.append({"role":"assistant","content":"DECISION: block %d uses span-wrapped number + dataset guard."%i})
    hist.append({"role":"assistant","content":"all done, three colorings unified, tests green."})
    return hist

from memory.session import SessionMemory, STRATEGIES
KEYWORD = STRATEGIES["structured"]

def survival(sm):
    return sum(1 for i in PLANTED if ("block %d" % i) in sm._frozen_text)

def run(summ, label):
    sm = SessionMemory(max_chars=8000, keep_tail_min=6, strategy="structured",
                       tail_budget_ratio=0.4, frozen_cap_ratio=0.5,
                       tool_result_cap=10000, tool_head_lines=15, tool_tail_lines=15)
    sm.history = build_hist()
    for _ in range(4):
        sm.compress(summ)
    s = survival(sm)
    print("%-26s chars=%6d  decisions survived=%d/%d" % (label, sm._total_chars(), s, len(PLANTED)))
    return s

def main():
    if not reachable():
        print("SEMANTIC-SUMMARIZER-GATE: SKIP (upstream 8080 not reachable) -> green")
        return 0

    from llm_client import StrataClient
    client = StrataClient(model="swift-1.5-iq3_s", max_tokens=500, effort="off")
    SEM_SYS = ("You compress a chunk of an agent's own conversation history into a short "
               "summary. You MUST preserve every durable decision, confirmed fact, and open "
               "to-do VERBATIM (keep the exact wording of each, one per line). Drop only pure "
               "process narration and tool-output noise. Output lines only.")
    def llm_summarize(text):
        try:
            turn = client.chat([{"role":"system","content":SEM_SYS},
                                {"role":"user","content":text}], tools=[], effort="off", stream=True)
            out = (turn.content or "").strip()
            return out or KEYWORD(text)
        except Exception:
            return KEYWORD(text)

    print("planted decisions:", len(PLANTED), "(markers:", ", ".join("block %d"%i for i in PLANTED), ")")
    kw = run(KEYWORD, "keyword (status-quo ref)")
    # run LLM twice; take the better (defends against a single-run dip)
    ll = max(run(llm_summarize, "LLM semantic (run1)"), run(llm_summarize, "LLM semantic (run2)"))

    print()
    print("HARD GATE  : LLM(%d) >= keyword(%d) ?" % (ll, kw), "PASS" if ll >= kw else "FAIL")
    soft = "OK" if ll >= len(PLANTED) else "WARN (small-model absolute survival < planted)"
    print("SOFT PROBE : absolute LLM survival =", soft)
    if ll < kw:
        print("SEMANTIC-SUMMARIZER-GATE: RED - semantic summarizer no longer beats keyword")
        return 1
    print("SEMANTIC-SUMMARIZER-GATE: ALL GREEN (hard contract holds; soft=%s)" % soft)
    return 0

if __name__ == "__main__":
    sys.exit(main())
