"""Agent Loop: Plan -> Act -> Observe -> Reflect, pure standard library.

The heart of the agent. The model chooses the next action via the planner; each tool
call passes the sandbox gate (deny/confirm) and the approval gate (require_approval)
before the executor runs it; the result is appended as a tool message; the model
reflects and decides whether to continue. Session memory holds the append-only history
so the prompt prefix stays stable and Strata's conversation cache keeps hitting.

Cache strategy (see DESIGN.md §5): append-only history, effort at the end.
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field

from llm_client import StrataClient
from planner import Planner
from executor import Executor
from toolcall_parse import hallucinated_tool_call, looks_like_narration, is_thinking_only_round

DEFAULT_SYSTEM_PROMPT = (
    "You are Strata Agent, an autonomous agent. Use the available tools to plan, act, "
    "observe results, and reflect. Prefer a concrete next action over narration. Stop with "
    "a final answer when the task is done or you cannot proceed. Honour sandbox/approval "
    "gates; never invent tool output. Keep answers concise. "
    "FENCE DISCIPLINE: the plan checklist and the next-steps list are markdown fenced "
    "blocks (``plan / ``next-steps), NOT tool calls -- never rewrite them as "
    "<function=...>/<parameter=...> XML, or the parser discards them and the turn stalls "
    "mid-task. Write them as fenced markdown and nothing else. "
    "MEMORY DISCIPLINE: before deciding on a non-trivial step, call the memory 'recall' "
    "tool to retrieve any relevant prior decision or fact; when you form a reusable "
    "conclusion, decision, or user preference, store it via memory 'remember'/'store' so "
    "learning persists across sessions. "
    "KNOWLEDGE BASE: to learn a reference document, use memory 'ingest'; to see what you "
    "have learned and what you can drop, use 'sources'; to drop a learned source or a "
    "single item, use 'forget' (it asks for approval). Image/audio/video must be "
    "transcribed to text first, then ingested. "
    "SEARCH DISCIPLINE: when you need information beyond the current context and memory "
    "(a fact, a figure, current data), search the web via the 'websearch' tool rather than "
    "guessing. "
    "SELF-IMPROVEMENT: reflect on what worked or failed in this task and capture the "
    "lesson, so you get better with use."
)


@dataclass
class Step:
    round: int
    thinking: str
    tool: str | None
    arguments: dict | None
    result: str | None
    final: bool = False


class AgentLoop:
    def __init__(self, client: StrataClient, executor: Executor,
                 max_rounds: int = 32, on_event=None,
                 approval=None, sandbox=None, session=None,
                 confirm=None, summarize=None, system_prompt=None, episodic=None, semantic=None,
                 verifier=None, max_verify_retries: int = 2, audit=None, clock=None,
                 checkpoint=None, skill_meta=None):
        self.client = client
        self.executor = executor
        self.planner = Planner(client, [])
        # CLI --max-rounds defaults to None; AgentLoop must fall back to its own
        # default (32) here, otherwise run() evaluates range(1, None + 1) ->
        # "unsupported operand type(s) for +: NoneType and int" on the FIRST round
        # (this is what made every scheduled agent-turn run red). The interactive/HTTP
        # paths escaped it only because http_server int()s gw_state.max_rounds separately.
        self.max_rounds = max_rounds if max_rounds is not None else 32
        self.on_event = on_event or (lambda e: None)
        # policy + memory layers (optional; loop degrades gracefully when None)
        self.approval = approval
        self.sandbox = sandbox
        self.session = session
        # confirm(tool, reason) -> bool; default auto-approves (no interactive gate)
        self.confirm = confirm or (lambda tool, reason: True)
        # summarize(text)->text used to fold old turns. None => let the session use its
        # own configured strategy (default: built-in structured). Pass an LLM-backed
        # callable (shared Strata model) here to override with semantic summaries.
        self.summarize = summarize
        # Persistent persona/instructions. Injected at the HEAD of the message list on
        # every plan call so it stays byte-stable and the prompt cache keeps hitting.
        self.system_prompt = system_prompt if system_prompt is not None else DEFAULT_SYSTEM_PROMPT
        # Cross-session episodic memory for the auto-distill hook (optional; the loop
        # degrades gracefully to no-op when None).
        self.episodic = episodic
        self.semantic = semantic
        # Automated self-test gate (optional). When present, a model-stated "done"
        # triggers a verification run; red feeds the failure back for a fix+retry.
        self.verifier = verifier
        self.max_verify_retries = max_verify_retries
        # Observability layer (optional). When present, each round/tool/planning call is
        # timed and recorded, with token usage when the API returns it.
        self.audit = audit
        self._clock = clock or time.monotonic
        # Durability for long-running tasks: an injected CheckpointStore persists the live
        # history each round so a crashed run can resume from the last saved point.
        self.checkpoint = checkpoint
        # Skill policy metadata (server_name -> {name, permissions, triggers}). When
        # present, a skill tool whose action is OUTSIDE its declared permissions is forced
        # through the approval gate, and a trigger keyword hit on the task surfaces the
        # skill (surfacing only — never auto-execution). Loaded by the gateway from
        # skills_loader.load_skills_meta(). Degrades to no-op when empty/None.
        self.skill_meta = skill_meta or {}
        self._skills_helpers = None  # lazy import of skills_loader helpers
        self._tools = []
        self._tools_ready = False

    def _maybe_compress(self):
        """Trigger automatic compression when the live window exceeds its budget.

        Returns the (possibly folded) message list. No-op when no session memory is set.
        """
        if self.session is None:
            return None
        before = len(self.session.history)
        msgs = self.session.compress(self.summarize)
        if len(msgs) < before:
            self.on_event({"type": "compress", "from": before, "to": len(msgs)})
        return msgs

    def refresh_tools(self):
        self._tools = [{"name": t["name"], "description": t["description"],
                        "input_schema": t["input_schema"]} for t in self.executor.tools]
        self.planner.tools = self._tools
        self._tools_ready = True

    def _commit(self, msg: dict) -> list:
        """Append one message to the authoritative history; return the live list.

        When session memory is present it is the single source of truth (so compression
        can see every turn); otherwise a local list is authoritative.
        """
        if self.session is not None:
            self.session.history.append(msg)
            self._save_checkpoint(self.session.history)
            return self.session.history
        if not hasattr(self, "_live"):
            self._live = []
        self._live.append(msg)
        self._save_checkpoint(self._live)
        return self._live

    def _save_checkpoint(self, history: list) -> None:
        """Persist the live history so a crashed long run can resume (no-op if unwired)."""
        if self.checkpoint is not None:
            try:
                self.checkpoint.save(history)
            except Exception:
                pass

    def _distill(self, user_message: str, trace: list, final: str) -> None:
        """Auto-distill a learning record at task end (episodic + semantic dual-write).

        Episodic gets the event trace (what was asked, which tools, the outcome).
        When the outcome reads like a durable decision/fact (the structured-summary
          markers "decision:/fact:/todo:"), it is also stored in semantic memory so it
          becomes semantically recallable in future sessions. Dedup happens inside both
          layers, so repeated distills of the same outcome merge instead of piling up.
        No-op when neither layer is wired.
        """
        if self.episodic is None and self.semantic is None:
            return
        tools_used = sorted({s.tool for s in trace if s.tool})
        event = (f"task: {user_message[:120]} | "
                 f"tools: {', '.join(tools_used) if tools_used else 'none'} | "
                 f"outcome: {(final or '')[:160]}")
        try:
            if self.episodic is not None:
                self.episodic.log(event, meta={"source": "auto-distill"})
                self.on_event({"type": "distill", "event": event})
            if self.semantic is not None and self._is_durable(final):
                self.semantic.add((final or "").strip(), meta={"source": "auto-distill"})
                self.on_event({"type": "distill-semantic", "text": (final or "")[:120]})
        except Exception:
            pass

    def _auto_recall(self, user_message: str) -> None:
        """Proactive RAG injection: retrieve top-k memories for the task and inject once.

        Without this, recall quality depends on the model voluntarily calling the memory
        tool. With it, relevant episodic/semantic memories are surfaced into the working
        window up front so learning reliably feeds decisions. No-op when no memory layer is
        wired, the query is trivial, or nothing matches (so empty sessions stay clean).
        """
        if self.episodic is None and self.semantic is None:
            return
        q = (user_message or "").strip()
        if len(q) < 4:
            return
        lines = []
        try:
            if self.semantic is not None:
                for h in self.semantic.search(q, top_k=3):
                    lines.append(f"[semantic] {h.get('text', '')}")
            if self.episodic is not None:
                for h in self.episodic.search(q)[:3]:
                    lines.append(f"[episodic] {h.get('event', '')}")
        except Exception:
            return
        if not lines:
            return
        note = "[memory recall for this task]\n" + "\n".join(lines)
        self._commit({"role": "user", "content": note, "_auto_recall": True})
        self.on_event({"type": "auto-recall", "count": len(lines), "task": q[:120]})

    def _surface_skills(self, user_message: str) -> None:
        """Skill-trigger surfacing: fire a `skill-surface` event for any skill whose
        declared trigger keyword appears in the task. Surfacing only — no auto-execution.
        No-op when no skill metadata is wired or no trigger matches.
        """
        if not self.skill_meta:
            return
        for server, meta in self.skill_meta.items():
            if self._skill_helpers().matches_trigger(meta, user_message):
                self.on_event({"type": "skill-surface", "server": server,
                               "skill": meta.get("name", ""), "task": (user_message or "")[:120]})

    @staticmethod
    def _is_durable(final: str) -> bool:
        """Heuristic: outcome reads like a reusable decision/fact, worth semantic storage."""
        f = (final or "").strip()
        if not f:
            return False
        markers = ("decision:", "decided", "fact:", "fact ", "prefer", "conclusion:",
                   "决定", "事实", "选择", "采用")
        return any(m in f.lower() for m in markers) and len(f) >= 8

    def run(self, user_message: str, history: list[dict] | None = None,
            effort: str | None = None) -> list[dict]:
        if not self._tools_ready:
            self.refresh_tools()
        # Seed the authoritative history (session if present, else a fresh local list).
        if self.session is not None:
            self.session.history = list(history or [])
        else:
            self._live = list(history or [])
        messages = self._commit({"role": "user", "content": user_message})
        # Proactive memory recall: pull top-k relevant memories for this task and inject
        # them once at the top of the working window, so "gets smarter with use" does not
        # depend on the model voluntarily calling the recall tool (the RAG-injection loop).
        self._auto_recall(user_message)
        # Skill-trigger surfacing (G3): a trigger keyword hit on the task surfaces the
        # matching skill as a candidate hint (surfacing only, never auto-execution).
        self._surface_skills(user_message)
        trace = []
        self._verify_attempts = 0

        nudges = [0]   # per-turn budget for the finalize-branch guards (B action-shape cap 5, narration cap 2)
        thinking_nudges = [0]   # separate budget for thinking-only-round guard (cap 2)
        for rnd in range(1, self.max_rounds + 1):
            # --- automatic context management: fold old turns if over budget ---
            compressed = self._maybe_compress()
            if compressed is not None:
                messages = compressed
            # System prompt is prepended as a *view* only at the API-call boundary: it is
            # never stored in history, so compression can't fold it, and it stays byte-stable
            # at the head => maximum cache hit.
            view = ([{"role": "system", "content": self.system_prompt}] if self.system_prompt else []) + messages
            _t0 = self._clock()
            action = self.planner.plan(view, effort=effort)
            if self.audit is not None:
                self.audit.note_round()
                self.audit.note_llm(action.usage)
                self.audit.event("plan", rnd=rnd, duration_ms=(self._clock() - _t0) * 1000,
                                 extra={"actions": len(action.actions),
                                        "final": action.final_answer is not None})
            step = Step(round=rnd, thinking=action.thinking, tool=None,
                        arguments=None, result=None)
            # ── finalize-branch guards (mirror of http_server run_with_mcp) ──
            # The model can (a) write the markdown plan fence AS a tool-call shape, or
            # (b) narrate the next step without doing it. Both used to fall through to the
            # finalize `break` below and stop a mid-task turn. Discriminators live in the
            # SHARED module so both chains judge them identically. Each guard keeps working
            # when it fires; the budget caps it so a model stuck on the pattern is bounded.
            known = {t["name"] for t in self._tools}
            # thinking-only-round guard: model emitted ONLY reasoning, no text, no call.
            # Without this it falls through to the bare break at the bottom. Cap 2 per turn.
            if (action.final_answer is None and not action.actions
                    and thinking_nudges[0] < 2
                    and is_thinking_only_round(action.final_answer or "", action.thinking, False)):
                thinking_nudges[0] += 1
                messages.append({"role": "assistant", "content": action.thinking or ""})
                messages.append({"role": "user", "content":
                                 "[system] 你的回复只有思考链，没有产出正文或工具调用。"
                                 "如果任务还没做完：现在立刻调用工具执行，或给出明确的回复。"
                                 "如果确实已完成：用一句话说明「已完成」。"})
                continue
            if (action.final_answer is not None and not action.actions
                    and nudges[0] < 5 and hallucinated_tool_call(action.final_answer, known)):
                nudges[0] += 1
                messages.append({"role": "assistant", "content": action.final_answer})
                messages.append({"role": "user", "content":
                                 "[system] 你刚才把计划/建议用 <function=...> 写成了工具调用的样子，"
                                 "但它不是真正的工具调用（解析器无法识别那个名字），所以回合差点在这里结束。"
                                 "如果任务还没做完：现在用正确的工具调用语法真正执行下一步；"
                                 "如果那只是给用户的计划清单，请用 markdown 围栏写，不要写成工具调用语法。"})
                continue
            if (action.final_answer is not None and not action.actions
                    and nudges[0] < 2 and looks_like_narration(action.final_answer)):
                nudges[0] += 1
                messages.append({"role": "assistant", "content": action.final_answer})
                messages.append({"role": "user", "content":
                                 "[system] 你刚才只描述了下一步，并没有调用任何工具，所以回合就结束了。"
                                 "如果任务还没做完：现在就调用工具真正执行，不要只说明计划。"
                                 "如果确实已经全部完成：用一句话明确说明「已完成」和产出文件，"
                                 "不要再用「开始/接下来」这类措辞。"})
                continue
            if action.final_answer is not None:
                step.final = True
                self._commit({"role": "assistant", "content": action.final_answer})
                trace.append(step)
                # --- automated self-test gate: a stated "done" must verify green ---
                if self.verifier is not None and self._verify_attempts < self.max_verify_retries:
                    self._verify_attempts += 1
                    passed, out = self.verifier.check()
                    self.on_event({"type": "verify", "round": rnd, "passed": passed,
                                   "attempt": self._verify_attempts, "output": out[:400]})
                    if not passed:
                        # feed the real failure back so the model reflects and fixes, then
                        # verifies again — closes the run->red->fix->verify loop.
                        feedback = (f"[self-verify FAILED on attempt {self._verify_attempts}] "
                                    f"The task is not done yet. Verification output:\n{out[:1500]}\n"
                                    f"Fix the cause and try again.")
                        messages = self._commit({"role": "user", "content": feedback})
                        continue
                self.on_event({"type": "final", "round": rnd, "thinking": action.thinking,
                               "answer": action.final_answer})
                self._distill(user_message, trace, action.final_answer)
                self._audit_summary(user_message)
                break
            # execute each tool call the model requested this round
            for call in action.actions:
                _tt = self._clock()
                result = self._run_tool(call, messages)
                if self.audit is not None:
                    self.audit.note_tool()
                    self.audit.event("tool", rnd=rnd, tool=call["name"],
                                     arguments=call["arguments"], result=result,
                                     duration_ms=(self._clock() - _tt) * 1000)
                trace.append(Step(round=rnd, thinking=action.thinking, tool=call["name"],
                                  arguments=call["arguments"], result=_display_result(result)))
                self.on_event({"type": "tool", "round": rnd, "tool": call["name"],
                               "arguments": call["arguments"], "result": _display_result(result)})
                # messages = the live authoritative list (post-compression the copy can
                # diverge, so always take the committed list back)
                messages = self._commit({
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{"id": call["id"], "type": "function",
                                    "function": {"name": call["name"],
                                                 "arguments": json.dumps(call["arguments"])}}],
                })
                messages = self._commit({"role": "tool", "tool_call_id": call["id"], "content": _tool_content(result)})
            if not action.actions:
                # model answered without any tool call in a way that ended the turn
                messages = self._commit({"role": "assistant", "content": action.thinking or ""})
                trace.append(Step(round=rnd, thinking=action.thinking, tool=None,
                                  arguments=None, result=None, final=True))
                self.on_event({"type": "final", "round": rnd, "thinking": action.thinking,
                               "answer": ""})
                self._distill(user_message, trace, action.thinking or "")
                self._audit_summary(user_message)
                break
        else:
            # G4: rounds exhausted without a final answer. Previously the loop just
            # returned silently; now it finalizes so a long over-budget task is not an
            # opaque no-answer: emit an event, distill the partial learning, write audit.
            note = "(rounds exhausted without a final answer; returning last working state)"
            self.on_event({"type": "round-exhausted", "round": self.max_rounds,
                           "task": (user_message or "")[:120]})
            self._distill(user_message, trace, note)
            self._audit_summary(user_message)
        return messages

    def _skill_helpers(self):
        if self._skills_helpers is None:
            import skills_loader
            self._skills_helpers = skills_loader
        return self._skills_helpers

    def _skill_perm_ok(self, meta: dict, verb: str) -> bool:
        return self._skill_helpers().is_within_permissions(meta, verb)

    def _audit_summary(self, task: str) -> None:
        """Emit a final meter summary through the audit layer (no-op when absent)."""
        if self.audit is not None:
            self.audit.summary(task)

    def _run_tool(self, call: dict, messages: list[dict]) -> str:
        tool = call["name"]
        args = call["arguments"]

        # --- Sandbox gate (defence in depth; the shell server also self-checks) ---
        if self.sandbox is not None:
            cmd = args.get("command") if isinstance(args, dict) else None
            if cmd:
                allowed, reason = self.sandbox.check(cmd)
                if not allowed:
                    self.on_event({"type": "blocked", "tool": tool, "reason": reason})
                    return f"error: {reason}"
                if self.sandbox.is_destructive(cmd):
                    if not self.confirm(tool, f"destructive: {reason}"):
                        return "error: user declined destructive action"

        # --- Approval gate (ask the user for tools flagged require_approval) ---
        if self.approval is not None and self.approval.needs_approval(tool):
            self.on_event({"type": "approval", "tool": tool, "arguments": args})
            if not self.confirm(tool, "requires approval"):
                return "error: user declined this action"

        # --- Skill-permission gate (G3): a skill tool whose action is outside its
        #     declared permissions is forced through the approval gate. Tools not declared
        #     by any skill (or skills with no permissions block) pass through untouched. ---
        if self.skill_meta:
            server = tool.split("__", 1)[0]
            meta = self.skill_meta.get(server)
            if meta and meta.get("permissions"):
                verb = tool.split("__", 1)[1] if "__" in tool else ""
                if not self._skill_perm_ok(meta, verb):
                    self.on_event({"type": "approval", "tool": tool, "arguments": args,
                                   "reason": "skill permission"})
                    if not self.confirm(tool, f"outside skill permissions ({verb})"):
                        return "error: user declined this action"

        # --- Execute ---
        return self.executor.call(tool, args)


def _tool_content(result):
    """Tool result -> content for the model. A plain string passes through untouched;
    a structured result (images present) becomes OpenAI multimodal content parts."""
    if not isinstance(result, dict):
        return result
    parts = []
    txt = (result.get("text") or "").strip()
    if txt:
        parts.append({"type": "text", "text": txt})
    for img in result.get("images", []):
        mime = img.get("mimeType") or "image/png"
        parts.append({"type": "image_url",
                      "image_url": {"url": f"data:{mime};base64," + str(img.get("data", ""))}})
    return parts


def _display_result(result) -> str:
    """Tool result -> the text shown in the trace/events/UI (images become a short note)."""
    if not isinstance(result, dict):
        return result
    txt = (result.get("text") or "").strip()
    n = len(result.get("images", []))
    if txt:
        return txt + (f"\n[{n} image(s) attached to the model]" if n else "")
    return f"[{n} image(s) attached to the model]" if n else ""