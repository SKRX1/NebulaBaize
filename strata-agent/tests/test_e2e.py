"""End-to-end integration test: the FULL chain in one run, offline (no GPU, no model).

Where test_policy.py unit-tests the gates and test_smoke.py proves executor<->server,
this test drives the whole pipeline together through a deterministic scripted planner
(the model is faked at the planner boundary; everything downstream is real):

    scripted plan -> gates (sandbox/approval/skill-permission) -> REAL subprocess
    servers (filesystem + example skill) -> audit trail + meter -> distill -> proactive
    RAG recall -> skill-trigger surfacing.

The point is the closed loop: a task that runs through a real skill tool, whose durable
outcome gets distilled to memory, and whose NEXT run has that learning proactively
recalled at task start ("gets smarter with use", verified end-to-end, not unit-level).

Run from the strata-agent folder with the managed python:
    python tests/test_e2e.py
"""
from __future__ import annotations

import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from loop import AgentLoop  # noqa: E402
from executor import Executor  # noqa: E402
from planner import NextAction  # noqa: E402
from policy.approval import Approval  # noqa: E402
from memory.session import SessionMemory  # noqa: E402
from memory.episodic import EpisodicMemory  # noqa: E402
from memory.semantic import SemanticMemory  # noqa: E402
from skills_loader import load_skills, load_skills_meta  # noqa: E402
from audit import AuditLog  # noqa: E402

PY = sys.executable
SCRATCH = os.path.join(ROOT, "tests", "_scratch_e2e")


def _fresh_scratch():
    # Wipe the scratch dir at the START of each run so the test is idempotent.
    if os.path.isdir(SCRATCH):
        shutil.rmtree(SCRATCH)
    os.makedirs(SCRATCH, exist_ok=True)


class ScriptedPlanner:
    """Fakes the model at the planner boundary; everything downstream is real.

    Scripts a sequence of steps; each step is (actions, final_answer). When
    final_answer is set the loop ends that round (after the self-verify gate).
    """

    def __init__(self, steps):
        self._steps = list(steps)
        self.tools = []  # executor exposes real tools; planner is bypassed here

    def plan(self, messages, effort=None, on_delta=None):
        if not self._steps:
            return NextAction(thinking="t", actions=[], final_answer="done", usage=None)
        actions, final = self._steps.pop(0)
        return NextAction(thinking="t", actions=actions, final_answer=final, usage=None)


def _action(tool, args):
    return [{"id": "c1", "name": tool, "arguments": args}]


def main() -> int:
    _fresh_scratch()

    # --- Assemble the production-like wiring: REAL subprocess servers + memory + audit.
    servers = load_skills(os.path.join(ROOT, "skills"))
    # The skill's server command is "python"; force it to the interpreter running us so
    # the subprocess uses the same managed python (no PATH assumptions).
    for cfg in servers.values():
        cfg["command"] = PY
        cfg["cwd"] = ROOT
        cfg.setdefault("env", {}); cfg["env"] = {**os.environ, **cfg["env"], "FS_ROOT": ROOT}
    assert "example-server" in servers, f"skill server not loaded: {list(servers)}"

    executor = Executor(servers)
    executor.start_all()
    tool_names = sorted(t["name"] for t in executor.tools)
    assert "example-server__hello" in tool_names, f"skill tool not exposed: {tool_names}"
    print("tools wired:", tool_names)

    episodic = EpisodicMemory(os.path.join(SCRATCH, "episodic.jsonl"))
    semantic = SemanticMemory(os.path.join(SCRATCH, "semantic.db"))
    skill_meta = load_skills_meta(os.path.join(ROOT, "skills"))
    audit_path = os.path.join(SCRATCH, "audit.jsonl")
    audit = AuditLog(audit_path)

    events = []
    confirm_calls = []

    def confirm(tool, reason):
        confirm_calls.append((tool, reason))
        return True  # auto-approve so a fired gate still executes (proves gate fires)

    loop = AgentLoop(client=None, executor=executor, max_rounds=4,
                     approval=Approval(os.path.join(ROOT, "config", "approval.yaml")),
                     session=SessionMemory(), confirm=confirm,
                     episodic=episodic, semantic=semantic, skill_meta=skill_meta,
                     audit=audit, on_event=lambda e: events.append(e))

    # Seed a memory so proactive RAG recall has something to surface on this task.
    seed_fact = "Project convention: route shell commands through the sandbox gate."
    semantic.add(seed_fact, meta={"source": "seed"})

    # Run #1: planner calls the skill tool (verb 'hello' is OUTSIDE the skill's
    # declared permissions [filesystem:read] -> skill-permission gate MUST fire), then a
    # durable final answer that gets distilled to episodic AND semantic.
    loop.planner = ScriptedPlanner([
        (_action("example-server__hello", {"name": "e2e"}), None),
        ([], "decision: the example skill greets via hello and the gate held."),
    ])
    loop.run("please run the example skill and greet e2e", history=[])

    etypes = [e["type"] for e in events]

    # (a) proactive RAG recall surfaced the seed fact at task start
    assert "auto-recall" in etypes, f"RAG injection did not fire: {etypes}"
    recall_note = [m for m in loop.session.history if m.get("_auto_recall")]
    assert recall_note and seed_fact in recall_note[0]["content"], \
        f"seed fact not injected: {recall_note}"
    print("E2E-a OK: proactive RAG recalled the seed fact into the working window")

    # (b) skill-trigger surfacing: task hits the 'example' trigger
    assert "skill-surface" in etypes, f"skill trigger did not surface: {etypes}"
    print("E2E-b OK: skill trigger surfaced the matching skill")

    # (c) skill-permission gate fired for the out-of-permission verb, then executed on confirm
    skill_gate = [e for e in events if e["type"] == "approval" and e.get("reason") == "skill permission"]
    assert skill_gate, f"skill-permission gate did not fire: {etypes}"
    assert ("example-server__hello", "outside skill permissions (hello)") in confirm_calls, \
        f"confirm was not asked for the out-of-permission verb: {confirm_calls}"
    tool_evts = [e for e in events if e["type"] == "tool" and e["tool"] == "example-server__hello"]
    assert tool_evts and "hello, e2e" in tool_evts[0]["result"], \
        f"real subprocess did not run: {tool_evts}"
    print("E2E-c OK: skill-permission gate fired -> confirmed -> REAL subprocess ran")

    # (d) audit trail captured plan + tool + summary, and the meter counted them
    audit_rows = audit.read()
    atypes = [r["type"] for r in audit_rows]
    assert "plan" in atypes and "tool" in atypes and "summary" in atypes, \
        f"audit trail incomplete: {atypes}"
    meter = audit.meter
    assert meter["tool_calls"] >= 1 and meter["rounds"] >= 1, f"meter not counted: {meter}"
    print(f"E2E-d OK: audit trail {len(audit_rows)} records; meter tool_calls={meter['tool_calls']} rounds={meter['rounds']}")

    # (e) distill wrote episodic AND semantic (durable 'decision:' final)
    assert any(r.get("meta", {}).get("source") == "auto-distill" for r in episodic.recent()), \
        "episodic distill missing"
    sem_hits = semantic.search("decision skill greets hello", top_k=3)
    assert any("example skill greets" in h["text"] for h in sem_hits), \
        f"semantic distill missing/not recallable: {[h['text'] for h in sem_hits]}"
    print("E2E-e OK: durable outcome distilled to episodic AND semantic")

    # --- Run #2 (same memory store): the closed loop. Nothing new is planned; the task
    # start must now proactively recall what run #1 distilled. This is 'gets smarter
    # with use' proven end-to-end across two sessions on one store.
    events2 = []
    loop2 = AgentLoop(client=None, executor=executor, max_rounds=3,
                      approval=Approval(os.path.join(ROOT, "config", "approval.yaml")),
                      session=SessionMemory(), confirm=lambda t, r: True,
                      episodic=episodic, semantic=semantic, skill_meta=skill_meta,
                      audit=AuditLog(os.path.join(SCRATCH, "audit2.jsonl")),
                      on_event=lambda e: events2.append(e))
    loop2.planner = ScriptedPlanner([([], "done")])
    loop2.run("what do we already know about the example skill? summarize the decision", history=[])
    recall2 = [m for m in loop2.session.history if m.get("_auto_recall")]
    assert recall2 and "example skill greets" in recall2[0]["content"], \
        f"prior-session learning not recalled on run #2: {recall2}"
    print("E2E-f OK: run #2 proactively recalled run #1's distilled decision (closed loop)")

    executor.stop_all()
    print("E2E TEST OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
