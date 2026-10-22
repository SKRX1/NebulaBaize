"""Offline test for the policy gate path (sandbox + approval) — no GPU, no model.

We mock the planner so it returns a scripted sequence of actions, and verify that:
  1. a sandbox-denied shell command is blocked BEFORE execution
  2. a require_approval tool triggers the confirm gate (and is executed on yes)
  3. a require_approval tool that the user declines is NOT executed

This closes the gap the executor smoke test leaves open (it never runs the loop gates).
Run from the strata-agent folder with the managed python:
    python tests/test_policy.py
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from loop import AgentLoop  # noqa: E402
from policy.approval import Approval  # noqa: E402
from policy.sandbox import Sandbox  # noqa: E402
from memory.session import SessionMemory  # noqa: E402


class FakeExecutor:
    """Stands in for a real MCP server; records which tools actually executed."""

    def __init__(self):
        self.executed = []

    @property
    def tools(self):
        return [{"name": "shell__exec", "description": "", "input_schema": {}},
                {"name": "fs__write", "description": "", "input_schema": {}}]

    def call(self, name, arguments):
        self.executed.append(name)
        return f"executed {name}"


class FakePlanner:
    """Returns scripted actions in order; tools are irrelevant (planner bypassed)."""

    def __init__(self, scripted):
        self._scripted = list(scripted)
        self.tools = []

    def plan(self, messages, effort=None):
        from planner import NextAction
        if not self._scripted:
            return NextAction(thinking="t", actions=[], final_answer="done")
        action = self._scripted.pop(0)
        return NextAction(thinking="t", actions=action, final_answer=None if action else "done")


def _action(tool, args):
    return [{"id": "c1", "name": tool, "arguments": args}]


def main() -> int:
    # --- Case 1: sandbox denies a destructive shell command -> not executed ---
    ex = FakeExecutor()
    loop = AgentLoop(client=None, executor=ex, max_rounds=2,
                     sandbox=Sandbox(os.path.join(ROOT, "config", "sandbox.yaml")),
                     confirm=lambda tool, reason: True)
    loop.planner = FakePlanner([_action("shell__exec", {"command": "rm -rf /tmp"})])
    loop.run("task", history=[])
    assert ex.executed == [], f"case1: expected no execution, got {ex.executed}"
    print("case1 OK: destructive command blocked before execution")

    # --- Case 2: approval required but user says YES -> executed ---
    ex = FakeExecutor()
    loop = AgentLoop(client=None, executor=ex, max_rounds=2,
                     approval=Approval(os.path.join(ROOT, "config", "approval.yaml")),
                     confirm=lambda tool, reason: True)
    loop.planner = FakePlanner([_action("filesystem__write", {"path": "a.txt", "content": "x"})])
    loop.run("task", history=[])
    assert ex.executed == ["filesystem__write"], f"case2: expected filesystem__write, got {ex.executed}"
    print("case2 OK: approved action executed (production namespace)")

    # --- Case 3: approval required, user declines -> NOT executed ---
    ex = FakeExecutor()
    loop = AgentLoop(client=None, executor=ex, max_rounds=2,
                     approval=Approval(os.path.join(ROOT, "config", "approval.yaml")),
                     confirm=lambda tool, reason: False)
    loop.planner = FakePlanner([_action("filesystem__write", {"path": "a.txt", "content": "x"})])
    loop.run("task", history=[])
    assert ex.executed == [], f"case3: expected no execution, got {ex.executed}"
    print("case3 OK: declined action skipped")

    # --- Case 4: session memory seeds + records the full tool structure ---
    ex = FakeExecutor()
    sess = SessionMemory(max_chars=8000)
    loop = AgentLoop(client=None, executor=ex, max_rounds=2, session=sess,
                     confirm=lambda tool, reason: True)
    # planner returns no actions -> loop ends with a final answer, but we still
    # check the session captured the user turn (and would capture tool_calls structure).
    loop.planner = FakePlanner([[]])
    loop.run("remember this", history=[])
    assert any("remember this" in (m.get("content") or "") for m in sess.as_messages()), \
        "case4: session did not capture the user turn"
    print("case4 OK: session memory captures messages")

    # --- Case 5: automatic compression triggers when the window is over budget ---
    ex = FakeExecutor()
    sess = SessionMemory(max_chars=120)  # small budget so folding fires
    # seed enough history that there is a "middle" to fold (head + tail6 + mid)
    seed = [{"role": "user", "content": "x" * 40} for _ in range(10)]
    events = []
    loop = AgentLoop(client=None, executor=ex, max_rounds=1, session=sess,
                     confirm=lambda tool, reason: True,
                     summarize=lambda t: "SUMMARY", on_event=events.append)
    # recording planner: captures the message list it actually received each call
    class RecordingPlanner:
        tools = []
        def __init__(self): self.seen = []
        def plan(self, messages, effort=None):
            self.seen.append(list(messages))
            from planner import NextAction
            return NextAction(thinking="t", actions=[], final_answer="done")
    rp = RecordingPlanner()
    loop.planner = rp
    loop.run("please remember this", history=seed)
    # planner must have received a COMPRESSED (shorter) list, with a summary note
    seen = rp.seen[0]
    assert len(seen) < len(seed) + 1, f"case5: planner saw {len(seen)} (not compressed)"
    assert any("SUMMARY" in (m.get("content") or "") for m in seen), \
        "case5: no summary note in compressed window"
    assert any(e.get("type") == "compress" for e in events), "case5: compress event not fired"
    print("case5 OK: automatic compression fired before planning")

    # --- Case 6: the frozen (accumulated) summary is BOUNDED, and facts are preserved ---
    # The old design was append-only and let the accumulated summary grow without limit; the
    # new design re-folds the frozen note once it exceeds frozen_cap_ratio*max_chars, so it
    # stays bounded. Previously-frozen facts must still survive the re-fold (not lost).
    from memory.session import SessionMemory as SM
    s = SM(max_chars=200, keep_tail_min=2, strategy="structured")
    s.append("user", "fact A keep this " + ("a" * 30))
    s.append("assistant", "decision: choose X " + ("b" * 25))
    s.append("user", "fact B keep this " + ("c" * 30))
    s.append("assistant", "decision: choose Y " + ("d" * 25))
    s.append("user", "tail1 keep this " + ("e" * 25))
    s.append("user", "tail2 keep this " + ("f" * 25))
    s.compress()
    for i in range(10):
        s.append("assistant", f"new decision z{i}: pick thing {i} " + ("g" * 25))
    # keep folding; without the re-fold guard the frozen note would blow past the cap
    for _ in range(8):
        s.compress()
    note = next((m for m in s.as_messages() if m.get("_frozen_note")), None)
    assert note is not None, "case6: no frozen note after repeated folds"
    # bounded: the frozen note cannot grow past its cap by more than one extra chunk
    assert len(note["content"]) <= int(200 * s.frozen_cap_ratio) + 1500, len(note["content"])
    # preserved: round-1 decisions still survive in the (re-folded) summary
    assert "choose X" in note["content"], "case6: frozen facts lost during re-fold"
    print("case6 OK: frozen note re-folds at cap (bounded, facts preserved)")

    # --- Case 7: persistent system prompt is prepended at the planner's view head ---
    ex = FakeExecutor()
    loop = AgentLoop(client=None, executor=ex, max_rounds=1,
                     confirm=lambda tool, reason: True,
                     system_prompt="AGENT PERSONA")
    seen = []

    class RP2:
        tools = []
        def plan(self, messages, effort=None):
            seen.append(list(messages))
            from planner import NextAction
            return NextAction(thinking="t", actions=[], final_answer="done")
    loop.planner = RP2()
    loop.run("hi", history=[])
    assert seen and seen[0][0].get("role") == "system" and "AGENT PERSONA" in seen[0][0]["content"], \
        f"case7: planner view head not system: {seen[0][0] if seen else None}"
    print("case7 OK: system prompt injected at view head")

    # --- Case 8: auto-distill at task end => episodic captures a learning, recallable ---
    import tempfile
    from memory.episodic import EpisodicMemory
    tmp = os.path.join(tempfile.mkdtemp(), "episodic.jsonl")
    epi = EpisodicMemory(tmp)
    ex = FakeExecutor()
    loop = AgentLoop(client=None, executor=ex, max_rounds=1,
                     confirm=lambda tool, reason: True,
                     episodic=epi)

    class RP3:
        tools = []
        def plan(self, messages, effort=None):
            from planner import NextAction
            return NextAction(thinking="t", actions=[], final_answer="the answer")
    loop.planner = RP3()
    loop.run("do the thing", history=[])
    # a distill record must have been written to disk (episodic log)
    recs = epi.recent(20)
    assert any("do the thing" in r.get("event", "") and "the answer" in r.get("event", "")
               for r in recs), f"case8: no auto-distill record: {recs}"
    # cross-session recall: re-open the same file (simulates a NEW process) and search
    epi2 = EpisodicMemory(tmp)
    hits = epi2.search("do the thing")
    assert hits, "case8: cross-session recall returned nothing"
    print(f"case8 OK: auto-distill wrote + cross-session recall works ({len(recs)} record(s))")

    # default system prompt must carry the memory discipline
    from loop import DEFAULT_SYSTEM_PROMPT as DSP
    assert "MEMORY DISCIPLINE" in DSP and "recall" in DSP, "case8: default prompt lacks memory discipline"
    print("case8 OK: default system prompt carries memory discipline")

    # --- Case 25 (prompt contract): default prompt must NAME the corpus-loop verbs ---
    # The corpus layer (ingest/sources/forget) is MCP-visible, but without a discipline line
    # the model is only steered toward recall/remember/store — a feature present in tests yet
    # not surfaced to the model in production (the same class of gap as G1/G3). Lock it.
    for verb in ("KNOWLEDGE BASE", "ingest", "sources", "forget"):
        assert verb in DSP, f"case25: default prompt missing corpus-loop verb: {verb}"
    assert "transcribed" in DSP.lower(), "case25: prompt should mention media transcribe-first"
    print("case25 OK: default prompt names the corpus loop (ingest/sources/forget + transcribe-first)")

    # --- Case 9: automated self-test gate — red feeds failure back, model retries, green ends ---
    from verifier import Verifier
    # check_fn fails on the 1st call (task "not done"), passes on the 2nd (bug fixed).
    calls = {"n": 0}
    def check_fn():
        calls["n"] += 1
        if calls["n"] == 1:
            return False, "AssertionError: case9 intentional failure"
        return True, "all good"
    ex = FakeExecutor()
    events = []
    loop = AgentLoop(client=None, executor=ex, max_rounds=5,
                     confirm=lambda tool, reason: True,
                     verifier=Verifier(check_fn=check_fn), max_verify_retries=2,
                     on_event=events.append)
    # scripted planner: says "done" every round (so the gate fires each round)
    loop.planner = FakePlanner([[], [], []])
    loop.run("build something", history=[])
    verify_events = [e for e in events if e.get("type") == "verify"]
    assert len(verify_events) >= 1, "case9: self-verify never ran"
    assert verify_events[0]["passed"] is False, "case9: first verify should be red"
    assert any(e.get("passed") is True for e in verify_events), "case9: green verify never happened"
    # the red failure must have been fed back into history as a user message (feedback),
    # and the loop must have continued to get the green
    assert calls["n"] >= 2, f"case9: checker called {calls['n']}x (expected >=2: red then green)"
    print(f"case9 OK: self-test gate ran red->{calls['n']}->green (closed loop verified)")

    # --- Case 10: pure-stdlib scheduler — interval / daily / one-shot (offline, injected clock) ---
    from scheduler import Scheduler, ScheduleEntry
    import time as _time
    fired = []
    def run_task(name, task):
        fired.append((name, task))
    # fake clock starts at real now so initial next_fire values are computed from "now"
    tbox = {"t": _time.time()}
    clock = lambda: tbox["t"]
    # two entries: an interval job (fires at now+10min) and a one-shot (2030)
    e_interval = ScheduleEntry("jobA", "task-a", every_minutes=10, clock=clock)
    e_oneshot = ScheduleEntry("jobB", "task-b", at="2030-01-01T00:00", clock=clock)
    sched = Scheduler([e_interval, e_oneshot], run_task, clock=clock, sleep=lambda s: None)
    # jump the clock far past both fire times => both become due
    tbox["t"] = _time.time() + 10**9
    got = sched.due(tbox["t"])
    assert set(got) == {"jobA", "jobB"}, f"case10: expected both to fire, got {got}"
    assert set(n for n, _ in fired) == {"jobA", "jobB"}, f"case10: run_task not invoked for both: {fired}"
    # after firing: interval entry must RESCHEDULE (survive); one-shot must be CONSUMED (dead)
    names_after = {e.name for e in sched.entries}
    assert "jobA" in names_after, "case10: recurring interval entry vanished after firing"
    assert "jobB" not in names_after, "case10: one-shot entry was not consumed after firing"
    # interval reschedules to exactly one interval ahead of the (jumped) now
    a = next(e for e in sched.entries if e.name == "jobA")
    assert a.next_fire == tbox["t"] + 600, f"case10: interval next_fire wrong: {a.next_fire}"
    # daily_at parses and computes a next_fire
    d = ScheduleEntry("jobC", "task-c", daily_at="09:00", clock=clock)
    assert d.next_fire is not None, "case10: daily_at entry has no next_fire"
    print("case10 OK: pure-stdlib scheduler fires interval+oneshot, reschedules, consumes one-shot")

    # --- Case 11: LLM resilience — retry + exponential backoff on transient failures ---
    import urllib.request as _ur, urllib.error as _ue
    import llm_client as _lc
    import json as _json
    calls = {"n": 0}
    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] < 3:
            raise _ue.URLError("transient")          # two transient blips
        class FakeResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self):
                return _json.dumps({"choices": [{"message": {"content": "recovered"}}]}).encode()
        return FakeResp()
    orig_urlopen = _ur.urlopen
    _ur.urlopen = fake_urlopen
    try:
        retries = []
        c = _lc.StrataClient()
        c._sleep = lambda s: None                     # no real sleeping in the test
        c.on_retry = lambda ev: retries.append(ev)
        turn = c.chat([{"role": "user", "content": "x"}], stream=False)
        assert turn.content == "recovered", f"case11: not recovered: {turn.content!r}"
        assert calls["n"] == 3, f"case11: expected 3 attempts (2 fail + 1 ok), got {calls['n']}"
        assert len(retries) == 2, f"case11: expected 2 retry events, got {len(retries)}"
        assert retries[0]["wait"] < retries[1]["wait"], "case11: backoff must grow (exponential)"
    finally:
        _ur.urlopen = orig_urlopen
    print("case11 OK: transient failure retried with exponential backoff, then recovered")

    # --- Case 12: audit log + cost/timing meter ---
    import tempfile as _tf, os as _os
    from audit import AuditLog
    apath = _os.path.join(_tf.mkdtemp(), "audit.jsonl")
    tb = {"t": 0.0}
    al = AuditLog(apath, clock=lambda: tb["t"])
    al.note_llm({"prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140})
    al.note_llm({"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60}, retried=True)
    al.note_round(); al.note_round(); al.note_tool(); al.note_tool(); al.note_tool()
    tb["t"] = 12.5
    al.event("plan", rnd=1, duration_ms=230.0, extra={"actions": 1, "final": False})
    al.event("tool", rnd=1, tool="fs__write", result="ok", duration_ms=12.0)
    al.summary("the task")
    recs = al.read()
    m = al.meter
    assert m["llm_calls"] == 2 and m["llm_retries"] == 1, f"case12: meter llm wrong: {m}"
    assert m["rounds"] == 2, f"case12: rounds wrong: {m['rounds']}"
    assert m["tool_calls"] == 3, f"case12: tool_calls wrong: {m['tool_calls']}"
    assert m["total_tokens"] == 200, f"case12: tokens wrong: {m['total_tokens']}"
    assert m["prompt_tokens"] == 150 and m["completion_tokens"] == 50, f"case12: token split wrong: {m}"
    # JSONL persisted with the right shape + a final summary record carrying the meter
    assert recs and recs[-1]["type"] == "summary", "case12: no summary record persisted"
    assert recs[-1]["meter"]["total_tokens"] == 200, "case12: persisted meter wrong"
    dur = [r for r in recs if r.get("duration_ms") is not None]
    assert len(dur) == 2 and any(r["type"] == "tool" and r["tool"] == "fs__write" for r in dur), \
        "case12: timing events not recorded"
    print("case12 OK: audit JSONL + cost/timing meter (tokens, rounds, retries, durations)")

    # --- Case 13: scheduler production hardening — one-shot persistence across restart,
    #     misfire coalescing, exception isolation ---
    import tempfile as _tf2, os as _os2
    state = _os2.path.join(_tf2.mkdtemp(), "sched_state.json")
    fired13 = []
    tb13 = {"t": _time.time()}
    clk13 = lambda: tb13["t"]
    # (a) one-shot persistence across a simulated daemon restart via a shared state file
    s1 = Scheduler([ScheduleEntry("once13", "task-once13", at="2030-01-01T00:00", clock=clk13)],
                   lambda n, t: fired13.append(n), clock=clk13, sleep=lambda s: None,
                   state_path=state)
    tb13["t"] = _time.time() + 10**9   # jump so the one-shot is due
    got_a = s1.due(tb13["t"])
    assert got_a == ["once13"], f"case13a: one-shot did not fire: {got_a}"
    # "restart": a NEW scheduler reading the same state file must NOT re-fire the consumed one-shot
    s2 = Scheduler([ScheduleEntry("once13", "task-once13", at="2030-01-01T00:00", clock=clk13)],
                   lambda n, t: fired13.append("RESTART-" + n), clock=clk13, sleep=lambda s: None,
                   state_path=state)
    assert s2.entries == [], "case13a: consumed one-shot survived restart (should be dropped)"
    assert s2.due(tb13["t"]) == [], "case13a: consumed one-shot re-fired after restart"
    # (b) misfire coalescing: an interval entry late by many intervals fires ONCE, not per-tick
    missed = []
    tb13["t"] = _time.time()   # reset to "now" so first next_fire is now+600s
    s3 = Scheduler([ScheduleEntry("every13", "task-every", every_minutes=10, clock=clk13)],
                   lambda n, t: missed.append(n), clock=clk13, sleep=lambda s: None)
    tb13["t"] = _time.time() + 10**9   # jump far past => late by ~1.6M intervals
    fired_b = s3.due(tb13["t"])
    assert fired_b == ["every13"], f"case13b: misfire should fire once, got {fired_b}"
    assert len(missed) == 1, f"case13b: misfire ran {len(missed)}x (expected 1, coalesced)"
    assert s3.entries and s3.entries[0].next_fire > tb13["t"], "case13b: not rescheduled to a future boundary"
    # (c) exception isolation: a raising task does not stop scheduling
    seen = {"n": 0}
    def boom(name, task):
        seen["n"] += 1
        if name == "bad":
            raise RuntimeError("task exploded")
    tb13["t"] = _time.time()
    s4 = Scheduler([ScheduleEntry("bad", "x", at="2030-01-01T00:00", clock=clk13)],
                   boom, clock=clk13, sleep=lambda s: None)
    tb13["t"] = _time.time() + 10**9
    fired_c = s4.due(tb13["t"])   # must not raise through due()
    assert fired_c == ["bad"] and seen["n"] == 1, f"case13c: isolation failed: {fired_c}, {seen}"
    print("case13 OK: scheduler one-shot persists across restart + misfire coalesced + task error isolated")

    # --- Case 14: long-task checkpoint — live history persisted to disk, resume from it ---
    import tempfile as _tf3, os as _os3
    from checkpoint import CheckpointStore
    cpath = _os3.path.join(_tf3.mkdtemp(), "checkpoint.json")
    store = CheckpointStore(cpath)
    ex14 = FakeExecutor()
    loop14 = AgentLoop(client=None, executor=ex14, max_rounds=3,
                       checkpoint=store)
    loop14.planner = FakePlanner([_action("fs__write", {"path": "a.txt", "content": "x"})])
    hist14 = loop14.run("long task that must checkpoint")
    # the checkpoint file must exist and reflect the live history (user + tool turns + final)
    assert store.exists(), "case14: checkpoint file not written"
    loaded = store.load()
    assert len(loaded) == len(hist14), f"case14: checkpoint {len(loaded)} != live {len(hist14)}"
    assert loaded[0]["content"] == "long task that must checkpoint", "case14: intent not in checkpoint"
    assert any("a.txt" in (m.get("content") or "") or m.get("tool_calls") for m in loaded), \
        "case14: tool turn not captured in checkpoint"
    # simulate a RESTART: a fresh store reading the same file, resume seeds from it
    store2 = CheckpointStore(cpath)
    resumed = store2.load()
    assert len(resumed) == len(hist14), "case14: resume load mismatch"
    ex14b = FakeExecutor()
    loop14b = AgentLoop(client=None, executor=ex14b, max_rounds=3, checkpoint=store2)
    loop14b.planner = FakePlanner([])            # would answer "done" immediately
    new_hist = loop14b.run("continue from checkpoint", history=resumed)
    # the resumed run must carry the prior messages in its history (it didn't start blank)
    assert any(m.get("content") == "long task that must checkpoint" for m in new_hist), \
        "case14: resumed history did not include the checkpointed prior turns"
    print("case14 OK: long-task checkpoint persisted to disk and resumed on restart")

    # --- Case 15: pluggable vector search — pure-stdlib cosine path is genuinely runnable ---
    import tempfile as _tf4, os as _os4
    from memory.semantic import SemanticMemory, hash_vectorizer, cosine
    vdb = _os4.path.join(_tf4.mkdtemp(), "sem.db")
    sm = SemanticMemory(vdb, search_mode="vector")   # default embed_fn = hash_vectorizer
    sm.add("choose sqlite as the vector backend")
    sm.add("decide to freeze partitions for cache")
    sm.add("the relational backend is postgres")
    # default embedding is stored (hash_vectorizer), so the vector path is active
    assert all(r[0] is not None for r in sm.conn.execute("SELECT embedding FROM items").fetchall()), \
        "case15: embeddings not stored by default vectorizer"
    vr = sm.search("vector backend sqlite", top_k=3)
    assert vr, "case15: vector search returned nothing"
    # cosine is the ranking metric; scores must be in [0,1] and sorted desc
    scores = [x["score"] for x in vr]
    assert all(0.0 <= s <= 1.0 for s in scores), f"case15: cosine out of range: {scores}"
    assert scores == sorted(scores, reverse=True), f"case15: not sorted by cosine desc: {scores}"
    # the semantically closest doc (shares 'vector'+'sqlite'+'backend') should rank first
    assert "sqlite" in vr[0]["text"], f"case15: top vector hit not the closest doc: {vr[0]}"
    # determinism: same query -> same top hit
    assert sm.search("vector backend sqlite", top_k=1)[0]["id"] == vr[0]["id"], "case15: not deterministic"
    # a pluggable custom embed_fn supersedes the default (no code change in search)
    vdb2 = _os4.path.join(_tf4.mkdtemp(), "sem2.db")
    sm2 = SemanticMemory(vdb2, embed_fn=lambda t: [float(len(t)), float(t.count("a"))],
                         search_mode="vector")
    sm2.add("aaa")
    sm2.add("a longer string with more characters")
    r2 = sm2.search("aaa")   # query 'aaa' -> vector [3,3]; 'aaa' doc -> [3,3] => cosine 1.0
    assert r2 and abs(r2[0]["score"] - 1.0) < 1e-9 and "aaa" in r2[0]["text"], \
        f"case15: custom embed_fn path wrong: {r2}"
    # FTS default still works unchanged when search_mode is default ('auto'/no vector)
    assert sm._fts_search("sqlite backend", 3), "case15: FTS fallback broke"
    print("case15 OK: pluggable vector search (pure-stdlib cosine) + custom embed_fn + FTS default intact")

    # --- Case 16 (G1 strengthened): the approval gate fires on the PRODUCTION namespace ---
    ex = FakeExecutor()
    confirm_calls = []
    loop = AgentLoop(client=None, executor=ex, max_rounds=2,
                     approval=Approval(os.path.join(ROOT, "config", "approval.yaml")),
                     confirm=lambda tool, reason: (confirm_calls.append(tool), True)[1])
    loop.planner = FakePlanner([_action("filesystem__write", {"path": "a.txt", "content": "x"})])
    loop.run("task", history=[])
    assert "filesystem__write" in confirm_calls, \
        f"case16: production namespace did not fire the approval gate: {confirm_calls}"
    # an auto_approve tool must NOT trigger the confirm gate
    ex2 = FakeExecutor()
    confirm_calls2 = []
    loop = AgentLoop(client=None, executor=ex2, max_rounds=2,
                     approval=Approval(os.path.join(ROOT, "config", "approval.yaml")),
                     confirm=lambda tool, reason: (confirm_calls2.append(tool), True)[1])
    loop.planner = FakePlanner([_action("memory__recall", {"query": "x"})])
    loop.run("task", history=[])
    assert confirm_calls2 == [], f"case16: auto_approve tool wrongly forced confirm: {confirm_calls2}"
    print("case16 OK: approval gate fires on production namespace (filesystem__write), not on auto_approve")

    # --- Case 17 (G2): proactive memory injection (RAG) — not model-voluntary ---
    import tempfile as _tf17, os as _os17
    from memory.episodic import EpisodicMemory as EM17
    from memory.semantic import SemanticMemory as SM17
    ep17 = EM17(_os17.path.join(_tf17.mkdtemp(), "episodic.jsonl"))
    sm17 = SM17(_os17.path.join(_tf17.mkdtemp(), "semantic.db"))
    ep17.log("decision: use edge headless for html rendering")
    sm17.add("we decided to keep the cache prefix stable")
    ex17 = FakeExecutor()
    ev17 = []
    loop = AgentLoop(client=None, executor=ex17, max_rounds=1,
                     confirm=lambda tool, reason: True,
                     episodic=ep17, semantic=sm17, on_event=ev17.append)
    loop.planner = RecordingPlanner()
    loop.run("html rendering decision cache stable", history=[])
    ar = [e for e in ev17 if e.get("type") == "auto-recall"]
    assert ar, "case17: proactive auto-recall never fired"
    assert any("[memory recall" in (m.get("content") or "") for m in loop._live) or \
           any("[memory recall" in (m.get("content") or "") for m in getattr(loop, "_live", [])), \
           "case17: injected recall message not in history"
    print(f"case17 OK: proactive RAG injection fired ({ar[0]['count']} memories)")

    # --- Case 18 (G3): skill permissions gate — a verb outside the grant forces approval ---
    import tempfile as _tf18, os as _os18
    from skills_loader import load_skills_meta as LSM18, is_within_permissions as IWP18, matches_trigger as MT18
    sd18 = _tf18.mkdtemp()
    with open(_os18.path.join(sd18, "pdf.yaml"), "w", encoding="utf-8") as f:
        f.write("name: pdf-tools\n"
                "tools:\n  - mcp: pdf-server\n    command: python\n"
                "    args: [\"server.py\"]\n"
                "permissions:\n  filesystem: [\"read\"]\n"
                "triggers:\n  - \"pdf\"\n")
    meta18 = LSM18(sd18)
    assert "pdf-server" in meta18, f"case18: skill meta not loaded: {list(meta18)}"
    assert IWP18(meta18["pdf-server"], "read") is True, "case18: granted verb must pass"
    assert IWP18(meta18["pdf-server"], "write") is False, "case18: non-granted verb must force approval"
    assert MT18(meta18["pdf-server"], "convert this pdf now") is True, "case18: trigger keyword miss"
    assert MT18(meta18["pdf-server"], "nothing relevant") is False, "case18: false trigger match"
    print("case18 OK: skill permissions enforced (read grant passes, write forces approval) + triggers match")

    # --- Case 19 (G3): skill-trigger surfacing fires a skill-surface event ---
    ev19 = []
    ex19 = FakeExecutor()
    loop = AgentLoop(client=None, executor=ex19, max_rounds=1,
                     confirm=lambda tool, reason: True,
                     skill_meta={"pdf-server": {"name": "pdf-tools",
                                               "permissions": {}, "triggers": ["pdf"]}},
                     on_event=ev19.append)
    loop.planner = RecordingPlanner()
    loop.run("please convert this pdf", history=[])
    assert any(e.get("type") == "skill-surface" for e in ev19), \
        f"case19: no skill-surface event: {ev19}"
    print("case19 OK: skill trigger surfaced the matching skill (surfacing only)")

    # --- Case 20 (G4): rounds exhausted => finalize event + distill/audit, not silent return ---
    import tempfile as _tf20, os as _os20
    from audit import AuditLog as AL20
    class NeverDonePlanner:
        tools = []
        def plan(self, messages, effort=None):
            from planner import NextAction
            # always emit an action (a benign executor call), never a final answer
            return NextAction(thinking="keep going",
                              actions=[{"id": "c", "name": "fs__read", "arguments": {"path": "x"}}],
                              final_answer=None)
    al20 = AL20(_os20.path.join(_tf20.mkdtemp(), "audit.jsonl"))
    ev20 = []
    ex20 = FakeExecutor()
    loop = AgentLoop(client=None, executor=ex20, max_rounds=3,
                     confirm=lambda tool, reason: True,
                     audit=al20, on_event=ev20.append)
    loop.planner = NeverDonePlanner()
    loop.run("a long task that never finishes", history=[])
    assert any(e.get("type") == "round-exhausted" for e in ev20), \
        f"case20: round-exhausted finalization missing: {ev20}"
    assert any(r.get("type") == "summary" for r in al20.read()), \
        "case20: audit summary not written on exhaustion"
    print("case20 OK: rounds exhausted -> finalize event + audit summary (no silent return)")

    # --- Case 21 (G5): MCP server death detected fast (no 60s timeout) ---
    import subprocess as _sp21, time as _t21
    from executor import StdioServer as SS21, ToolError as TE21
    srv21 = SS21("dead", "python")
    # a process that exits immediately, so poll() reports death
    p = _sp21.Popen(["python", "-c", "pass"], stdout=_sp21.PIPE, stderr=_sp21.DEVNULL)
    p.wait()
    srv21._proc = p
    srv21._reader = None
    t0 = _t21.monotonic()
    try:
        res = srv21.call("anything", {})
        # executor.call wraps ToolError into "error: ..." so this is expected on the death path
        assert "server process" in res or "dead" in res.lower(), f"case21: unexpected: {res}"
    except TE21 as e:
        assert "server process" in str(e), f"case21: wrong error: {e}"
    dt = _t21.monotonic() - t0
    assert dt < 5.0, f"case21: death detection took {dt}s (should be fast, not a full timeout)"
    print(f"case21 OK: dead server detected fast ({dt*1000:.0f} ms, no 60s wait)")

    # --- Case 22 (G6): session.max_chars is honored (not silently the default) ---
    from memory.session import SessionMemory as SM22
    small = SM22(max_chars=50, keep_tail_min=2)
    assert small.max_chars == 50, "case22: max_chars not honored from constructor"
    # seed head + a foldable middle + tail so folding actually reduces the message count
    small.append("user", "a" * 40)
    small.append("assistant", "decision: pick X " + "b" * 40)
    small.append("user", "fact " + "c" * 40)
    small.append("assistant", "fact " + "d" * 40)
    small.append("user", "fact " + "e" * 40)
    small.append("assistant", "fact " + "f" * 40)
    out22 = small.compress()
    assert any(m.get("_frozen_note") for m in out22), "case22: tiny budget did not fold"
    assert len(out22) < 6, f"case22: fold did not reduce message count: {len(out22)}"
    # and a default-8000 session does NOT fold the same 6 messages
    normal = SM22()
    for ch in ("a", "b", "c", "d", "e", "f"):
        normal.append("user", ch * 40)
    assert len(normal.compress()) == 6, "case22: default budget folded when it should not"
    print("case22 OK: session.max_chars honored (tiny budget folds, default does not)")

    # --- Case 23 (H1): DEFAULT rules fire on the PRODUCTION namespace, not the stale alias ---
    # The old default carried the alias "fs__write", which matched nothing the executor
    # actually derives, so the gate was dead unless config happened to override it. The fix
    # puts the real name in DEFAULT_RULES. Test the CODE-DEFAULT path (no config file).
    d23 = Approval(None)
    assert d23.needs_approval("filesystem__write") is True, "case23: default must gate production name"
    assert d23.needs_approval("fs__write") is False, "case23: stale alias must no longer be a gate"
    # and it must gate through the loop end to end on the default policy (no config file)
    ex23 = FakeExecutor()
    confirm23 = []
    loop23 = AgentLoop(client=None, executor=ex23, max_rounds=2,
                       approval=Approval(None),
                       confirm=lambda tool, reason: (confirm23.append(tool), True)[1])
    loop23.planner = FakePlanner([_action("filesystem__write", {"path": "a.txt", "content": "x"})])
    loop23.run("task", history=[])
    assert confirm23 == ["filesystem__write"], f"case23: default namespace gate did not fire: {confirm23}"
    print("case23 OK: DEFAULT approval rules fire on production namespace (no alias, no config needed)")

    # --- Case 24 (H2): the destructive delete (memory__forget) is gated ---
    # "I can decide which to delete" is the user's original ask; deleting learned memory /
    # a whole corpus source must not run silently. It is now on the require-approval list.
    c24 = Approval(os.path.join(ROOT, "config", "approval.yaml"))
    assert c24.needs_approval("memory__forget") is True, "case24: memory__forget must require approval"
    assert c24.needs_approval("memory__recall") is False, "case24: read-only recall must stay auto"
    ex24 = FakeExecutor()
    confirm24 = []
    loop24 = AgentLoop(client=None, executor=ex24, max_rounds=2,
                       approval=c24,
                       confirm=lambda tool, reason: (confirm24.append(tool), True)[1])
    loop24.planner = FakePlanner([_action("memory__forget", {"source": "old-notes.pdf"})])
    loop24.run("drop the learning source", history=[])
    assert confirm24 == ["memory__forget"], f"case24: delete gate did not fire: {confirm24}"
    assert ex24.executed == ["memory__forget"], "case24: approved delete should execute"
    # and a declined delete must NOT execute
    ex24b = FakeExecutor()
    loop24b = AgentLoop(client=None, executor=ex24b, max_rounds=2,
                        approval=c24, confirm=lambda tool, reason: False)
    loop24b.planner = FakePlanner([_action("memory__forget", {"source": "keep-me.md"})])
    loop24b.run("drop it", history=[])
    assert ex24b.executed == [], f"case24: declined delete must not run: {ex24b.executed}"
    print("case24 OK: destructive delete (memory__forget) gated; approved runs, declined skips")

    # --- Case 26 (policy): network lookup is auto-approved (no nagging), write stays gated ---
    # User chose: websearch should run autonomously without asking each time. Lock it so a
    # future edit doesn't silently move it back onto require_approval.
    a26 = Approval(None)
    assert a26.needs_approval("websearch__search") is False, "case26: websearch must be auto-approved"
    assert a26.needs_approval("filesystem__write") is True, "case26: write must stay gated"
    # and through the loop: a websearch action must NOT trigger the confirm gate
    ex26 = FakeExecutor()
    confirm26 = []
    loop26 = AgentLoop(client=None, executor=ex26, max_rounds=2,
                       approval=Approval(os.path.join(ROOT, "config", "approval.yaml")),
                       confirm=lambda tool, reason: (confirm26.append(tool), True)[1])
    loop26.planner = FakePlanner([_action("websearch__search", {"query": "x"})])
    loop26.run("task", history=[])
    assert confirm26 == [], f"case26: websearch wrongly forced confirm: {confirm26}"
    assert ex26.executed == ["websearch__search"], f"case26: websearch should run: {ex26.executed}"
    print("case26 OK: network lookup auto-approved end-to-end (write stays gated)")

    # --- Case 27 (prompt contract): default prompt names the search discipline ---
    assert "SEARCH DISCIPLINE" in DSP and "websearch" in DSP, \
        "case27: default prompt missing search discipline"
    print("case27 OK: default prompt names search discipline (search when info is beyond context/memory)")

    print("POLICY TEST OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
