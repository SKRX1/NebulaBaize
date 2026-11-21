"""Daemon E2E: the REAL scheduler firing a REAL, LLM-driven agent task.

This is the production daemon path (gateway --daemon) exercised end to end with the
genuine pieces: the pure-stdlib Scheduler drives a one-shot entry that fires ONCE, and
the run_task callback runs the real agent through the real online model, real subprocess
servers, real memory layers and real audit. It is the only test that uses the live model
(everything else fakes the planner); everything here is the production wiring, not mocks.

Design notes:
  - One-shot entry with at == now, so it fires immediately and the scheduler exits after
    max_fire=1 (no infinite daemon loop, no long sleeps).
  - Data lives in a scratch dir so production data/ is not polluted.
  - If the shared model service is not reachable, the test SKIPS (prints + returns 0)
    rather than failing — it is an optional live check, not a hard regression gate.

Run from the Nebula-agent folder with the managed python:
    python tests/test_daemon.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

# Reuse the gateway's own production builders so this mirrors the real daemon exactly.
from gateway import load_yaml_or_json, resolve_servers  # noqa: E402
from llm_client import StrataClient  # noqa: E402
from executor import Executor  # noqa: E402
from loop import AgentLoop  # noqa: E402
from policy.approval import Approval  # noqa: E402
from policy.sandbox import Sandbox  # noqa: E402
from memory.session import SessionMemory  # noqa: E402
from memory.episodic import EpisodicMemory  # noqa: E402
from memory.semantic import SemanticMemory  # noqa: E402
from skills_loader import load_skills_meta  # noqa: E402
from audit import AuditLog  # noqa: E402
from scheduler import ScheduleEntry, Scheduler  # noqa: E402

PY = sys.executable
SCRATCH = os.path.join(ROOT, "tests", "_scratch_daemon")
# Resolve the live model backend from config/models.json (the SELECTED entry) so
# this test targets whatever the gateway actually serves -- not a hard-coded
# 127.0.0.1:8080/v1 that may be a dead fallback (2026-11: the real backend is
# llama-swap on :47831, and the served model id is the selected entry, not the
# literal "strata"). Falls back to the historical 8080/strata default only when
# models.json is missing/unreadable, so offline behaviour is preserved.
def _resolve_model():
    try:
        with open(os.path.join(ROOT, "config", "models.json"), "r", encoding="utf-8") as _f:
            _m = json.load(_f)
        _sel = _m.get("selected")
        for _e in _m.get("models", []):
            if _e.get("id") == _sel and _e.get("base_url"):
                return _e["base_url"], _e.get("model", _sel)
    except Exception:
        pass
    return "http://127.0.0.1:8080/v1", "strata"


MODEL_URL, MODEL_NAME = _resolve_model()


def _model_online() -> bool:
    try:
        body = {"model": MODEL_NAME, "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 8, "stream": False}
        req = urllib.request.Request(f"{MODEL_URL}/chat/completions",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            json.loads(r.read().decode("utf-8", "replace"))
        return True
    except Exception:
        return False


def _fresh_scratch():
    if os.path.isdir(SCRATCH):
        shutil.rmtree(SCRATCH)
    os.makedirs(SCRATCH, exist_ok=True)


def main() -> int:
    # H6: explicit CI switch. Under CI the live-LLM daemon check is non-deterministic
    # (the shared model may not be reachable), so skip cleanly instead of probing.
    # Set STRATA_CI=1 in the CI environment; locally (no flag) the live check runs as before.
    if os.environ.get("STRATA_CI"):
        print("DAEMON E2E SKIPPED: STRATA_CI set (live-LLM check skipped in CI)")
        return 0
    if not _model_online():
        print("DAEMON E2E SKIPPED: shared model service not reachable (optional live check)")
        return 0

    _fresh_scratch()

    # --- Production wiring, exactly as gateway --daemon builds it. ---
    cfg = load_yaml_or_json(os.path.join(ROOT, "config", "mcp_servers.json"))
    servers_cfg = resolve_servers(cfg, skills_dir=os.path.join(ROOT, "skills"))
    # Force the managed interpreter into every server command (same guarantee as gateway).
    for entry in servers_cfg.values():
        if entry.get("command") in ("python", sys.executable):
            entry["command"] = PY

    executor = Executor(servers_cfg)
    executor.start_all()
    assert executor.tools, "no tools started (production servers failed)"
    print("production tools:", sorted(t["name"] for t in executor.tools)[:6], "...")

    client = StrataClient(base_url=MODEL_URL, model=MODEL_NAME, effort="low")
    audit = AuditLog(os.path.join(SCRATCH, "audit.jsonl"))
    skill_meta = load_skills_meta(os.path.join(ROOT, "skills"))
    session = SessionMemory(max_chars=int(cfg.get("session", {}).get("max_chars", 8000)))
    episodic = EpisodicMemory(os.path.join(SCRATCH, "episodic.jsonl"))
    semantic = SemanticMemory(os.path.join(SCRATCH, "semantic.db"))

    agent = AgentLoop(client, executor, max_rounds=6, on_event=lambda e: None,
                      approval=Approval(os.path.join(ROOT, "config", "approval.yaml")),
                      sandbox=Sandbox(os.path.join(ROOT, "config", "sandbox.yaml")),
                      session=session, confirm=lambda t, r: True,
                      episodic=episodic, semantic=semantic, skill_meta=skill_meta,
                      audit=audit)
    agent.refresh_tools()

    # --- The daemon fires ONE real, LLM-driven task, then exits. ---
    fired = {"n": 0, "answer": None, "tools": []}

    def run_task(name, task):
        fired["n"] += 1
        # Capture the answer from the loop's authoritative `final` event (the structured
        # compression strategy may fold the assistant turn out of the returned history, so
        # scanning history is fragile; the event is the loop's own end-of-task signal).
        fired["answer"] = None
        agent.on_event = _capture
        agent.run(task, history=[])
        fired["tools"] = [e for e in audit.read() if e["type"] == "tool"]

    def _capture(e):
        if e.get("type") == "final":
            fired["answer"] = e.get("answer")

    # One-shot entry with at == now => fires immediately, then is consumed (scheduler exits).
    entry = ScheduleEntry(name="daemon-e2e",
                          task="Say exactly: DAEMON-FIRED. Do not call any tools.",
                          at=__import__("datetime").datetime.now().isoformat(timespec="seconds"))
    sched = Scheduler([entry], run_task, state_path=os.path.join(SCRATCH, "sched_state.json"))

    total = sched.run(max_fire=1)

    # (a) the real scheduler fired the entry exactly once via the production callback
    assert total == 1 and fired["n"] == 1, f"daemon did not fire exactly once: total={total} fired={fired}"
    print("daemon-a OK: real scheduler fired one-shot through the production run_task callback")

    # (b) the live model produced a real answer (the agent ran for real)
    assert fired["answer"], f"real LLM returned no final answer: {fired}"
    print(f"daemon-b OK: live model answered -> {fired['answer'][:80]!r}")

    # (c) one-shot was consumed and persisted to the state file (production hardening)
    state = load_yaml_or_json(os.path.join(SCRATCH, "sched_state.json"))
    assert "daemon-e2e" in (state.get("consumed_oneshots") or []), \
        f"one-shot not persisted to state: {state}"
    print("daemon-c OK: consumed one-shot persisted to scheduler state (survives restart)")

    executor.stop_all()
    print("DAEMON E2E OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
