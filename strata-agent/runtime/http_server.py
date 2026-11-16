"""Gateway HTTP server: standalone mode — serves static frontend + full proxy to upstream.

Pure standard library (http.server + urllib). When the gateway runs with --serve, it starts
this server on the specified port. It provides:
  - Static file serving (the web frontend from serve/web/)
  - Transparent reverse proxy: all API paths are forwarded to the upstream server

In standalone mode, the gateway is a thin reverse proxy + static file server. The upstream
can be any full Strata instance (with MCP, approvals, etc.) or a plain OpenAI-compatible API
(reduced feature set for basic chat).

API paths that get proxied (everything except static files):
  /v1/*         — OpenAI-compatible endpoints (chat/completions, images/generations, models)
  /metrics      — engine metrics
  /mcp          — MCP status
  /mcp/call     — MCP tool invocation
  /health       — health check
  /settings     — runtime settings (GET/POST)
  /config       — config read (GET/POST)
  /approval/*   — approval flow
  /workspace/*  — workspace operations
"""
from __future__ import annotations

import collections
import io
import json
import mimetypes
import os
import queue
import re
import select
import contextlib
import hashlib
import shutil
try:
    import psutil
except ImportError:
    psutil = None  # type: ignore
import socket
import subprocess
import sys
import threading
import time
import uuid
from concurrent import futures

# Serializes the per-turn judge's append to judge_stream.jsonl so concurrent turns
# (a long session fires the judge once per turn) never race on the same file handle.
JUDGE_WRITE_LOCK = threading.Lock()

# Garbage-recycle batch trash: large batches run as a background job so the caller can poll
# progress and stop mid-flight. Each file still spawns its own PowerShell + COM apartment, so
# a bounded worker pool is safe (no shared COM apartment). Small batches stay synchronous.
_RECYCLE_JOBS = {}                # job_id -> {total,done,failed,cancelled,lock,event,finished}
_RECYCLE_JOBS_LOCK = threading.Lock()
_RECYCLE_LEDGER_LOCK = threading.Lock()   # serialises concurrent appends to one ledger.jsonl
# parallel_probe lives in this same runtime/ folder (http_server runs as a script,
# so sys.path[0] is runtime/ and the bare import resolves at load time, before the constants).
import parallel_probe   # shared plan-A tiered probe (one source for every consumer)
from parallel_probe import compute as _probe_compute
_RECYCLE_TRASH_BATCH = _probe_compute("recycle_batch")        # fixed 8 by design (plan A); STRATA_RECYCLE_BATCH env override wins
_RECYCLE_TRASH_WORKERS = _probe_compute("recycle_workers")     # adaptive floor(cores*0.4) cap8 -> 4 on this box (reproduces the tuned value)
_RECYCLE_TRASH_SYNC_MAX = 3       # paths <= this stay on the synchronous path (no job overhead)
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, unquote, urlsplit

# Lossless tool-result cap for the live history (Loop B) — mirrors SessionMemory.compress
# so the Web/direct path no longer diverges. The model sees the executor-capped output this
# turn; the stored history entry is head/tail truncated with the full text saved for recall.
from memory.session import cap_tool_result

from registry import RegistryError

import executor as _executor          # module-level tunables (DEFAULTS / SERVER_TIMEOUT_S)
from executor import is_error, error_code

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.environ.get("WEB_DIR", os.path.join(ROOT, "serve", "web"))
# Generated images persist here (survives refresh/restart) and are served via _serve_static's data/generated/ route. Created lazily by _gen_local.
GENERATED_DIR = os.path.join(ROOT, "data", "generated", "images")
# [Turbo 官方默认档] 前后端留空即用这两个值（Qwen-Image-2.1-Turbo: 8 steps, CFG 1）
TURBO_STEPS = 8
TURBO_CFG = 1.0

# [实时预览 2026-11-14 方案A] 本地生成异步化：后台线程跑 sd-cli（拼 --preview），主线程立即返回
# job_id+preview_url，前端每约2秒轮询 GET /api/image-preview?job= 刷新预览图。预览 png 落在
# data/generated/previews/ 下（静态服务 data/generated/ 前缀天然覆盖子目录）。
# [FIX 2026-11-14] sd-cli 误读 CJK 路径（与 ASCII 模型缓存同根因）：ROOT 含中文时预览必须
# 落 ASCII 物理目录，否则引擎每步画的预览全写进它看不见的路径，前端永远 404 破图。
# 物理改道、URL 不变：静态服务把 data/generated/previews/ 前缀映射到这里（照 data/uploads/ 先例）。
PREVIEWS_ASCII = r"C:\Users\sk\strata_snapshots\previews"   # 快照惯例目录（重启报告也写在那）
PREVIEWS_DIR = PREVIEWS_ASCII if not os.path.join(ROOT, "data", "generated", "previews").isascii() \
    else os.path.join(ROOT, "data", "generated", "previews")
_IMAGE_JOBS = {}            # job_id -> {status, preview_url, result, error}
class _ProcRc:
    """[停止生成] 轻量 shim：让 _run_cancellable 的返回值兼容 subprocess.run 的 .returncode/.stderr。"""
    __slots__ = ("returncode", "stdout", "stderr")
    def __init__(self, rc, out, err):
        self.returncode, self.stdout, self.stderr = rc, out, err

_IMAGE_JOBS_LOCK = threading.Lock()
_ASCII_CACHE_LOCK = threading.Lock()   # serialises first-copy into the ASCII model cache

# The build id the served frontend carries (window.__strataBuild). Read once, cached: the gateway
# serves this very file, so the id always matches what a fresh tab loads. It rides along on every
# /models/config poll so a tab running an OLDER app.js can notice and reload itself — a tab opened
# before an update never re-fetches app.js on its own (no-cache only helps at load time), which is
# how "I fixed it but the UI still behaves old" happens.
_WEB_BUILD_CACHE = None


def _web_build() -> str:
    global _WEB_BUILD_CACHE
    if _WEB_BUILD_CACHE is None:
        try:
            src = (Path(WEB_DIR) / "app.js").read_text(encoding="utf-8", errors="replace")
            m = re.search(r'window\.__strataBuild\s*=\s*"([^"]+)"', src)
            _WEB_BUILD_CACHE = m.group(1) if m else ""
        except Exception:
            _WEB_BUILD_CACHE = ""
    return _WEB_BUILD_CACHE

# Where the frontend's interruption log lands (JSONL, append-only). Override with
# STRATA_INTERRUPT_LOG. Kept outside the workspace on purpose: it is a diagnostic trail
# of the gateway/engine, not part of any project.
INTERRUPT_LOG = os.environ.get("STRATA_INTERRUPT_LOG",
                               os.path.join(ROOT, "logs", "interrupt-log.jsonl"))
ILOG_MAX_BYTES = 2_000_000        # rotate past this size
ILOG_KEEP_ON_ROTATE = 500         # newest lines carried into the fresh file
ILOG_TAIL_MAX = 500               # hard cap for GET ?n=

# Per-ROUND output cap sent to the engine. It used to be a hardcoded 4096 that ALSO ignored the
# composer's own max_tokens, so one long reasoning round (or a whole file written inside a single
# tool call) ran out of budget mid-way: the round ended with finish_reason="length", no answer text
# and no tool call -- from the user's seat "it just stopped while thinking". Reasoning models spend
# a large share of this budget on thoughts before they emit anything, so the default is generous;
# the client may override it per request (settings.max) and an env var can pin it for a machine.
DEFAULT_OUTPUT_TOKENS = int(os.environ.get("STRATA_MAX_OUTPUT", "8192"))

# HARD ceiling for the per-round output budget. The dynamic per-round cap (see
# _agent_stream) scales generation to the FREE space in the context window so a
# near-empty conversation can still emit a large file in one turn, but it never
# exceeds this ceiling: a single turn blowing past ~32k tokens would take ~30 min
# on this machine AND devour the window, leaving no room for prompt or later turns.
# Pin per machine with STRATA_MAX_OUTPUT_CEILING. The composer's explicit Max
# tokens is honoured as a cap but is itself clamped to this ceiling, so a huge
# value can never trigger an upstream 400 from "max_tokens + prompt > n_ctx".
OUTPUT_CEILING = int(os.environ.get("STRATA_MAX_OUTPUT_CEILING", "32768"))


# Headroom kept free for this round's own output PLUS one tool result, so a round that
# fills its budget can still land its tool call and the next turn has room. Floor so a
# near-full window never collapses the budget to 0 (which would make the engine reject
# the call or emit nothing useful).
_CONTEXT_MARGIN = 4096
_MIN_CAP = 2048
# 正文保底额度：思考满额后，发给引擎的闸门里必须为正文(回答/写文件)至少留出的 token 数。
# 引擎把 max_tokens 当作"思考+正文合计闸门"，所以这里给的是二者相加的总闸门；
# 前端显式发来 answer_floor_tokens 时用前端值，未发时用此默认(16384)。留空(0)=旧行为(满额ceiling)。
_DEFAULT_ANSWER_FLOOR = 16384

# ── Resident-contention split (2026-10-24) ──────────────────────────────────────────
# The guard line: a conversation whose OWN last-reported occupancy is at/over this fraction
# of the window genuinely filled its share -- a 400 then is a real overflow, fix = compact.
# Below the line, a 400 on a modest conversation is the SHARED resident KV pool contending
# across live sessions (see the _agent_stream note).
_GUARD_FRACTION = 0.92
# Honest wording for a resident-contention refusal (the frontend noticeText prefers n.text, so
# this reaches the banner verbatim -- no i18n key needed; the guidance is machine-generated).
_CONTENTION_TEXT = (
    "上游拒收，但本会话占用还不到窗口的多数（非真正的窗口溢出）。"
    "若静默重试已失败，请先关闭闲置会话腾出预算，然后直接在本窗口底部点「继续」续跑——不要新建窗口，新建窗口会读不到当前上下文。"
)


def overflow_action(last_prompt, window, retried):
    """Decide what to do when the upstream 400s a NON-compact request with a context-overflow.

    Pure and side-effect free so it is directly testable (tests/test_resident_retry.py).
      last_prompt -- THIS conversation's own last reported occupancy (0/None = never reported)
      window      -- the engine's real window from ctx_window() (0/None = unknown)
      retried     -- True when we already quietly resent this request once (one retry budget)
    Returns "retry" | "notice_contention" | "compact".
    """
    # A chat that never reported usage (a brand-new conversation whose first send was refused)
    # occupies almost nothing -- it cannot be a contention victim. Treat it like the guard does.
    if not last_prompt or not window:
        return "compact"
    under_line = last_prompt < int(window * _GUARD_FRACTION)
    if not under_line:
        return "compact"                      # genuinely near the ceiling: resend would loop
    if not retried:
        return "retry"                        # contention smell + retry budget available
    return "notice_contention"               # resend already failed: report it honestly


def compute_output_cap(asked, max_context, last_prompt, ceiling=OUTPUT_CEILING,
                       reasoning_budget=0, answer_floor=0):
    """Dynamic single-round generation budget (the fix for "capped at 8192").

    asked        -- composer's explicit Max tokens (0/None = not set)
    max_context  -- engine context window in tokens (0/None = unknown)
    last_prompt  -- this session's last recorded prompt tokens (0/None = none)
    ceiling      -- hard ceiling; never exceeded
    reasoning_budget -- 思考预算：引擎侧思考链可占用的 token 上限（前端档位/数值框发来）
    answer_floor     -- 正文保底额度：思考满额后正文至少留出的 token 数（方案A增强）

    方案A增强：当 asked 未设但给了 reasoning_budget / answer_floor 时，发给引擎的总闸门
    = 思考预算 + 正文保底，保证思考吃满后正文仍有独立预算、不再 finish_reason=length。
    二者相加再受 ceiling 与 free 双约束（仍不可能触发上游 400）。
    默认 reasoning_budget=answer_floor=0 时行为与旧版完全一致（向后兼容，现有测试不破）。
    """
    # 有效请求闸门：显式 asked 优先；否则若给了思考/正文分项，二者相加作为总闸门。
    eff = asked if (asked and asked > 0) else ((reasoning_budget or 0) + (answer_floor or 0))
    if max_context:
        free = (max_context - (last_prompt or 0) - _CONTEXT_MARGIN)
        if free < _MIN_CAP:
            free = _MIN_CAP
        # eff<=0（都没填）时回退 ceiling，保持旧行为；否则 min(eff, ceiling, free)。
        if eff and eff > 0:
            return min(eff, ceiling, free)
        return min(ceiling, free)
    # Window unknown: we can't measure free space, but the ceiling still binds.
    if eff and eff > 0:
        return min(eff, ceiling)
    return ceiling


# Reasoning effort is FORWARDED from the caller instead of being pinned here. It used to be a
# hardcoded "medium", so the composer's 思维强度 selector (off/low/medium/high) had literally no
# effect -- whatever the user picked was silently overwritten. The upstream VALIDATES this value
# (anything unknown answers HTTP 400 and the turn dies with a red box), so only known-good ones
# are forwarded; anything else is dropped and the upstream falls back to its own default.
REASONING_EFFORTS = ("off", "none", "minimal", "low", "medium", "high")


def reasoning_effort_of(body):
    """Caller's requested thinking level, normalised and validated -> str | None."""
    try:
        raw = str((body or {}).get("reasoning_effort") or "").strip().lower()
    except Exception:
        return None
    return raw if raw in REASONING_EFFORTS else None


def reasoning_budget_of(body):
    """Optional reasoning token budget the composer attached to an explicit level -> int | None.

    The composer only ever sends this for an explicit 低/中/高 level; 跟随模型 (auto) sends
    nothing and the engine falls back to its own default (uncapped). Anything non-positive or
    missing is treated as "no cap". Unknown extra params are harmless to forward — the upstream
    ignores keys it does not recognise — so only the value's sanity is checked here.
    """
    try:
        v = (body or {}).get("reasoning_budget_tokens")
        if v is None:
            return None
        n = int(v)
    except Exception:
        return None
    return n if n > 0 else None


def parse_tool_args(raw):
    """Parse a tool call's `arguments` string -> (args, ok).

    ok=False means the JSON was cut off (the round hit the output cap mid-arguments) or is simply
    malformed. The caller MUST NOT run the tool in that case: a filesystem write with no path or a
    shell with no command is not a harmless no-op. Returning ({}, True/False) instead of raising
    keeps the agent loop alive and lets the model re-issue the call in smaller pieces.
    """
    try:
        val = json.loads(raw or "{}")
    except Exception:
        return None, False
    if not isinstance(val, dict):
        return {}, True
    return val, True


# Text-form tool-call discriminators live in toolcall_parse.py — the SINGLE source both
# server chains (run_with_mcp here, AgentLoop in loop.py) share, so they can never drift.
# Re-exported by name so `from http_server import text_tool_calls` (tests + call points) is
# unchanged. The underscore helpers are imported too in case a future call point wants them.
from toolcall_parse import (text_tool_calls, looks_like_narration, hallucinated_tool_call,
                            _norm_tool, _prefix_tool_map, _CALL_FUNC_RE, _CALL_PARAM_RE,
                            _STRAY_CALL_TAG_RE, _ANY_CALL_MARKUP, _NARRATE_RE, _DONE_RE)

def _ilog_append(path: str, entry: dict) -> None:
    """Append one interruption record as a single JSON line (creates the dir if needed)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    try:
        if os.path.getsize(path) > ILOG_MAX_BYTES:
            _ilog_rotate(path)
    except OSError:
        pass                                  # a failed rotation must not fail the write


def _ilog_rotate(path: str) -> None:
    """Logrotate-style, best effort: the old file moves aside once, the newest lines stay."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return
    try:
        with open(path + ".1", "w", encoding="utf-8") as fh:      # full old file, kept once
            fh.writelines(lines)
        with open(path, "w", encoding="utf-8") as fh:
            fh.writelines(lines[-ILOG_KEEP_ON_ROTATE:])
    except OSError:
        pass

# System prompt used when the gateway runs its own agent loop (direct mode). The upstream only
# supplies the LLM; the local MCP servers supply the tools, so the model needs explicit guidance.
DIRECT_SYSTEM_PROMPT = (
    "You are a capable assistant running on the user's own computer, with a set of local tools "
    "(file system, shell, web search, memory, browser, scheduling) that execute here with the "
    "user's permissions. Use the tools whenever they help: think first, then act, then observe the "
    "result and continue until the task is done. Prefer concrete actions over narration. If you "
    "cannot proceed or the task is complete, give a concise final answer. Never invent tool output."
)


def system_view_with_fallback(messages):
    """Compose the message list sent to the upstream LLM.

    ``DIRECT_SYSTEM_PROMPT`` is only a *fallback* system prompt for callers that
    do not supply their own (e.g. raw ``/v1/chat/completions`` API/CLI clients,
    or alternative frontends). The built-in web UI always sends a comprehensive
    Chinese system prompt via ``apiMessages()`` (``BASE_SYSTEM`` + persona +
    ``workspaceSystem``, which now also carries the "never invent tool output"
    guardrail), so we must NOT prepend the redundant English prompt there —
    doing so duplicates guidance and bloats the compression-immune fixed
    overhead. We only inject it when the caller's first message is not already a
    ``system`` role.
    """
    if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
        return messages
    return [{"role": "system", "content": DIRECT_SYSTEM_PROMPT}] + messages


def _build_tool_content(result, cap=None):
    """Convert an executor tool result into model-facing message content.

    Mirrors ``loop._tool_content`` but caps the text first when ``cap`` is
    supplied. Returns a LIST of OpenAI multimodal parts when the result carries
    image(s) — the engine only "sees" an image when a tool message's ``content``
    is a list (frontend._has_image requires a list; chat_template emits vision
    tokens only for list items and raises 'Unexpected content type' on a
    mapping). A plain-text or image-free result falls back to the string /
    capped-text dict used everywhere else, so non-multimodal paths are unchanged.
    """
    if isinstance(result, str):
        return cap(result) if cap else result
    if not isinstance(result, dict):
        return result
    imgs = result.get("images") or []
    txt = result.get("text") or ""
    if cap:
        txt = cap(txt)
    if imgs:
        parts = []
        if (txt or "").strip():
            parts.append({"type": "text", "text": txt})
        for img in imgs:
            mime = img.get("mimeType") or "image/png"
            parts.append({"type": "image_url", "image_url": {
                "url": f"data:{mime};base64," + str(img.get("data", ""))}})
        return parts
    stored = dict(result)
    stored["text"] = txt
    return stored


# Paths that are proxied to upstream (not static files)
PROXY_PREFIXES = (
    "/v1/", "/metrics", "/mcp", "/health", "/settings",
    "/config", "/approval/", "/workspace/", "/models", "/props", "/slots",
)

# ─── Static file types ───────────────────────────────────────────────────────────

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ico": "image/x-icon",
}


# ─── Model registry (shared with the parasitic server) ───────────────────────────
# ─── Workspace filesystem (shared with the parasitic server) ──────────────────────
def _workspace_fs():
    """serve/workspace_fs.py - the list/create/open helpers both server flavours use."""
    import sys as _sys
    serve_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "serve")
    if serve_dir not in _sys.path:
        _sys.path.insert(0, serve_dir)
    import workspace_fs
    return workspace_fs


def _workspace_root(state):
    # A standalone deployment has no run-config "workspace_root"; fall back to the project root,
    # which is where a direct-mode agent already writes by default.
    return getattr(state, "workspace_root", None) or ROOT


# ─── Workspace record: the base the MCP servers resolve relative paths against ────────────
# servers/fs_server.py and servers/shell_server.py re-read this file on EVERY tool call; the
# LAST absolute line is the base for relative paths and the shell's cwd. It used to be written
# as an append-only *union* of every workspace ever chosen and read only when it held EXACTLY
# ONE root -- so from the second workspace onward the base silently collapsed to this agent's
# own install dir and every relative path landed there (2026-10-20 report: `list 游戏开发/打砖块2`
# -> `strata-agent\游戏开发\打砖块2`, WinError 3, plus `shell_exec` running in strata-agent).
_ABS_PATH_RE = re.compile(r"^(?:[a-zA-Z]:[\\/]|[\\/]{2}|/)")


def _fs_allow_file() -> str:
    return os.environ.get("FS_ALLOW_FILE") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt")


def _recorded_workspaces() -> list[str]:
    try:
        with open(_fs_allow_file(), encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip()]
    except OSError:
        return []


def _norm_rel(s: str) -> str:
    return s.replace("\\", "/").strip("/").lower()


def _resolve_workspace(ws: str, root: str) -> str:
    """Best absolute form of a workspace reference (existence is NOT required).

    The composer can hold what the user typed ("打砖块2"), what the folder browser returned
    (absolute), or a partly relative form ("游戏开发/打砖块2"). A name that already appears
    as the tail of a recorded root is that root -- that is what makes legacy leaf/relative
    values resolve to the folder the user actually meant instead of to a new folder next to
    the agent.
    """
    ws = (ws or "").strip().strip('"')
    if not ws:
        return ""
    if _ABS_PATH_RE.match(ws):
        return os.path.abspath(ws)
    want = _norm_rel(ws)
    for r in reversed(_recorded_workspaces()):            # newest first
        if not _ABS_PATH_RE.match(r):
            continue
        tail = _norm_rel(r)
        if tail == want or tail.endswith("/" + want):
            return os.path.abspath(r)
    for base in (root, os.path.dirname(root), os.path.dirname(os.path.dirname(root))):
        cand = os.path.join(base, ws)
        if os.path.isdir(cand):
            return os.path.abspath(cand)
    return os.path.abspath(os.path.join(root, ws))


def _record_workspace(ws: str, root: str) -> str:
    """Make `ws` the CURRENT workspace (moved to the end) and return its absolute path.

    Move-to-end, not append-if-absent: switching BACK to a workspace that is already in the
    file left the previous one last, so the base stayed on the old folder. Written through a
    temp file + os.replace so a half-written record can never become the base.
    """
    ap = _resolve_workspace(ws, root)
    if not ap:
        return ""
    faf = _fs_allow_file()
    try:
        keep = [l for l in _recorded_workspaces() if l.lower() != ap.lower()]
        keep.append(ap)
        os.makedirs(os.path.dirname(faf) or ".", exist_ok=True)
        tmp = faf + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(keep) + "\n")
        os.replace(tmp, faf)
    except OSError:
        pass
    return ap


_WS_LINE_RE = re.compile(r"^[ \t]*Working directory:[^\n]*$", re.M)


def _ws_base_note(abs_ws: str) -> str:
    """What the model must know to stop guessing paths.

    The composer writes ``Working directory: <session.workspace>``, and a session that stored
    a leaf/relative name gives the model a path it cannot use -- it then invented
    ``游戏开发/打砖块2`` and both ``filesystem_list`` calls failed (2026-10-20).
    """
    return (f"【路径基准】当前工作目录的绝对路径是 {abs_ws} —— filesystem_* 与 shell_exec 的"
            f"相对路径都以它为基准；不要省略盘符或上级目录，否则会落到 Agent 自己的安装目录。"
            f"需要操作别处时请直接传绝对路径。")


def _with_workspace_hint(messages: list, abs_ws: str) -> list:
    """Rewrite the composer's `Working directory:` line with the ABSOLUTE path + base note.

    Rewritten in place (not appended as a second, contradictory system message) so the model
    sees one authoritative path. Purely additive when the composer sent no such line.
    """
    note = _ws_base_note(abs_ws)
    out, hit = [], False
    for m in messages:
        if (not hit and isinstance(m, dict) and m.get("role") == "system"
                and isinstance(m.get("content"), str) and _WS_LINE_RE.search(m["content"])):
            # lambda, not a template string: a Windows path is full of `\W`, `\n`-style
            # escapes that `re.sub` would interpret (it raises `bad escape \W`).
            c = _WS_LINE_RE.sub(lambda _m: "Working directory: " + abs_ws, m["content"], count=1)
            out.append({**m, "content": c + "\n" + note})
            hit = True
        else:
            out.append(m)
    if not hit:
        at = 1 if (out and isinstance(out[0], dict) and out[0].get("role") == "system") else 0
        out.insert(at, {"role": "system", "content": note})
    return out


def _model_registry():
    """serve/model_registry.py - the one list of models both server flavours read and write."""
    import sys as _sys
    serve_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "serve")
    if serve_dir not in _sys.path:
        _sys.path.insert(0, serve_dir)
    import model_registry
    return model_registry


def _route_model(model_id):
    """The entry a request is aimed at, when it points somewhere other than this gateway's upstream."""
    try:
        mr = _model_registry()
        entry = mr.find(mr.load(), model_id)
    except Exception:                                   # noqa: BLE001 - a broken file must not break chat
        return None
    if not entry:
        return None
    if not str(entry.get("base_url") or "").strip():
        return None                                     # "" = this gateway's own upstream: nothing to rewrite
    return entry


# ─── Endpoint liveness (what the model switcher shows) ──────────────────────────
# The model list is pure config. "kind: local" only means "this instance answers for that
# model" — it stays on paper when the 8080 engine is stopped, so the switcher used to claim
# a model was loaded long after the engine window was closed. A bare TCP connect is the
# cheapest honest answer; it is cached for a few seconds so a repaint never stalls on it.

_PROBE_TTL = 3.0
_probe_cache: dict = {}                                 # "host:port" -> (monotonic, ok)
_probe_lock = threading.Lock()


def _url_host_port(url: str):
    """(host, port) for a URL or a bare host:port; port defaults from the scheme."""
    raw = str(url or "").strip()
    if not raw:
        return None
    try:
        u = urlsplit(raw if "//" in raw else "//" + raw)
    except Exception:                                   # noqa: BLE001 - a malformed entry is simply "down"
        return None
    if not u.hostname:
        return None
    try:
        port = u.port or (443 if (u.scheme or "").lower() == "https" else 80)
    except ValueError:
        return None
    return u.hostname, port


def endpoint_alive(url: str, ttl: float = _PROBE_TTL) -> bool:
    """True when something accepts a TCP connection at url (cached for `ttl` seconds)."""
    hp = _url_host_port(url)
    if not hp:
        return False
    key = "%s:%d" % hp
    now = time.monotonic()
    with _probe_lock:
        hit = _probe_cache.get(key)
        if hit and (now - hit[0]) < ttl:
            return hit[1]
    try:
        with socket.create_connection(hp, timeout=0.4):
            ok = True
    except Exception:                                   # noqa: BLE001 - refused/timeout = not up
        ok = False
    with _probe_lock:
        _probe_cache[key] = (now, ok)
    return ok


_loaded_cache: dict = {}                                # "host:port" -> (monotonic, [model ids] | None)
_loaded_lock = threading.Lock()


def endpoint_models(url: str, ttl: float = _PROBE_TTL):
    """The model ids the endpoint says it serves (/v1/models), or None when it will not say.

    Two local entries can point at the SAME engine (one GPU, one port: s and xxs are mutually
    exclusive), so "the endpoint answers" is not the same as "this model is the loaded one".
    The engine's own answer is the only authority on that.
    """
    hp = _url_host_port(url)
    if not hp:
        return None
    key = "%s:%d" % hp
    now = time.monotonic()
    with _loaded_lock:
        hit = _loaded_cache.get(key)
        if hit and (now - hit[0]) < ttl:
            return hit[1]
    ids = None
    base = str(url or "").strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    try:
        req = urllib.request.Request(base + "/v1/models", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=1.5) as r:
            doc = json.loads(r.read().decode("utf-8", "replace"))
        ids = [str(x.get("id")) for x in (doc.get("data") or []) if isinstance(x, dict) and x.get("id")]
    except Exception:                                   # noqa: BLE001 - down / not OpenAI-shaped
        ids = None
    with _loaded_lock:
        _loaded_cache[key] = (now, ids)
    return ids


_health_ctx_cache: dict = {}
_health_ctx_lock = threading.Lock()


def endpoint_max_context(url: str, ttl: float = 60.0):
    """The engine's REAL context window, read from its own /health (cached for `ttl` seconds).

    The proactive-guard denominator used to be a hardcoded fallback (128K) that never learned
    the engine's real n_ctx (e.g. 256K) -- so a chat at 46% of the REAL window read as 92% here
    and the guard fired far too early (2026-10 report). Polls the SAME /health the frontend
    uses, so both sides agree on one number. None when the engine will not say.
    """
    hp = _url_host_port(url)
    if not hp:
        return None
    key = "%s:%d" % hp
    now = time.monotonic()
    with _health_ctx_lock:
        hit = _health_ctx_cache.get(key)
        if hit and (now - hit[0]) < ttl:
            return hit[1]
    n = None
    base = str(url or "").strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    try:
        req = urllib.request.Request(base + "/health", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=1.5) as r:
            doc = json.loads(r.read().decode("utf-8", "replace"))
        mc = doc.get("max_context")
        if isinstance(mc, (int, float)) and mc > 0:
            n = int(mc)
    except Exception:                                   # noqa: BLE001 - down / not JSON
        n = None
    with _health_ctx_lock:
        _health_ctx_cache[key] = (now, n)
    return n


# ─── Server State ────────────────────────────────────────────────────────────────

class UpstreamStalled(Exception):
    """The upstream accepted the request but then went silent for longer than the stall
    window. Raised instead of a raw socket timeout so the agent loop can report a graceful,
    resumable stop (`strata_notice` -> 继续) rather than a red error."""


class UpstreamHTTPError(Exception):
    """An HTTP error from the upstream (e.g. 8080 returned 400). Carries the status, the
    reason phrase and the response body so the agent loop can tell a *context-window overflow*
    (recoverable: tell the user to compact and continue) apart from a genuinely malformed
    request (still a real error)."""

    def __init__(self, status: int, reason: str = "", detail: str = ""):
        self.status = status
        self.reason = reason or ""
        self.detail = detail or ""
        super().__init__(f"HTTP {status}: {self.reason} {self.detail}".strip())


def _is_context_overflow(text: str) -> bool:
    """True when the upstream refused because the prompt is too long for its fixed context window
    (Strata: 'request exceeds the context window ... requests are never truncated', HTTP 400)."""
    t = (text or "").lower()
    return ("context window" in t or "exceeds the context window" in t
            or "request exceeds" in t or "never truncated" in t)

def _degrade_image_blocks(messages):
    """[VISION-DEGRADE 2026-10-31] Return a copy of `messages` with every image_url content
    block replaced by a plain-text placeholder sentence, so a turn whose image the upstream
    refused to decode (small quantized vision model) can be re-sent as text-only instead of
    silently dropping the picture. Text blocks are kept; only image blocks become placeholder.
    """
    _PLACEHOLDER = "[图片无法被上游解析，已降级为纯文本重试]"
    out = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            newc = []
            for b in c:
                if isinstance(b, dict) and b.get("type") == "image_url":
                    newc.append({"type": "text", "text": _PLACEHOLDER})
                else:
                    newc.append(b)
            out.append({**m, "content": newc})
        else:
            out.append(m)
    return out

def _is_vision_failure(err) -> bool:
    """True when an upstream error is specifically about an image it could not read/decode
    (NOT a context-overflow or a generic failure) -- the trigger for the text-placeholder
    single degrade resend. Kept narrow so it never hijacks a normal overflow/failed turn."""
    t = str(err).lower()
    return ("image" in t and ("could not be read" in t or "cannot read" in t
                              or "decode" in t or "invalid image" in t))


def _except_vision_resend(e, msg, budget_left: bool) -> bool:
    """[VISION-DEGRADE 2026-10-31] The HTTP-400 path: the engine refuses the request so the
    error arrives as an EXCEPTION from _llm_stream, not as an SSE data chunk the inner-loop
    predicate can see. Decide whether THIS 400 is a vision failure we recover by re-sending
    with image blocks as text. Narrow: context-overflow 400s and generic 400s never hijack."""
    return (isinstance(e, UpstreamHTTPError) and e.status == 400
            and budget_left and _is_vision_failure(msg))


def tool_failure_text(err, tool: str) -> str:
    """Turn a raised tool failure into a result the MODEL can act on.

    A tool call is one step of a turn, not the whole turn. `executor._req` raises ToolError on a
    per-command timeout, a cancelled call and a dead MCP child; before this, that exception
    escaped `_agent_stream` and killed the SSE stream without a terminator, so the UI could only
    say "连接中断" and the turn's entire plan was lost (2026-10-20 report: a 6m08s / 23-tool turn
    died on a `python build.py && ...` command). Now the failure becomes an ordinary failed tool
    result: the model sees it and can split the command or switch approach.
    """
    msg = str(err) or err.__class__.__name__
    low = msg.lower()
    if "timed out" in low:
        hint = ("这次调用超过了单命令时限，进程已被杀掉。请把它拆成更小的步骤分别执行"
                "（例如先跑构建，再单独做语法检查），或传一个更大的 timeout 参数后重试一次；"
                "不要原样重复同一条命令。")
    elif "died" in low or "not alive" in low or "dead" in low:
        hint = "该工具所在的服务进程已退出，这个工具暂时不可用。请改用其它工具或换一种方式完成。"
    elif "cumulative budget" in low or "server timeout" in low:
        hint = "该服务本轮的累计耗时已到上限。请换用其它服务，或让用户点「继续」后再试。"
    elif "cancelled" in low:
        hint = "这次调用被用户停止了。"
    else:
        hint = "工具执行出错。请判断是否需要换一种方式，或把操作拆小后重试。"
    return f"error: {tool} failed: {msg}\n[system] {hint}"


# ─── Local hardware reader (custom-mode Monitor fallback) ──────────────────────────
# When a custom model reasons on a SEPARATE instance, the gateway cannot ask that box about
# its GPU — 8080 only ever sees its OWN machine. The Monitor should show what is in front of
# the user on THIS box, so the gateway reads its own hardware and says so. Pure stdlib (the
# gateway imports nothing new): nvidia-smi runs as a subprocess with a cached result so the
# 1 Hz poll never stalls on it; anything unmeasurable (CPU/RAM/disk without psutil) stays
# absent, so the existing frontend shows a dash, not a lie.
_HW_CACHE = None
_HW_DISK_PREV = None  # (time_monotonic, read_bytes, write_bytes) for disk rate differential                          # (monotonic, result) | None — matches the other TTL caches
_HW_CACHE_TTL = 3.0                       # seconds
_HW_LOCK = threading.Lock()
# One nvidia-smi query returns all of these; the CSV column order is locked by
# tests/test_local_metrics_fallback.py so a field rename cannot silently shift the parser.
_HW_SMI_FIELDS = ("index", "name", "utilization.gpu", "memory.used", "memory.total",
                  "temperature.gpu", "power.draw", "power.limit",
                  "pcie.link.gen.current", "pcie.link.width.current")
_HW_SMI_TIMEOUT = 2.0                     # nvidia-smi cold-start is sub-second; 2s is the ceiling


def _smi_num(v):
    """One nvidia-smi CSV cell -> int/float, or None for [N/A] and anything unparsable."""
    try:
        n = float(v)
    except ValueError:
        return None
    return int(n) if n.is_integer() else n


def _read_nvidia_gpu():
    """One nvidia-smi subprocess -> rows of {field: number}. [] on ANY failure (no driver, no
    binary, non-zero exit, unparsable). A GPU-less host and a dead one both read as no rows."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    try:
        out = subprocess.run(
            [exe, "--query-gpu=" + ",".join(_HW_SMI_FIELDS), "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=_HW_SMI_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return []
    if out.returncode != 0:
        return []
    rows = []
    for line in out.stdout.splitlines():
        parts = [p.strip() for p in line.strip().split(",")]
        if len(parts) != len(_HW_SMI_FIELDS):
            continue
        # name is a STRING field (the CSV column is locked by the test); keep it raw,
        # parse only the numeric columns -- float("NVIDIA GeForce RTX ...") would None it.
        rows.append({k: (v if k == "name" else _smi_num(v))
                     for k, v in zip(_HW_SMI_FIELDS, parts)})
    return rows


def _read_local_hardware():
    """This box's hardware in the frontend's own field shape (renderMonitor unchanged).

    Field names match what 8080 already sends (gpus[] rows + gpu_util/mem/temp/power/pcie on
    the flat top). nvidia-smi reports VRAM in MiB; the frontend divides bytes by 1048576, so
    the values are scaled there, not here. CPU/RAM/disk stay absent — no psutil on this box,
    so inventing them would be the lie the honesty rule forbids. Cached so a 1 Hz poll does
    not fork a subprocess every tick."""
    global _HW_CACHE
    now = time.monotonic()
    with _HW_LOCK:
        if _HW_CACHE is not None and (now - _HW_CACHE[0]) < _HW_CACHE_TTL:
            return _HW_CACHE[1]
    gpus = _read_nvidia_gpu()
    hw, hst = {}, {}
    if gpus:
        def gib(n):
            return n * 1048576 if n is not None else None
        hw["gpus"] = [{"index": g["index"], "util": g["utilization.gpu"],
                       "mem_used": gib(g["memory.used"]), "mem_total": gib(g["memory.total"]),
                       "temp": g["temperature.gpu"]} for g in gpus]
        g0 = gpus[0]
        if g0["utilization.gpu"] is not None:
            hw["gpu_util"] = g0["utilization.gpu"]
        if g0["memory.used"] is not None:
            hw["gpu_mem_used"] = gib(g0["memory.used"])
        if g0["memory.total"] is not None:
            hw["gpu_mem_total"] = gib(g0["memory.total"])
        if g0["temperature.gpu"] is not None:
            hw["gpu_temp"] = g0["temperature.gpu"]
        if g0["power.draw"] is not None:
            hw["gpu_power"] = g0["power.draw"]
        if g0["power.limit"] is not None:
            hw["gpu_power_limit"] = g0["power.limit"]
        if g0["pcie.link.gen.current"] is not None:
            # renderMonitor reads gpu_pcie_gen_max for the headline (and gpu_pcie_gen for the idle hint)
            hw["gpu_pcie_gen_max"] = g0["pcie.link.gen.current"]
        if g0["pcie.link.width.current"] is not None:
            hw["gpu_pcie_width"] = g0["pcie.link.width.current"]
        if g0["name"]:
            hst["gpu_name"] = g0["name"]
    ps = _read_psutil_hw()
    if ps:
        hw.update(ps)
    result = {"hardware": hw, "hardware_static": hst}
    with _HW_LOCK:
        _HW_CACHE = (now, result)
    return result

def _read_psutil_hw():
    """CPU%, RAM (bytes), Disk read/write (MB/s) from psutil. Any field that psutil
    cannot measure is left absent (honesty). Called inside _read_local_hardware."""
    out = {}
    if psutil is None:
        return out
    # CPU percent (first call is 0 as it primes; subsequent calls give real value)
    # One try, not three: if any psutil call raises (no permission / unsupported
    # platform) we return whatever was collected so far -- a real action, exactly the
    # honesty rule the docstring promises (read it or stay absent, never invent).
    global _HW_DISK_PREV
    try:
        out["cpu"] = round(psutil.cpu_percent(interval=None), 1)  # first call primes to 0
        vm = psutil.virtual_memory()  # bytes; frontend divides by 1048576 for display
        out["ram_total"] = vm.total
        out["ram_used"] = vm.used
        dio = psutil.disk_io_counters()  # I/O rate via differential; first sample primes
        now = time.monotonic()
        if _HW_DISK_PREV is not None:
            prev_t, prev_r, prev_w = _HW_DISK_PREV
            dt = now - prev_t
            if dt > 0:
                out["disk_read_mb"] = round((dio.read_bytes - prev_r) / dt / 1048576, 1)
                out["disk_write_mb"] = round((dio.write_bytes - prev_w) / dt / 1048576, 1)
        _HW_DISK_PREV = (now, dio.read_bytes, dio.write_bytes)
    except Exception:
        return out  # the psutil field(s) that raised stay absent; keep the ones we read
    return out

class GatewayState:
    """Shared mutable state for the gateway HTTP server."""

    def __init__(self, upstream_url: str, model: str = "strata", api_key: Optional[str] = None,
                 config_path: Optional[str] = None, skills_dir: Optional[str] = None):
        self.upstream_url = upstream_url.rstrip("/")  # full upstream base (e.g. http://127.0.0.1:8080)
        self.model = model
        self.api_key = api_key
        self.executor = None           # optional: gateway's own executor for direct mode
        self.direct_mode = False       # when True, gateway runs its own agent loop (MCP) instead of transparent proxy
        self.max_rounds = 1000          # agent loop round cap in direct mode (a coding turn with
                                       # dozens of file writes legitimately needs many rounds)
        self.turn_budget_s = 3600      # ABSOLUTE ceiling for a single turn (runaway guard only).
                                       # It used to be 600s, which killed real coding turns in
                                       # the middle of writing files -- see idle_timeout_s.
        self.idle_timeout_s = 180      # STALL watchdog: no token and no tool activity for this
                                       # long -> the turn is wedged / the upstream is dead, stop.
                                       # Time is refreshed on every sign of progress, so a slow
                                       # but productive turn is never cut off.
        self.approval_pending = {}
        self.verifier = None           # self-test gate, wired by gateway main()
        self.max_verify_retries = 0    # 0 => gate off; gateway sets it from config.verify     # id -> {event, decision} (for gateway's own agent loop)
        self.settings = {}             # runtime settings (gateway override)
        self.start_time = time.time()
        self.request_count = 0
        self.lock = threading.Lock()
        # Management API: the files the registry edits. Both are the ones the gateway
        # itself was started with, so an edit followed by a reload is self-consistent.
        self.config_path = config_path
        self.skills_dir = skills_dir
        self.registry = None           # built in run_server (needs an audit log)
        # Active streaming chats: id -> threading.Event that is set when the client asks
        # to stop (or disconnects). The agent loop and the upstream-reader thread watch it
        # so a Stop click truly cancels inference + tool execution instead of running empty.
        self._streams = {}
        self._streams_lock = threading.Lock()
        # Context-window awareness for the agent loop. `last_prompt_tokens` is tracked PER CONVERSATION
        # (keyed by the frontend's session id) — NOT as a single server-global — because the gateway is a
        # long-lived process that serves many workspaces/tasks. A single global value leaks the previous
        # task's occupancy into a brand-new (empty) task, so the proactive guard below would fire a bogus
        # "context 92%" notice on the very first turn of a fresh conversation. Keying per session makes the
        # guard meaningful: it only ever compares a conversation's OWN previous turn against the ceiling.
        # `max_context` defaults to the 8080 engine's n_ctx and can be overridden via STRATA_MAX_CONTEXT.
        self._prompt_tokens_by_session = {}   # session_id -> last reported prompt_tokens
        self._session_order = []              # insertion order for cap/eviction
        self._session_cap = 64                # bound the dict so it can't grow forever
        self._empty_streak = {}               # session_id -> (consecutive empty rounds, last ts)
        # max_context is now the FALLBACK only; the real number is polled via ctx_window() below.
        # STRATA_MAX_CONTEXT, when set, is an explicit user override and always wins.
        self._ctx_env = os.environ.get("STRATA_MAX_CONTEXT")
        self.max_context = int(self._ctx_env) if self._ctx_env else 131072
        # Tool-result history cap (Loop B): bounds each tool result stored in the live
        # history, matching Loop A's SessionMemory cap so the Web path no longer diverges.
        self.tool_result_cap = 10000
        self.tool_head_lines = 15
        self.tool_tail_lines = 15
        self.tool_keep_recent = 2      # never cap the most recent N tool results (same-turn chains)
        self.tool_log_dir = None
        # Step2-A: lightweight request monitor — always on by default, low-overhead sampling.
        # Records a per-chunk timeline (chunk_timeline) of streamed responses so the streaming
        # debug suite can see, chunk by chunk, exactly what happened and where a turn broke.
        # Bounded in memory (100 records); holds no headers or API keys.
        self.api_monitor = True
        self.api_monitor_full = False   # "full" = 256K I/O retention (opt-in via --api-monitor / config)
        self._mon_io_cap = 16384        # truncated input/output cap for the lightweight record
        self.api_requests = collections.deque(maxlen=100)
        self.status_lock = threading.Lock()
        # Fusion gate between the scheduler host thread and live interactive turns.
        # `_active` counts concurrent agent turns (each interactive request, no cap);
        # `_idle` is set when `_active` reaches 0. A scheduled job blocks on `_idle.wait()`
        # so it queues behind interactive work (the chosen default) and never overlaps it.
        self._active = 0
        self._idle = threading.Event()
        self._idle.set()
        # B1 session_stream broadcaster: scheduler-thread token deltas fan out to
        # every live /api/session-stream subscriber (one queue each). A slow/stalled
        # client whose queue fills is skipped, so broadcast NEVER blocks the scheduler.
        self._subscribers = []
        self._subscribers_lock = threading.Lock()

    def subscribe_stream(self) -> "queue.Queue":
        q = queue.Queue(maxsize=1000)
        with self._subscribers_lock:
            self._subscribers.append(q)
        return q

    def unsubscribe_stream(self, q) -> None:
        with self._subscribers_lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                print("  [session-stream] unsubscribe: queue already gone", file=sys.stderr)

    def broadcast_stream(self, obj) -> None:
        """Push one event to every subscriber; drop for a subscriber whose queue is
        full so a stalled client can never block the scheduler thread."""
        with self._subscribers_lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(obj)
            except queue.Full:
                print(f"  [session-stream] subscriber queue full, dropped event "
                      f"{obj.get('session_name')}", file=sys.stderr)

    def ctx_window(self, entry=None):
        """ONE denominator for the whole gateway: a per-model DECLARED window > explicit env
        override > the engine's real n_ctx (polled from its own /health) > the hardcoded fallback.

        A `custom` model whose endpoint never answers /health in JSON (cloud APIs, and the 47831
        front-instance that returns HTML) cannot be polled for n_ctx, so it declares its window in
        model_registry (context_window / native_ctx). A per-model declaration is the more specific
        statement about THIS model, so it wins over the machine-wide env override."""
        if isinstance(entry, dict):
            for k in ("context_window", "native_ctx"):
                v = entry.get(k)
                if isinstance(v, (int, float)) and v > 0:
                    return int(v)
        if self._ctx_env:
            return int(self._ctx_env)
        return endpoint_max_context(self.upstream_url) or self.max_context

    # ── Request monitor (Step2-A) ───────────────────────────────────────────────
    def begin_request(self, path, req):
        """Create a monitor record for a request and append it to the bounded ring.

        The record carries a per-chunk timeline (chunk_timeline) of the streamed response so the
        debugging suite can replay where a turn broke. Returns the record (also stored on the
        handler as self.record) or None when the monitor is off."""
        if not self.api_monitor:
            return None
        cap = getattr(self, "_mon_io_cap", 16384)
        if not isinstance(req, dict):
            req = {}
        raw = json.dumps(req, ensure_ascii=False, indent=2)
        record = {"id": uuid.uuid4().hex[:12], "path": path,
                  "model": req.get("model") or self.model,
                  "session_id": req.get("strata_session") or req.get("session_id") or None,
                  "started_at": time.time(), "state": "queued",
                  "stream": bool(req.get("stream")),
                  "input": raw[:cap], "input_truncated": len(raw) > cap,
                  "output": "", "reasoning": "", "output_truncated": False, "reasoning_truncated": False,
                  "chunk_timeline": [], "chunk_timeline_truncated": False,
                  "queue_s": 0.0, "load_s": 0.0, "first_token_s": None,
                  "_clock": time.perf_counter()}
        with self.status_lock:
            self.api_requests.append(record)
        return record

    def aggregate_local_metrics(self, now=None):
        """Local fallback for GET /metrics when the upstream is unreachable (custom mode).

        The Monitor page renders from one JSON contract (the 8080 engine's own /metrics).
        When a custom model is selected the agent loop runs HERE, so the gateway owns the
        only real data there is: the api_requests ring (begin_request) and its per-chunk
        timelines. This maps that ring onto the frontend's field shape so the Monitor lights
        up. Honest-by-construction: a field is filled only when real data backs it.

        * live.state / state badges / progress  <- last chunk_timeline event type (real)
        * recent-requests table                 <- per-record start/finish/duration/first-token (real)
        * context ring, speed, prefill          <- only when a usage chunk carried token counts
        * hardware cards (VRAM/temp/PCIe/CPU/disk) stay null: the gateway measures only its OWN
          box, and the custom model reasons on a SEPARATE instance whose GPU it cannot see.
        Returns a dict the frontend renderMonitor can consume unchanged.
        """
        import time as _t
        now = now if now is not None else _t.time()
        with self.status_lock:
            recs = [dict(r) for r in self.api_requests]

        # 事件类型 -> 前端 live.state（thinking 借用 reading 视觉态，与 paintCustomPill 一致）
        type_to_state = {"content": "generating", "thinking": "reading",
                         "tool_call": "generating", "tool_result": "reading",
                         "tool_progress": "generating", "usage": "generating",
                         "error": "error", "stopped": "idle"}
        idle_after_s = 5.0   # 最新事件距今超过此值视为空闲（无活跃 turn）

        def last_event_type(rec):
            tl = rec.get("chunk_timeline") or []
            return tl[-1]["type"] if tl else None

        def first_token_s(rec):
            if rec.get("first_token_s") is not None:
                return rec.get("first_token_s")
            tl = rec.get("chunk_timeline") or []
            for e in tl:
                if e["type"] in ("content", "thinking", "tool_call"):
                    return e["t"]
            return None

        def usage_tokens(rec):
            for e in (rec.get("chunk_timeline") or []):
                if e["type"] == "usage":
                    # usage 事件仅记 bytes，不含 token；custom 端点若不回 usage 结构则拿不到真 token
                    if e.get("tok"):                                  # A1 real (prompt,output,cached)
                        return e["tok"][0], e["tok"][1]
                    return e.get("prompt_tokens"), e.get("output_tokens")
            return None, None

        def decode_speed(rec):
            # (value, est_bool). REAL usage output-tokens / real content-phase span when the
            # upstream carried usage; else an honest byte/5.1 estimate tagged est=True so the
            # UI prefixes it with a ≈. Never invents a number when there is no data.
            tl = rec.get("chunk_timeline") or []
            evs = [e for e in tl if e["type"] == "content" and e.get("t") is not None]
            if len(evs) < 2:
                return None, False
            span = evs[-1]["t"] - evs[0]["t"]
            if span <= 0.5:
                return None, False
            usage = [e for e in tl if e["type"] == "usage" and e.get("tok")]
            if usage:
                ot = (list(usage[-1]["tok"]) + [None, None, None])[1]
                if ot:
                    return round(ot / span, 1), False
            total = sum(int(e.get("bytes") or 0) for e in evs)
            if total <= 0:
                return None, False
            return round((total / 5.1) / span, 1), True

        def hit_rate_of(rec):
            # reused/prompt from the real usage tuple only; honest None when usage is absent.
            for e in (rec.get("chunk_timeline") or []):
                if e["type"] == "usage" and e.get("tok"):
                    pt, _ot, cached = (list(e["tok"]) + [None, None, None])[:3]
                    if pt and cached:
                        return round(cached / pt, 4)
            return None

        def engine_block(rec):
            # A4: ONLY the model_registry-declared window for THIS custom model (its real
            # denominator). No 8080 fallback — on the custom path the engine is a different box.
            try:
                ent = _route_model((rec or {}).get("model"))
                win = (ent or {}).get("context_window") or (ent or {}).get("native_ctx") or 0
                return {"max_context": int(win)} if win else {}
            except Exception:
                return {}

        live = {"state": "idle", "queued": 0}
        live["first_token_s"] = None
        requests_out = []
        for r in reversed(recs):   # frontend treats requests[0] as the MOST RECENT
            et = last_event_type(r)
            finish = {"done": "done", "[DONE]": "done", "error": "error", "stopped": "cancel"}.get(et, et)
            pt, ot = usage_tokens(r)
            _ds = decode_speed(r)
            requests_out.append({
                "time": r.get("started_at"),
                "finish": finish,
                "prompt_tokens": pt,
                "reused": 0,
                "output_tokens": ot,
                "prompt_ms": None,
                "decode_tok_s": _ds[0],
                "est": _ds[1],
                "hit_rate": hit_rate_of(r),
                "duration_s": r.get("duration_s", r.get("wallclock_s")),
                "first_token_s": first_token_s(r),
            })

        newest = recs[-1] if recs else None
        if newest is not None:
            ft = first_token_s(newest)
            live["first_token_s"] = ft
            et = last_event_type(newest)
            # 距最新事件的时间差用 timeline 末尾 t（相对 _clock 的秒）近似新鲜度
            tl = newest.get("chunk_timeline") or []
            last_t = tl[-1]["t"] if tl else None
            fresh = (last_t is not None and last_t < idle_after_s)
            if et and fresh:
                live["state"] = type_to_state.get(et, "idle")
            # token 真值（仅 usage 携带时）
            pt, ot = usage_tokens(newest)
            if pt is not None:
                live["prompt_tokens"] = pt
            if ot is not None:
                live["generated"] = ot

        hw_local = _read_local_hardware()
        return {
            "live": live,
            "hardware": hw_local["hardware"],
            "hardware_static": hw_local["hardware_static"],
            "engine": engine_block(newest),
            "history": {},
            "requests": requests_out,
            "totals": None,
            "requests_kept": len(requests_out),
            "conversation_cache": None,
            "source": "local",          # 标记来源，供未来 UI 标注用（现不改前端）
        }
    def request_records(self, request_id=None):
        """GET /api/requests: the most recent records (newest first), or one by id. Internal
        keys (starting with _) are stripped so the wire shape never leaks the perf clock."""
        with self.status_lock:
            records = list(self.api_requests)
            if request_id:
                record = next((r for r in records if r["id"] == request_id), None)
                if record is None:
                    return None
                return {k: v for k, v in record.items() if not k.startswith("_")}
            return [{k: v for k, v in r.items()
                     if k not in ("input", "output", "reasoning") and not k.startswith("_")}
                    | {"wallclock_s": r.get("wallclock_s", round(time.perf_counter() - r["_clock"], 3))}
                    for r in reversed(records)]

    # ── Per-session context tracking ────────────────────────────────────────────
    def record_prompt_tokens(self, session_id, n):
        if not session_id or not n:
            return
        if session_id not in self._prompt_tokens_by_session:
            self._session_order.append(session_id)
            if len(self._session_order) > self._session_cap:
                old = self._session_order.pop(0)
                self._prompt_tokens_by_session.pop(old, None)
        self._prompt_tokens_by_session[session_id] = n

    def prompt_tokens_for(self, session_id):
        # Unknown / new session (never reported usage) -> 0, so a fresh task never trips the guard.
        return self._prompt_tokens_by_session.get(session_id, 0) or 0

    def reset_prompt_tokens(self, session_id):
        # Drop the tracked occupancy for a conversation that is about to be *compacted*. A compact
        # replaces the whole history with a short summary, so the old (near-full) count is no longer
        # true. Resetting (not recording) lets the post-compact turn report the real (small) prompt.
        # Without this, the proactive 92% guard would re-trip on every turn after a compact and wedge
        # the chat permanently -- the only escape (a compact request) was itself blocked by that guard.
        self._prompt_tokens_by_session.pop(session_id, None)

    # ── Consecutive empty rounds, per conversation ──────────────────────────────
    # An empty round ENDS the turn (the model produced no text and no tool call), so the next
    # attempt is a fresh request -- a per-request counter would always read 1 and never notice
    # the loop. Tracking it per session lets the gateway tell the user "this is the second time
    # in a row, change a setting" instead of inviting another identical retry.
    def note_empty_round(self, session_id, window_s=600):
        now = time.monotonic()
        prev_n, prev_t = self._empty_streak.get(session_id, (0, 0.0))
        n = prev_n + 1 if (now - prev_t) <= window_s else 1
        self._empty_streak[session_id] = (n, now)
        if len(self._empty_streak) > self._session_cap:
            for k in list(self._empty_streak)[:32]:
                if k != session_id:
                    self._empty_streak.pop(k, None)
        return n

    def clear_empty_streak(self, session_id):
        self._empty_streak.pop(session_id, None)

    # ── Stream cancellation registry ─────────────────────────────────────────────
    # -- Interactive-busy gate (fusion: scheduler queues behind live turns) --
    def begin_interaction(self) -> None:
        """Mark one live agent turn as started. Never blocks (interactive has priority)."""
        with self.lock:
            self._active += 1
            self._idle.clear()

    def end_interaction(self) -> None:
        """Mark a live agent turn as finished; when the last one ends, release the gate so
        any scheduled job queued on _idle.wait() can proceed."""
        with self.lock:
            self._active = max(0, self._active - 1)
            if self._active == 0:
                self._idle.set()

    def register_stream(self, stream_id: Optional[str]):
        """Create a cancel Event for a stream. If stream_id is None, returns an unregistered
        local Event (still usable for disconnect detection, just not addressable by /api/chat/stop)."""
        ev = threading.Event()
        if stream_id:
            with self._streams_lock:
                self._streams[stream_id] = ev
        return ev

    def cancel_stream(self, stream_id: Optional[str]) -> bool:
        """Signal cancellation for a stream id. Returns True if the id was known."""
        if not stream_id:
            return False
        with self._streams_lock:
            ev = self._streams.get(stream_id)
        if ev is not None:
            ev.set()
            return True
        return False

    def unregister_stream(self, stream_id: Optional[str]):
        if stream_id:
            with self._streams_lock:
                self._streams.pop(stream_id, None)


# ─── HTTP Request Handler ────────────────────────────────────────────────────────

class GatewayHandler(BaseHTTPRequestHandler):
    """Static file server + transparent reverse proxy to upstream."""

    state: GatewayState = None  # injected at startup

    def log_message(self, format, *args):
        pass  # quiet

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_PUT(self):
        self.state.request_count += 1
        if not self._api("PUT"):
            self._json(404, {"error": {"type": "not_found", "message": "no route"}})

    def do_DELETE(self):
        self.state.request_count += 1
        if not self._api("DELETE"):
            self._json(404, {"error": {"type": "not_found", "message": "no route"}})

    # ─── Routing: proxy vs static ─────────────────────────────────────────────────
    STATIC_EXTS = frozenset((".html", ".htm", ".css", ".js", ".svg", ".png", ".jpg",
                              ".woff2", ".woff", ".ico", ".json", ".ttf", ".woff"))

    def _is_api(self, path: str) -> bool:
        """Check if this path should be proxied to upstream."""
        p = path.split("?")[0]  # strip query string
        # If the path has a known static file extension, serve it as static (not proxy)
        _, ext = os.path.splitext(p)
        if ext.lower() in self.STATIC_EXTS and ext != "":
            return False
        return any(p == prefix.rstrip("/") or p.startswith(prefix) for prefix in PROXY_PREFIXES)

    # ─── GET ──────────────────────────────────────────────────────────────────────
    def do_GET(self):
        self.state.request_count += 1
        path = self.path.split("?")[0]

        if path.startswith("/api/"):
            self._api("GET")
            return

        # Direct mode: expose the gateway's own MCP servers to the frontend.
        if path == "/mcp" and self.state.direct_mode and self.state.executor and self.state.executor.tools:
            self._json(200, self._mcp_status())
            return

        # Workspace folder browser: local in direct mode, proxied upstream otherwise.
        if path == "/workspace/list" and self.state.direct_mode:
            self._workspace_list()
            return

        # Model registry: the frontend reads/writes it at /models/config (and probes at
        # /models/test); the gateway keeps the same data under /api/models. Bridge them so
        # the composer's model switcher works without depending on the upstream Strata host.
        if path in ("/models/config",) and self.state.direct_mode:
            self._api_models("GET", "/api/models")
            return

        # ── local /health: forward upstream response then patch image_generation from our own config
        if path == "/health":
            self._local_health()
            return
        if self._is_api(path):
            self._proxy("GET")
        else:
            self._serve_static(path)

    # ─── POST ─────────────────────────────────────────────────────────────────────
    def do_POST(self):
        self.state.request_count += 1
        path = self.path.split("?")[0]

        if path.startswith("/api/"):
            self._api("POST")
            return

        # Workspace folder browser / create / open: local in direct mode, proxied upstream otherwise.
        if path == "/workspace/list" and self.state.direct_mode:
            self._workspace_list()
            return
        if path in ("/workspace/create", "/workspace/open") and self.state.direct_mode:
            self._workspace_mutate(path)
            return

        # Model registry write + probe, and manual tool invocation (Tools tab). Local in
        # direct mode; in proxy mode these fall through to the upstream Strata host.
        if path == "/models/config" and self.state.direct_mode:
            self._api_models("POST", "/api/models")
            return
        if path == "/models/test" and self.state.direct_mode:
            self._api_models("POST", "/api/models/test")
            return
        if path == "/mcp/call" and self.state.direct_mode:
            self._mcp_call()
            return

        if path == "/v1/images/generations":
            self._handle_image_gen()
            return
        if path == "/v1/chat/completions":
            payload = self._cached_json()
            entry = _route_model(payload.get("model")) if isinstance(payload, dict) else None
            tools_here = bool(self.state.executor and self.state.executor.tools)
            # an external endpoint cannot run our tools -> our loop (when we have one); a sibling instance
            # speaks our protocol and runs its own, so it is a plain proxy either way
            if entry is not None and entry.get("kind") == "custom" and tools_here:
                self._model_override = entry
                self._agent_stream(body=payload)
                return
            if entry is None and self.state.direct_mode and tools_here:
                self._agent_stream(body=payload)
                return
            self._proxy("POST")
            return

        if self._is_api(path):
            self._proxy("POST")
        else:
            self._json(404, {"error": {"type": "not_found", "message": "no route"}})

    # ─── Transparent proxy (streaming-aware) ─────────────────────────────────────
    def _proxy(self, method: str):
        """Forward the request to the upstream server. Supports SSE streaming."""
        upstream = self.state.upstream_url
        # Handle path overlap: if upstream already ends with /v1, strip it from the request path
        req_path = self.path
        if req_path.startswith("/v1") and upstream.endswith("/v1"):
            req_path = req_path[3:]  # avoid /v1/v1/...
        url = f"{upstream}{req_path}"

        body = None
        if method == "POST":
            if getattr(self, "_raw_body", None) is not None:      # already read for the routing decision
                body = self._raw_body
            else:
                length = int(self.headers.get("Content-Length", 0))
                if length:
                    body = self.rfile.read(length)

        # A model that lives elsewhere: send this request to its base_url with its own model name.
        target = None
        if method == "POST" and body and req_path.split("?")[0].rstrip("/").endswith("/chat/completions"):
            try:
                payload = json.loads(body.decode("utf-8", "replace"))
            except Exception:
                payload = None
            if isinstance(payload, dict):
                target = _route_model(payload.get("model"))
                if target is not None:
                    base = str(target.get("base_url") or "").rstrip("/")
                    url = base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")
                    payload["model"] = target.get("model") or payload.get("model")
                    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(url, data=body, method=method)
        # Forward Content-Type from client
        ct = self.headers.get("Content-Type")
        if ct:
            req.add_header("Content-Type", ct)
        else:
            req.add_header("Content-Type", "application/json")

        # Forward Authorization - the entry's own key wins, it belongs to that endpoint
        auth = self.headers.get("Authorization")
        if target is not None:
            if target.get("api_key"):
                req.add_header("Authorization", "Bearer " + str(target["api_key"]))
        elif auth:
            req.add_header("Authorization", auth)
        elif self.state.api_key:
            req.add_header("Authorization", f"Bearer {self.state.api_key}")

        try:
            resp = urllib.request.urlopen(req, timeout=600)
            resp_ct = resp.headers.get("Content-Type", "application/json")

            if "text/event-stream" in resp_ct:
                # ── SSE streaming: forward line-by-line for real-time delivery ──
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                try:
                    for line in resp:  # readline-style iteration; yields each SSE line
                        if not line:
                            break
                        self.wfile.write(line)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    # client went away — stop pulling from upstream so it stops generating,
                    # instead of letting it run to completion into a closed pipe.
                    try:
                        resp.close()
                    except Exception:
                        pass
            else:
                # ── Buffered response ──
                resp_body = resp.read()
                self.send_response(resp.status)
                self._cors()
                self.send_header("Content-Type", resp_ct)
                self.send_header("Content-Length", str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)

        except urllib.error.HTTPError as e:
            resp_body = e.read()
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            # custom mode: the agent loop runs HERE, so when the upstream is unreachable the
            # Monitor page can only be fed by this gateway's own request ring. GET /metrics gets a
            # local aggregate (renderMonitor consumes it unchanged); every other path keeps 502.
            if method == "GET" and self.path.split("?")[0].rstrip("/") == "/metrics":
                self._json(200, self.state.aggregate_local_metrics())
                return
            self._json(502, {"error": {"type": "bad_gateway", "message": f"upstream unreachable: {e}"}})

    # ─── Static file serving ───────────────────────────────────────────────────────
    def _serve_static(self, path: str):
        # Strip leading slash for path resolution. 2026-11-12: unquote first so a
        # CJK filename the browser sends percent-encoded matches the real name on disk.
        clean = unquote(path.split("?")[0]).lstrip("/")

        # Route map
        if clean in ("", "index.html"):
            filepath = Path(WEB_DIR) / "index.html"
        elif clean.startswith("web/"):
            # The frontend references sprite.svg etc. with "web/" prefix
            rel = clean[4:]  # strip "web/"
            filepath = Path(WEB_DIR) / rel.lstrip("/")
        elif clean.startswith("fonts/"):
            filepath = Path(WEB_DIR) / clean
        elif clean.startswith("data/uploads/"):
            # search-download images land in ROOT/data/uploads (OUTSIDE the web root).
            # Map the URL prefix to that real drop-point so the frontend can inline them.
            rel = clean[len("data/uploads/"):]
            filepath = Path(ROOT) / "data" / "uploads" / rel.lstrip("/")
        elif clean.startswith("data/saved_images/"):
            # [img gallery 2026-11-15] saved copies land in ROOT/data/saved_images (OUTSIDE the web root)
            rel = clean[len("data/saved_images/"):]
            filepath = Path(ROOT) / "data" / "saved_images" / rel.lstrip("/").replace("\\", "/")
        elif clean.startswith("data/generated/"):
            # generated images live in ROOT/data/generated (OUTSIDE the web root).
            rel = clean[len("data/generated/"):]
            if PREVIEWS_DIR != os.path.join(ROOT, "data", "generated", "previews") \
                    and rel.replace("\\", "/").startswith("previews/"):
                # [FIX 2026-11-14] 预览子目录被 ASCII 改道时，URL 不变、物理路径映射过去
                filepath = Path(PREVIEWS_DIR) / rel[len("previews/"):].lstrip("/")
            else:
                filepath = Path(ROOT) / "data" / "generated" / rel.lstrip("/")
        else:
            # Try as a direct file in WEB_DIR
            filepath = Path(WEB_DIR) / clean

        # Security: must resolve within WEB_DIR
        try:
            filepath = filepath.resolve()
            web_root = Path(WEB_DIR).resolve()
            saved_root = (Path(ROOT) / "data" / "saved_images").resolve()   # [img gallery 2026-11-15]
            uploads_root = (Path(ROOT) / "data" / "uploads").resolve()
            generated_root = (Path(ROOT) / "data" / "generated").resolve()
            if not (str(filepath).startswith(str(web_root)) or str(filepath).startswith(str(uploads_root))
                    or str(filepath).startswith(str(generated_root))
                    or str(filepath).startswith(str(saved_root))
                    or str(filepath).startswith(str(Path(PREVIEWS_DIR).resolve()))):
                self._json(403, {"error": {"type": "forbidden", "message": "path outside web root"}})
                return
        except Exception:
            self._json(400, {"error": {"type": "invalid_request", "message": "bad path"}})
            return

        if not filepath.is_file():
            self._json(404, {"error": {"type": "not_found", "message": "file not found"}})
            return

        ext = filepath.suffix.lower()
        content_type = MIME_TYPES.get(ext, mimetypes.guess_type(str(filepath))[0] or "application/octet-stream")

        try:
            body = filepath.read_bytes()
        except OSError as e:
            self._json(500, {"error": {"type": "server_error", "message": str(e)}})
            return

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ─── Helpers ───────────────────────────────────────────────────────────────────
    def _json(self, code: int, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_health(self):
        """GET /health — forward upstream, patch image_generation from local image_settings."""
        upstream = self.state.upstream_url
        url = upstream + "/health"
        try:
            resp = urllib.request.urlopen(url, timeout=10)
            body = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception:
            body = {"status": "ok", "service": "strata"}
        cfg = self._load_image_settings()
        img_ready = bool(
            (cfg.get("local") and cfg["local"].get("exe")) or
            (cfg.get("api") and cfg["api"].get("base_url"))
        )
        body["image_generation"] = img_ready
        self._json(200, body)
    # ─── Management API: MCP servers + skills ─────────────────────────────────────
    def _cached_json(self) -> dict:
        """The POST body, read only once (the routing decision and the proxy both need it)."""
        raw = getattr(self, "_raw_body", None)
        if raw is None:
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            self._raw_body = raw
        try:
            return json.loads(raw.decode("utf-8", "replace")) if raw else {}
        except Exception:
            return {}

    def _read_json(self) -> dict:
        """Parse a JSON request body. An empty or malformed body is not an error here."""
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except Exception:
            return {}

    def _selected_monitor_base(self):
        """The external base_url of the currently SELECTED model, trailing /v1 stripped.

        None when the selected model is served by this gateway's own upstream (the 8080 engine,
        which has no /api/monitor) so the caller returns an empty shape instead of proxying.
        """
        try:
            mr = _model_registry()
            doc = mr.load()
            entry = mr.find(doc, doc.get("selected"))
        except Exception:                                   # noqa: BLE001 - a broken file must not break the page
            return None
        base = str((entry or {}).get("base_url") or "").strip().rstrip("/")
        if not base:
            return None                                     # "" = this gateway's own upstream: no engine monitor
        if base.endswith("/v1"):
            base = base[:-3].rstrip("/")
        return base

    def _api_session_stream(self):
        """GET /api/session-stream — SSE long connection for scheduler token streaming
        (B1). This handler runs on its OWN connection thread (ThreadingHTTPServer), so it
        holds the socket open and forwards broadcaster events until the client leaves.
        Only meaningful in direct/serve mode where the scheduler lives in THIS process."""
        q = self.state.subscribe_stream()
        try:
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.wfile.write(b"data: " + json.dumps({"stream_open": True}, ensure_ascii=False).encode("utf-8") + b"\n\n")
            self.wfile.flush()
            while True:
                try:
                    obj = q.get(timeout=15.0)
                except queue.Empty:
                    # SSE comment keepalive — ignored by every client, proves link alive
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(b"data: " + json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError) as e:
            print(f"  [session-stream] client gone: {type(e).__name__}", file=sys.stderr)
        finally:
            self.state.unsubscribe_stream(q)

    def _api_session_outbox(self, method):
        """GET /api/session-outbox — return pending outbox entries (consume-once) and clear file."""
        outbox_path = os.path.join(ROOT, "data", "session_outbox.jsonl")
        if method not in (None, "GET"):
            self._json(405, {"error": {"type": "method_not_allowed"}})
            return
        entries = []
        if os.path.isfile(outbox_path):
            try:
                lines = open(outbox_path, encoding="utf-8").read().splitlines()
                for l in lines:
                    if l.strip():
                        try:
                            entries.append(json.loads(l))
                        except json.JSONDecodeError:
                            print(f"  [outbox-warn] bad json line", file=sys.stderr)
                            continue
                if entries:
                    open(outbox_path, "w", encoding="utf-8").close()
            except OSError as e:
                print(f"  [outbox-warn] {e}", file=sys.stderr)
        self._json(200, {"entries": entries})

    def _api_monitor(self, method):
        """GET /api/monitor -> the SELECTED model's own engine-side context occupancy.

        The inspector fill bar measures THIS session's prompt tokens over its declared
        per-session window (models.json context_window); the engine's monitor measures the
        SHARED resident KV pool over the engine's real n_ctx. Two honest, deliberately
        different denominators -- surfacing the engine's number beside the bar stops the two
        reading as a sync bug. Always 200 with an `available` flag: the 8080 engine (no
        base_url) and any unreachable endpoint return {available:false} so the chip hides.
        """
        if method not in (None, "GET"):
            self._json(405, {"error": {"type": "method_not_allowed", "message": f"{method} not allowed"}})
            return
        base = self._selected_monitor_base()
        if not base:
            self._json(200, {"available": False})
            return
        try:
            req = urllib.request.Request(base + "/api/monitor", headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3.0) as r:
                doc = json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:                              # noqa: BLE001 - monitor is best-effort, never a 5xx
            self._json(200, {"available": False, "error": str(e)})
            return
        ctx = doc.get("context") if isinstance(doc, dict) else None
        # Extract the latest completed request's tokensIn as engineRealTokens (the engine's
        # true cross-session occupancy). Shell engines report 0 in context.usedTokens at idle
        # but track real per-request usage in requests[].tokensIn -- this exposes it so the
        # front-end can show an honest number even when context.usedTokens is a placeholder.
        engine_real = None
        reqs = doc.get("requests") if isinstance(doc, dict) else None
        if isinstance(reqs, list):
            for r in reqs:
                if isinstance(r, dict) and r.get("state") == "done" and r.get("tokensIn"):
                    engine_real = int(r["tokensIn"])
                    break  # requests are ordered newest-first
        # Anti-jitter: engineRealTokens is a "last request" reading that intermittently reads empty
        # (upstream buffer cleared/restarted, or this round tripped into the except branch). Latch the
        # last non-empty value on the SHARED self.state (handler is per-connection, so instance attrs
        # would not survive) for up to 3 consecutive empties so one flaky round doesn't drop it to null.
        # Still a per-request peak, NOT live resident occupancy -- the number the shell engine won't report.
        if engine_real is not None:
            self.state._engine_real_latched = int(engine_real)
            self.state._engine_real_hold = 3
        elif getattr(self.state, "_engine_real_latched", None) is not None and getattr(self.state, "_engine_real_hold", 0) > 0:
            self.state._engine_real_hold -= 1
            engine_real = self.state._engine_real_latched
        self._json(200, {"available": bool(ctx), "context": ctx or {}, "engineRealTokens": engine_real})

    def _api_parallel_probe(self):
        """GET /api/parallel-probe -> shared tiered probe snapshot. Read-only and local
        (the browser cannot see the host core count), so the UI chip renders exactly what
        the server computed. ASCII-safe JSON, no side effects, never touches the registry."""
        self._json(200, parallel_probe.probe())

    def _api(self, method: str) -> bool:
        """Dispatch /api/servers/* and /api/skills/*. Returns True when handled."""
        path = self.path.split("?")[0]
        if not path.startswith("/api/"):
            return False
        if path.rstrip("/") == "/api/image-settings":
            self._api_image_settings(method)
            return True
        if path.rstrip("/") == "/api/prompt-book":
            self._api_prompt_book(method)          # [prompt book 2026-11-14] authoritative store
            return True
        if path.rstrip("/") == "/api/image-gallery":
            self._api_image_gallery(method)        # [img gallery 2026-11-15] authoritative store
            return True
        if path.rstrip("/") == "/api/saved-image":
            self._api_saved_image()                # [img gallery 2026-11-15] copy one entry into data/saved_images
            return True                            # [FIX 2026-11-15] branch fell through -> 404
        if path.rstrip("/") == "/api/gallery-import":
            self._api_gallery_import()             # [img gallery 添加图片] import one arbitrary file via data URL
            return True
        if path.rstrip("/") == "/api/gallery-reveal":   # [打开所在文件夹修复 2026-11-15] reveal the file's folder
            self._api_gallery_reveal()             # in the INSTALL ROOT (same mapping the recycle bin uses)
            return True
        if path.rstrip("/") == "/api/image-scan-models":
            self._api_image_scan_models()
            return True
        if path.rstrip("/") == "/api/image-preview":   # [实时预览 方案A] 前端轮询
            from urllib.parse import parse_qs, urlparse
            qs = parse_qs(urlparse(self.path).query)
            self._api_image_preview((qs.get("job") or [""])[0])
            return True
        if path.rstrip("/") == "/api/image-cancel":    # [停止生成] 前端点停止按钮
            self._api_image_cancel()
            return True
        if path.rstrip("/") == "/api/chat/stop":
            self._api_chat_stop(method)
            return True
        if path.rstrip("/") == "/api/models" or path.startswith("/api/models/"):
            self._api_models(method, path)               # works even when the server registry is off
            return True
        if path.rstrip("/") == "/api/runtime-config":
            self._api_runtime_config(method)
            return True
        if path.rstrip("/") == "/api/recycle":
            self._api_recycle(method)
            return True
        if path.rstrip("/") == "/api/interrupt-log":
            self._api_interrupt_log(method)
            return True
        if path.rstrip("/") == "/api/parallel-probe":
            self._api_parallel_probe()
            return True
        if path.rstrip("/") == "/api/monitor":
            self._api_monitor(method)
            return True
        if path.rstrip("/") == "/api/session-outbox":
            self._api_session_outbox(method)
            return True
        if path.rstrip("/") == "/api/session-stream":
            self._api_session_stream()
            return True
        if path.rstrip("/") == "/api/requests":
            # Step2-A: the streaming-debug suite reads the per-chunk timeline here. Served
            # locally only in direct mode (the agent loop runs here); in proxy mode this falls
            # through to the upstream Strata host, which owns its own monitor.
            if not self.state.direct_mode:
                return False
            if method not in (None, "GET"):
                self._json(405, {"error": {"type": "method_not_allowed",
                                           "message": f"{method} not allowed"}})
                return True
            request_id = parse_qs(urlsplit(self.path).query).get("id", [None])[0]
            records = self.state.request_records(request_id)
            if records is None:
                self._json(404, {"error": {"message": "request no longer retained"}})
                return True
            if request_id:
                self._json(200, records)
            else:
                self._json(200, {"requests": records, "retention": 100, "persistent": False,
                                 "mode": "direct"})
            return True
        reg = self.state.registry
        if reg is None:
            self._json(503, {"error": {"type": "unavailable",
                                       "message": "management API not configured"}})
            return True
        parts = [unquote(p) for p in path.split("/") if p]
        if len(parts) < 2:
            self._json(404, {"error": {"type": "not_found", "message": "no route"}})
            return True
        group, rest = parts[1], parts[2:]
        try:
            if group == "servers":
                self._api_servers(method, rest)
            elif group == "skills":
                self._api_skills(method, rest)
            else:
                self._json(404, {"error": {"type": "not_found",
                                           "message": f"unknown group '{group}'"}})
        except RegistryError as e:
            # A rejected mutation (duplicate, bad name, protected entry) — the client
            # can act on this, so it is 400 rather than 500.
            self._json(400, {"error": {"type": "invalid_request", "message": str(e)}})
        except Exception as e:
            self._json(500, {"error": {"type": "internal", "message": str(e)}})
        return True

    # ─── Image generation: config load/save + direct generate ───────────────────
    # Added 2026-11-13 per user decision: frontend image tab holds two config slots
    # (local direct + external API). The gateway dispatches at runtime, defaulting to
    # local when both are configured. Paths are NOT preset on the backend (config starts empty).

    def _load_image_settings(self) -> dict:
        cfg_path = os.path.join(ROOT, "config", "image_settings.json")
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                d = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            d = {}
        # Merge defaults (frontend fills these, backend never presets paths)
        out = {"mode": "local", "local": {}, "api": {}}
        out["mode"] = d.get("mode") or "local"
        out["local"] = dict(d.get("local") or {})
        out["api"] = dict(d.get("api") or {})
        return out

    def _api_image_scan_models(self) -> None:
        """GET /api/image-scan-models?dir=<path> - list *.gguf under that model folder
        (one level deep) so the image tab can pick a quantized model by name instead of
        hand-editing image_settings.json. Read-only; defaults to the configured model_dir.
        Returns {"dir": <resolved>, "files": [{"name":..., "path":..., "role_guess":...}]}.
        """
        qs = parse_qs(urlsplit(self.path).query)
        d = (qs.get("dir") or [""])[0].strip()
        if not d:
            d = (self._load_image_settings().get("local", {}) or {}).get("model_dir", "")
        if not d or not os.path.isdir(d):
            self._json(200, {"dir": d, "files": [], "error": "dir not found"})
            return
        files = []
        try:
            for root, _dirs, fnames in os.walk(d):
                depth = os.path.relpath(root, d).count(os.sep)
                if depth > 1:            # model_dir + one level (its CJK subfolders) only
                    continue
                for fn in fnames:
                    if fn.lower().endswith(".gguf"):
                        full = os.path.join(root, fn)
                        low = fn.lower()
                        if "mmproj" in low or "vision" in low:
                            role = "llm_vision"
                        elif "vae" in low:
                            role = "vae"
                        elif "llm" in low:
                            role = "llm"
                        else:
                            role = "diffusion_model"
                        files.append({"name": fn, "path": full, "role_guess": role})
        except OSError as e:
            self._json(500, {"error": {"type": "server_error", "message": str(e)}})
            return
        files.sort(key=lambda x: (x["role_guess"], x["name"]))
        self._json(200, {"dir": d, "files": files})

    PROMPT_BOOK_CAP = (200, 50)   # (prompts, seeds) hard caps — mirrors the frontend's

    def _prompt_book_path(self) -> str:
        # STRATA_PROMPT_BOOK isolates the file for tests (same env-override pattern as STRATA_INTERRUPT_LOG)
        return os.environ.get("STRATA_PROMPT_BOOK") or os.path.join(ROOT, "config", "prompt_book.json")

    def _prompt_book_load(self) -> dict:
        path = self._prompt_book_path()
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            d = {}
        if not isinstance(d, dict):
            d = {}
        return {"prompts": d.get("prompts") if isinstance(d.get("prompts"), list) else [],
                "seeds": d.get("seeds") if isinstance(d.get("seeds"), list) else []}

    def _api_prompt_book(self, method: str):
        """GET/POST /api/prompt-book — the prompt book (positive+negative pairs, with a
        params snapshot) and the seed book, in ONE file: config/prompt_book.json, so both
        ride into git and the daily bundle backup (localStorage alone never does).
        GET returns the doc; POST replaces it wholesale (frontend sends the full doc — the
        same no-merge contract /api/image-settings uses). A .bak of the previous file is
        kept beside it. Parasitic mode has no route here — the frontend then falls back to
        its localStorage mirror (app.js's offline leg)."""
        if method in (None, "GET"):
            self._json(200, self._prompt_book_load())
            return
        if method == "POST":
            body = self._read_json()
            prompts = body.get("prompts")
            seeds = body.get("seeds")
            if not isinstance(prompts, list) or not isinstance(seeds, list):
                self._json(400, {"error": {"type": "invalid_request",
                                           "message": "prompts and seeds must both be lists"}})
                return
            cp, cs = self.PROMPT_BOOK_CAP
            doc = {"prompts": prompts[:cp], "seeds": seeds[:cs]}
            path = self._prompt_book_path()
            try:
                if os.path.exists(path):                                  # backup-before-write
                    import shutil
                    shutil.copyfile(path, path + ".bak")
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(doc, f, ensure_ascii=False, indent=2)
            except OSError as e:
                self._json(500, {"error": {"type": "server_error", "message": str(e)}})
                return
            self._json(200, doc)
            return
        self._json(405, {"error": {"type": "method_not_allowed", "message": f"{method} not allowed"}})

    # [img gallery 2026-11-15] ── the image tab's browsable gallery (view stage + grid) ──
    # Authoritative file config/image_gallery.json (same contract as prompt_book.json:
    # wholesale-POST, .bak, env-override for tests, cap 500) so it rides into git and the
    # bundle backup; localStorage is only the offline mirror. Entries: {url, seed, prompt,
    # ts, size, saved}. Saved copies land in ROOT/data/saved_images/<fname>.

    IMG_GALLERY_CAP = 500

    def _img_gallery_path(self) -> str:
        # STRATA_IMAGE_GALLERY isolates the file for tests (same env-override pattern as STRATA_PROMPT_BOOK)
        return os.environ.get("STRATA_IMAGE_GALLERY") or os.path.join(ROOT, "config", "image_gallery.json")

    def _api_image_gallery(self, method: str):
        if method in (None, "GET"):
            path = self._img_gallery_path()
            doc = {}
            try:
                with open(path, encoding="utf-8") as f:
                    doc = json.load(f)
            except (OSError, ValueError):
                doc = {}
            if not isinstance(doc, dict):
                doc = {}
            self._json(200, {"items": doc.get("items") if isinstance(doc.get("items"), list) else []})
            return
        if method == "POST":
            body = self._read_json()
            items = body.get("items")
            if not isinstance(items, list):
                self._json(400, {"error": {"type": "invalid_request", "message": "items must be a list"}})
                return
            doc = {"items": items[:self.IMG_GALLERY_CAP]}
            path = self._img_gallery_path()
            try:
                if os.path.exists(path):                                  # backup-before-write
                    import shutil
                    shutil.copyfile(path, path + ".bak")
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(doc, f, ensure_ascii=False, indent=2)
            except OSError as e:
                self._json(500, {"error": {"type": "server_error", "message": str(e)}})
                return
            self._json(200, doc)
            return
        self._json(405, {"error": {"type": "method_not_allowed", "message": f"{method} not allowed"}})

    def _api_saved_image(self):
        """POST /api/saved-image {src}: copy ONE server-generated image into data/saved_images/.
        Only accepts paths under /data/generated/images/ (the URL the generation flow itself
        hands out) — no traversal, no arbitrary read. Refuses >20 MB (the front-end ceiling)
        and non-image extensions. Returns the served reference of the copy."""
        body = self._read_json()
        src = (body.get("src") or "").split("?")[0]
        prefix = "/data/generated/images/"
        if not src.startswith(prefix):
            self._json(400, {"error": {"type": "invalid_request",
                                       "message": "src must be a generated image path under " + prefix}})
            return
        name = src[len(prefix):]
        if "/" in name or ".." in name or "\\" in name:
            self._json(400, {"error": {"type": "invalid_request", "message": "bad file name"}})
            return
        ext = os.path.splitext(name)[1].lower()
        if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
            self._json(400, {"error": {"type": "invalid_request", "message": "unsupported image type"}})
            return
        f = os.path.join(GENERATED_DIR, name)   # [FIX 2026-11-15] GENERATED_DIR already ends in images -> double path 404
        if not os.path.isfile(f):
            self._json(404, {"error": {"type": "not_found", "message": "source image not on disk"}})
            return
        if os.path.getsize(f) > 20_000_000:
            self._json(413, {"error": {"type": "server_error", "message": "image too large (max 20 MB)"}})
            return
        import shutil
        saved_dir = os.path.join(ROOT, "data", "saved_images")
        try:
            os.makedirs(saved_dir, exist_ok=True)
            shutil.copyfile(f, os.path.join(saved_dir, name))
        except OSError as e:
            self._json(500, {"error": {"type": "server_error", "message": str(e)}})
            return
        self._json(200, {"ref": "/data/saved_images/" + name})

    def _api_gallery_import(self):
        """POST /api/gallery-import {name, dataUrl}: import ONE arbitrary image file the
        user picked from any folder. The browser reads it as a data: URL (the same channel
        the generation flow already uses in _stage_img), we decode and COPY it into
        data/saved_images/ under a CONTENT-hash name imp_<sha256[:16]>.<ext> (same bytes -> same
        name -> same path -> same ref), then return it. Only image extensions are accepted;
        >20 MB is refused, and an existing hash path is reused (idempotent)."""
        import base64, uuid, time
        body = self._read_json()
        data_url = body.get("dataUrl") or ""
        if not data_url.startswith("data:image/") or "," not in data_url:
            self._json(400, {"error": {"type": "invalid_request",
                                   "message": "dataUrl must be a data:image/ URL"}})
            return
        allowed = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
        raw_name = str(body.get("name") or "")
        ext = os.path.splitext(raw_name)[1].lower()
        if ext not in allowed:
            # extension from the MIME subtype when the name carried none
            head = data_url.split(",", 1)[0]   # data:image/png;base64
            sub = head.split(";", 1)[0].split("/")[-1].lower() if "/" in head else ""
            ext = ".jpg" if sub == "jpeg" else ("." + sub)
        if ext not in allowed:
            self._json(400, {"error": {"type": "invalid_request",
                                   "message": "unsupported image type"}})
            return
        head2 = data_url.split(",", 1)[0]
        if ";base64" not in head2:
            self._json(400, {"error": {"type": "invalid_request",
                                   "message": "data URL must be base64"}})
            return
        b64 = data_url.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64)
        except Exception as e:
            self._json(400, {"error": {"type": "invalid_request",
                                   "message": "bad base64: " + str(e)}})
            return
        if not raw:
            self._json(400, {"error": {"type": "invalid_request",
                                   "message": "empty image data"}})
            return
        if len(raw) > 20_000_000:
            self._json(413, {"error": {"type": "server_error",
                                   "message": "image too large (max 20 MB)"}})
            return
        # [添加图片去重 2026-11-15] content-addressed name: same BYTES -> same sha256 -> same
        # path -> same ref. That makes the front-end's existing url-dedup (galleryAdd) equivalent
        # to CONTENT-dedup, and a re-import never wastes disk on a duplicate copy.
        digest = hashlib.sha256(raw).hexdigest()[:16]
        fname = "imp_" + digest + ext
        saved_dir = os.path.join(ROOT, "data", "saved_images")
        dest = os.path.join(saved_dir, fname)
        existed = os.path.isfile(dest)
        try:
            os.makedirs(saved_dir, exist_ok=True)
            if not existed:   # idempotent: identical content already on disk -> reuse it
                with open(dest, "wb") as fh:
                    fh.write(raw)
        except OSError as e:
            self._json(500, {"error": {"type": "server_error", "message": str(e)}})
            return
        self._json(200, {"ref": "/data/saved_images/" + fname, "name": raw_name or fname, "existed": existed})

    def _api_image_settings(self, method: str):
        """GET/POST /api/image-settings — read or write the image tab's two config slots."""
        if method == "GET":
            self._json(200, self._load_image_settings())
            return
        if method == "POST":
            body = self._read_json()
            mode = body.get("mode") or "local"
            local = dict(body.get("local") or {})
            api = dict(body.get("api") or {})
            cfg = {"mode": mode, "local": local, "api": api}
            cfg_path = os.path.join(ROOT, "config", "image_settings.json")
            try:
                with open(cfg_path, "w", encoding="utf-8") as f:
                    json.dump(cfg, f, ensure_ascii=False, indent=2)
            except OSError as e:
                self._json(500, {"error": {"type": "server_error", "message": str(e)}})
                return
            self._json(200, cfg)
            return
        self._json(405, {"error": {"type": "method_not_allowed", "message": f"{method} not allowed"}})

    def _handle_image_gen(self):
        """POST /v1/images/generations — generate an image, mode-decided at runtime.

        Dispatch order (user decision, 2026-11-13):
          1. If body carries explicit mode, use it.
          2. Else, use config mode (default "local").
          3. Fallback: if chosen mode's config is empty, auto-switch to the other mode if
             it's configured; if neither is configured, 400.
        """
        payload = self._cached_json()
        if not isinstance(payload, dict):
            self._json(400, {"error": {"type": "invalid_request", "message": "body must be JSON object"}})
            return
        prompt = (payload.get("prompt") or "").strip()
        if not prompt:
            self._json(400, {"error": {"type": "invalid_request", "message": "prompt required"}})
            return
        size = payload.get("size") or "512x512"
        try:
            w, h = (int(x) for x in size.lower().split("x", 1))
        except Exception:
            w, h = 512, 512
        _seed_raw = payload.get("seed")
        if isinstance(_seed_raw, bool) or _seed_raw is None or _seed_raw == "" or _seed_raw == 0:
            import random as _rnd
            seed = _rnd.randint(1, 2**31 - 1)   # 留空=真随机（旧代码把空当 0，0 是合法固定种子→完全复现=雷同根因）
        else:
            try:
                seed = int(_seed_raw)
            except (TypeError, ValueError):
                import random as _rnd
                seed = _rnd.randint(1, 2**31 - 1)
        n = int(payload.get("n") or 1)
        resp_fmt = payload.get("response_format") or "b64_json"
        # generation request params (txt2img / img2img / edit) — pass through to the engine
        genreq = {
            "negative":   payload.get("negative_prompt")
                     or (payload.get("n") if isinstance(payload.get("n"), str) else "") or "",   # [FIX] n=OpenAI 数量字段，别名只认 str，否则 n=2 被当负向词喵 f.write(int) 崩
            "steps":      payload.get("steps") or TURBO_STEPS,          # [默认档] 留空=Turbo 官方 8 步
            "cfg_scale":  payload.get("cfg_scale") or TURBO_CFG,        # [默认档] 留空=Turbo 官方 CFG 1
            "cpu_offload": payload.get("cpu_offload", False),   # [默认不勾=更快] 显存够用；不足时勾上(走PCIe搬运很慢)            # [CPU卸载 建议开启] 默认开
            "gen_mode":   payload.get("gen_mode") or "txt2img",
            "init_image": payload.get("init_image"),   # data URL or absolute path
            "strength":   payload.get("strength"),     # img2img redraw amount
            "ref_images": payload.get("ref_images"),   # edit: list of data URLs / paths
            "sampling_method": payload.get("sampling_method"),   # [增变化] 实测同seed下换采样方法MD5不同
            "scheduler": payload.get("scheduler"),               # [增变化] karras等调度器改sigma分布
            "eta": payload.get("eta"),                           # [增变化] 噪声乘子>0注入额外随机性
        }

        cfg = self._load_image_settings()
        mode = payload.get("mode") or cfg["mode"] or "local"
        local = cfg["local"]; api = cfg["api"]

        # auto-fallback if chosen slot has no config
        def local_ready(): return local.get("exe") and local.get("diffusion_model")
        def api_ready(): return api.get("base_url")
        if mode == "local" and not local_ready():
            if api_ready():
                mode = "api"
            else:
                self._json(400, {"error": {"type": "invalid_request",
                    "message": "neither local model path nor external API is configured (fill them on the image tab)"}})
                return
        elif mode == "api" and not api_ready():
            if local_ready():
                mode = "local"
            else:
                self._json(400, {"error": {"type": "invalid_request",
                    "message": "neither local model path nor external API is configured (fill them on the image tab)"}})
                return

        if mode == "local":
            if payload.get("async_preview"):            # [实时预览 方案A] 异步路径，立即返回 job_id
                try:
                    self._json(200, self._gen_local_async(prompt, w, h, seed, n, resp_fmt, local, genreq))
                except Exception as e:
                    self._json(500, {"error": {"type": "server_error", "message": f"local generate failed: {e}"}})
                return
            try:
                result = self._gen_local(prompt, w, h, seed, n, resp_fmt, local, genreq)
            except Exception as e:
                self._json(500, {"error": {"type": "server_error", "message": f"local generate failed: {e}"}})
                return
            self._json(200, result)
        else:
            try:
                result = self._gen_via_api(payload, api)
            except Exception as e:
                self._json(500, {"error": {"type": "server_error", "message": f"API generate failed: {e}"}})
                return
            self._json(200, result)

    def _gen_local(self, prompt: str, w: int, h: int, seed: int, n: int, resp_fmt: str, cfg: dict,
                   genreq: Optional[dict] = None, preview_path: Optional[str] = None,
                   cancel_event=None, job_id=None) -> dict:
        import tempfile, subprocess, base64
        genreq = genreq or {}
        gen_mode = genreq.get("gen_mode") or "txt2img"   # txt2img | img2img | edit
        strength = genreq.get("strength")               # img2img redraw amount (None -> engine default 0.75)
        exe = cfg["exe"]
        dm  = cfg.get("diffusion_model", "")
        vae = cfg.get("vae", "")
        llm = cfg.get("llm", "")
        llm_vision = cfg.get("llm_vision", "")
        extra = cfg.get("args") or []
        if not os.path.isfile(exe):
            raise FileNotFoundError(f"exe not found: {exe}")
        for tag, k in (("diffusion_model",dm),("vae",vae),("llm",llm)):
            if k and not os.path.isfile(k):
                raise FileNotFoundError(f"{tag} not found: {k}")
        work = tempfile.mkdtemp(prefix="img-")
        # ── the engine misreads CJK paths (see _stage_img below): an ASCII-named
        # model file under work/ lets it read them. hardlink, fall back to copy ──
        def _stage_ascii_model(path, slot):
            if not path or path.isascii():
                return path
            # [CACHE 2026-11-14] process-level ASCII cache: cross-volume hardlink is
            # physically impossible (temp=C:, models=E:) so a big gguf would be re-copied
            # EVERY request. Copy once into a persistent cache dir keyed by source path,
            # reuse on later runs; hardlink that cache entry into this request's work dir.
            cache = os.path.join(tempfile.gettempdir(), "strata_ascii_model_cache")
            os.makedirs(cache, exist_ok=True)
            key = hashlib.md5(os.path.abspath(path).encode("utf-8")).hexdigest()[:16]
            cached = os.path.join(cache, key + ".gguf")
            with _ASCII_CACHE_LOCK:
                if not (os.path.isfile(cached) and os.path.getsize(cached) == os.path.getsize(path)):
                    tmp = cached + ".tmp" + str(os.getpid())
                    shutil.copyfile(path, tmp)
                    with contextlib.suppress(OSError):
                        os.replace(tmp, cached)
            dest = os.path.join(work, "model_%s.gguf" % slot)
            try:
                os.link(cached, dest)        # same-volume hardlink: cheap, no second copy
            except OSError:
                shutil.copyfile(cached, dest)
            return dest
        dm  = _stage_ascii_model(dm, "dm")
        vae = _stage_ascii_model(vae, "vae")
        llm = _stage_ascii_model(llm, "llm")
        llm_vision = _stage_ascii_model(llm_vision, "vision")
        pf = os.path.join(work, "prompt.txt")
        with open(pf, "w", encoding="utf-8") as f:
            f.write(prompt)
        pattern = os.path.join(work, "img_%d.png")
        cmd = [exe, "--diffusion-model", dm, "--vae", vae, "--llm", llm,
               "-W", str(w), "-H", str(h), "--prompt-file", pf, "-s", str(seed),
               "-b", str(n), "-o", pattern]
        # user-set negative / steps / cfg (engine defaults apply when blank)
        if genreq.get("negative"):
            nf = os.path.join(work, "neg.txt")
            with open(nf, "w", encoding="utf-8") as f:
                f.write(genreq["negative"])
            cmd += ["--negative-prompt-file", nf]
        if genreq.get("steps"):
            cmd += ["--steps", str(int(genreq["steps"]))]
        if genreq.get("cfg_scale"):
            cmd += ["--cfg-scale", str(float(genreq["cfg_scale"]))]
        if genreq.get("cpu_offload"):              # [CPU卸载 建议开启] 权重驻 RAM 省显存，需要时搬进显存
            cmd += ["--offload-to-cpu", "--mmap"]
        if genreq.get("sampling_method"):          # [增变化] 仅用户填了才传
            cmd += ["--sampling-method", str(genreq["sampling_method"])]
        if genreq.get("scheduler"):                # [增变化] 仅用户填了才传
            cmd += ["--scheduler", str(genreq["scheduler"])]
        if genreq.get("eta") not in (None, "", 0): # [增变化] eta=0=引擎默认，不传
            cmd += ["--eta", str(float(genreq["eta"]))]
        if exe.lower().endswith(".py"):   # a python-script runner needs the interpreter prefix
            cmd = [sys.executable] + cmd   # a compiled sd-cli exe is used as-is
        # ── img2img / edit inputs: copy the uploaded image into the work dir under an ASCII
        # name (the engine misreads CJK source paths), then wire sd-cli's own flags ──
        def _stage_img(src_desc, slot):
            dest = os.path.join(work, f"in_{slot}.png")
            if src_desc.startswith("data:"):              # browser data URL
                b64 = src_desc.split(",", 1)[1] if "," in src_desc else src_desc
                with open(dest, "wb") as fh:
                    fh.write(base64.b64decode(b64))
            elif src_desc and os.path.isfile(src_desc):  # absolute disk path (Browse… path)
                shutil.copyfile(src_desc, dest)
            else:
                return None
            return dest
        if gen_mode == "img2img":
            staged = _stage_img(genreq.get("init_image") or "", "init")
            if staged:
                cmd += ["-i", staged]
                if strength is not None:
                    cmd += ["--strength", str(float(strength))]
        elif gen_mode == "edit":
            if llm_vision:                        # [EDIT-VISION 2026-11-13] Qwen-Image edit needs vision weights
                cmd += ["--llm_vision", llm_vision]
            for j, ri in enumerate(genreq.get("ref_images") or []):
                staged = _stage_img(ri, f"ref{j}")
                if staged:
                    cmd += ["-r", staged]                  # reference image for edit (repeatable)
        if extra:
            cmd += list(extra)
        if preview_path:                            # [实时预览 方案A] 逐步写 preview 到固定路径
            cmd += ["--preview", "vae", "--preview-path", preview_path, "--preview-interval", "1"]
        if cancel_event is not None:                # [停止生成] 异步路径用 Popen，便于取消时 terminate
            rc, out_txt, err_txt = self._run_cancellable(cmd, work, cancel_event, job_id)
            proc = _ProcRc(rc, out_txt, err_txt)
        else:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=work)
        if proc.returncode != 0:
            raise RuntimeError(f"sd-cli rc={proc.returncode}: {proc.stderr[-400:] if proc.stderr else proc.stdout[-400:]}")
        # ── persist results into GENERATED_DIR so they survive refresh/restart; also return
        # base64 (back-compat) so an old client keeps working ──
        os.makedirs(GENERATED_DIR, exist_ok=True)
        data = []
        for i in range(n):
            pngp = os.path.join(work, f"img_{i}.png")
            if not os.path.isfile(pngp):
                raise RuntimeError(f"expected output missing: {pngp}")
            stamp = time.strftime("%Y%m%d_%H%M%S")
            fname = f"gen_{stamp}_{uuid.uuid4().hex[:8]}.png"
            dest = os.path.join(GENERATED_DIR, fname)
            shutil.copyfile(pngp, dest)
            item = {"revised_prompt": prompt, "seed": seed + i,
                    "url": "/data/generated/images/" + fname,   # served by _serve_static
                    "saved_path": dest}
            item["b64_json"] = base64.b64encode(open(pngp,"rb").read()).decode("ascii")
            data.append(item)
        # tidy the scratch work dir
        for fn in os.listdir(work):
            with contextlib.suppress(OSError):
                os.remove(os.path.join(work, fn))
        with contextlib.suppress(OSError):
            os.rmdir(work)
        return {"created": int(time.time()), "data": data, "model": cfg.get("model_name") or "qwen-image-2.1-turbo",
                "output_format": "png", "size": f"{w}x{h}",
                "strata": {"mode":"local","exe":exe,"gen_mode":gen_mode}}

    def _gen_local_async(self, prompt, w, h, seed, n, resp_fmt, cfg, genreq) -> dict:
        """[实时预览 方案A] 启动后台线程跑 _gen_local（带 preview_path），立即返回 job_id。

        前端拿到 job_id+preview_url 后每约2秒轮询 GET /api/image-preview?job= 刷新预览；
        status=done 时 result 带完整 OpenAI-shaped 成品。ThreadingHTTPServer 保证轮询与生成并发。"""
        job_id = uuid.uuid4().hex[:12]
        os.makedirs(PREVIEWS_DIR, exist_ok=True)
        preview_path = os.path.join(PREVIEWS_DIR, "job_%s.png" % job_id)
        preview_url = "/data/generated/previews/job_%s.png" % job_id
        cancel = threading.Event()                  # [停止生成] worker 每短拍检查；置位=取消
        with _IMAGE_JOBS_LOCK:
            _IMAGE_JOBS[job_id] = {"status": "running", "preview_url": preview_url,
                                   "result": None, "error": None, "cancel": cancel, "proc": None}
        def worker():
            try:
                result = self._gen_local(prompt, w, h, seed, n, resp_fmt, cfg, genreq,
                                          preview_path=preview_path, cancel_event=cancel, job_id=job_id)
                with _IMAGE_JOBS_LOCK:
                    job = _IMAGE_JOBS.get(job_id)
                    if job and job["cancel"].is_set():       # 被取消：不写 done
                        job["status"] = "cancelled"
                    elif job:
                        job["status"] = "done"
                        job["result"] = result
            except Exception as e:
                with _IMAGE_JOBS_LOCK:
                    job = _IMAGE_JOBS.get(job_id)
                    if job:
                        # 取消导致的非零退出/管道异常归为 cancelled，不算 error
                        job["status"] = "cancelled" if job["cancel"].is_set() else "error"
                        job["error"] = None if job["cancel"].is_set() else str(e)
            finally:
                with _IMAGE_JOBS_LOCK:                       # 收尾释放 proc 引用（已结束的进程）
                    j = _IMAGE_JOBS.get(job_id)
                    if j and j["status"] in ("done", "cancelled", "error"):
                        j["proc"] = None
        threading.Thread(target=worker, daemon=True).start()
        return {"created": int(time.time()), "job_id": job_id, "status": "running",
                "preview_url": preview_url, "size": "%dx%d" % (w, h),
                "model": cfg.get("model_name") or "qwen-image-2.1-turbo", "data": []}

    def _run_cancellable(self, cmd, work, cancel_event, job_id):
        """[停止生成] 异步路径专用：Popen 跑 cmd，reader 线程抽干管道（防大输出死锁），

        主循环 wait 短超时检查 cancel_event；被取消则 terminate→（宽限后）kill。
        返回 (returncode, stdout_text, stderr_text)。"""
        import subprocess as _sp
        proc = _sp.Popen(cmd, stdout=_sp.PIPE, stderr=_sp.PIPE, text=True, cwd=work)
        with _IMAGE_JOBS_LOCK:
            if job_id and _IMAGE_JOBS.get(job_id):
                _IMAGE_JOBS[job_id]["proc"] = proc
        out_buf, err_buf = [], []
        def drain(pipe, buf):
            try:
                for line in pipe:
                    buf.append(line)
            except Exception:       # 管道随进程关闭即结束本守护线程（非静默吞异常）
                return
        threading.Thread(target=drain, args=(proc.stdout, out_buf), daemon=True).start()
        threading.Thread(target=drain, args=(proc.stderr, err_buf), daemon=True).start()
        while True:
            try:
                rc = proc.wait(timeout=0.5)
                break
            except _sp.TimeoutExpired:
                if cancel_event.is_set():
                    proc.terminate()                    # 先温和终止
                    try:
                        rc = proc.wait(timeout=3)
                    except _sp.TimeoutExpired:
                        proc.kill()                     # 宽限后强杀
                        rc = proc.wait()
                    break
        # drain 线程读尽已缓冲输出（给短超时，避免取消时无限等）
        time.sleep(0.2)
        return rc, "".join(out_buf), "".join(err_buf)

    def _api_image_cancel(self) -> None:
        """POST /api/image-cancel — [停止生成] 置 job 的 cancel Event，worker 会 terminate 子进程。

        返回 {cancelled:True, job_id}。任务保留在表里直到 worker 收尾。"""
        req = self._read_json() if hasattr(self, "_read_json") else {}
        from urllib.parse import parse_qs, urlparse
        job_id = req.get("job") or (parse_qs(urlparse(self.path).query).get("job") or [""])[0]
        with _IMAGE_JOBS_LOCK:
            job = _IMAGE_JOBS.get(job_id)
            if job is None:
                self._json(404, {"error": {"type": "not_found", "message": "unknown job_id"}})
                return
            job["cancel"].set()
            proc = job.get("proc")
        if proc is not None:
            with contextlib.suppress(Exception):
                proc.terminate()                        # 双保险：立即终止正在跑的子进程
        self._json(200, {"cancelled": True, "job_id": job_id})

    def _api_image_preview(self, job_id) -> None:
        """GET /api/image-preview?job= — 轮询异步生成任务状态。

        返回 {status, preview_url, result, error}；done 时带完整 result，读后即回收任务。"""
        with _IMAGE_JOBS_LOCK:
            job = _IMAGE_JOBS.get(job_id)
            if job is None:
                self._json(404, {"error": {"type": "not_found", "message": "unknown job_id"}})
                return
            # [FIX 2026-11-14] 快照必须剔除内部字段：cancel=threading.Event、proc=Popen 都不可
            # json 序列化，旧代码 dict(job) 全量快照 → _json 里 json.dumps 抛 TypeError →
            # handler 崩、连接被掐 → 前端轮询永远 RemoteDisconnected（「看不到进度/结果」的根因）。
            snapshot = {k: v for k, v in job.items() if k not in ("cancel", "proc")}
            # [FIX 2026-11-14] 就绹位：预览 png 真落盘了才让前端挂 src（否则 404 破图）
            snapshot["preview_ready"] = bool(snapshot.get("preview_url")) and os.path.isfile(
                os.path.join(PREVIEWS_DIR, os.path.basename(snapshot["preview_url"])))
        if snapshot["status"] in ("done", "cancelled", "error"):   # 终态读后回收（预览图保留）
            with _IMAGE_JOBS_LOCK:
                _IMAGE_JOBS.pop(job_id, None)
        self._json(200, snapshot)

    def _gen_via_api(self, payload: dict, api_cfg: dict) -> dict:
        base = str(api_cfg.get("base_url") or "").rstrip("/")
        key  = str(api_cfg.get("api_key") or "")
        model = str(api_cfg.get("model") or "")
        if model:
            payload = dict(payload); payload.setdefault("model", model)
        url = base + "/images/generations" if base.endswith("/v1") else base + "/v1/images/generations"
        body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body_bytes, method="POST")
        req.add_header("Content-Type", "application/json")
        if key:
            req.add_header("Authorization", "Bearer " + key)
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    def _api_chat_stop(self, method: str):
        """POST /api/chat/stop — explicitly cancel a running stream.

        Body: {"stop_id": "<id>"} (the same id the client sent in the chat/completions request).
        Returns {"ok": true, "stopped": <bool>} where stopped is False if the id was unknown
        (already finished, or a stale id).
        """
        if method != "POST":
            self._json(405, {"error": {"type": "method_not_allowed", "message": f"{method} not allowed"}})
            return
        body = self._read_json()
        stop_id = (body.get("stop_id") or body.get("id")) if isinstance(body, dict) else None
        if not stop_id:
            self._json(400, {"error": {"type": "invalid_request", "message": "stop_id required"}})
            return
        stopped = self.state.cancel_stream(stop_id)
        self._json(200, {"ok": True, "stopped": stopped})

    # ─── Interruption log (POST appends, GET tails) ──────────────────────────────────
    # Every turn that did NOT finish cleanly is recorded with its timestamp and the PHASE it
    # died in (thinking / answering / which tool was running). Without this file "it just
    # stopped" left no evidence at all: engine went silent, a tool wedged, or the socket
    # dropped were indistinguishable after the fact. JSONL so it stays greppable and cheap.
    def _api_interrupt_log(self, method: str):
        """POST /api/interrupt-log {"entry": {...}} appends; GET /api/interrupt-log?n=50 tails."""
        path = INTERRUPT_LOG
        if method == "POST":
            body = self._read_json()
            entry = body.get("entry") if isinstance(body, dict) else None
            if not isinstance(entry, dict) or not entry:
                self._json(400, {"error": {"type": "invalid_request",
                                           "message": "entry object required"}})
                return
            try:
                _ilog_append(path, entry)
            except OSError as e:
                self._json(500, {"error": {"type": "internal", "message": f"cannot write log: {e}"}})
                return
            self._json(200, {"ok": True, "path": path})
            return
        if method != "GET":
            self._json(405, {"error": {"type": "method_not_allowed", "message": f"{method} not allowed"}})
            return
        n = 50
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        for part in query.split("&"):
            if part.startswith("n="):
                try:
                    n = max(1, min(ILOG_TAIL_MAX, int(part[2:])))
                except ValueError:
                    pass                                  # a junk ?n= falls back to the default
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except OSError:
            lines = []                                     # no log yet is a normal state
        entries = []
        for line in lines[-n:]:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except Exception:                              # noqa: BLE001 - one bad line must not hide the rest
                continue
        self._json(200, {"ok": True, "path": path, "count": len(entries), "entries": entries})

    def _api_models(self, method: str, path: str):
        """GET/POST /api/models, POST /api/models/test - the composer's model switcher."""
        try:
            mr = _model_registry()
        except Exception as e:                                   # noqa: BLE001
            self._json(500, {"error": {"type": "internal", "message": str(e)}})
            return
        tail = path.rstrip("/").split("/api/models", 1)[-1].strip("/")
        if tail == "test":
            if method != "POST":
                self._json(405, {"error": {"type": "method_not_allowed", "message": f"{method} not allowed"}})
                return
            body = self._read_json()
            probe = body
            if body.get("id"):                               # editing: reuse the stored key unless a new one came
                old = mr.find(mr.load(), body.get("id"))
                if old:
                    probe = {**old, **{k: v for k, v in body.items() if v not in (None, "")}}
            ok, msg = mr.probe(probe, timeout=8)
            self._json(200, {"ok": ok, "message": msg})
            return
        if tail:
            self._json(404, {"error": {"type": "not_found", "message": "no route"}})
            return
        if method == "GET":
            doc = mr.public(mr.load())
            self._json(200, {**doc, "probe": self._model_probe(doc), "path": mr.config_path(), "build": _web_build()})
        elif method in ("POST", "PUT"):
            body = self._read_json()
            existing = mr.load()
            # Omitted = keep, exactly like mr.merge() (省略=保留, 空数组=清空). Without this, a
            # caller that only means to change `selected` would silently delete every entry.
            raw_models = body.get("models")
            if raw_models is None:
                raw_models = existing.get("models") or []
            doc = {"selected": body.get("selected", existing.get("selected")), "models": []}
            for e in raw_models:
                if isinstance(e, dict):
                    doc["models"].append(mr.merge(existing, e))
            saved = mr.save(doc)
            # Same shape as GET, `probe` included: the client replaces its whole `modelsDoc` with
            # this body, so omitting liveness here made the status dot read "unknown" after every
            # switch until the next poll - a flicker that looks like a broken indicator.
            self._json(200, {**mr.public(saved), "probe": self._model_probe(saved), "path": mr.config_path(), "build": _web_build()})
        else:
            self._json(405, {"error": {"type": "method_not_allowed", "message": f"{method} not allowed"}})

    def _model_probe(self, doc: dict) -> dict:
        """Per-model endpoint liveness for the composer's switcher.

        An entry with no base_url is served by this gateway's own upstream (the 8080 engine);
        one with a base_url points at a sibling instance / external endpoint. Either way the
        UI is told whether that endpoint actually accepts connections right now.
        """
        out = {}
        default_url = self.state.upstream_url
        for m in doc.get("models") or []:
            if not isinstance(m, dict):
                continue
            # The liveness probe follows the selection: a custom entry is probed at its OWN
            # base_url (via the same endpoint_alive), not the machine-wide default upstream —
            # so the switcher/dot stays honest after a switch to a custom endpoint (2026-10-31).
            kind = m.get("kind")
            if kind == "local":
                url = str(m.get("base_url") or "").strip() or default_url
            elif kind == "custom":
                url = str(m.get("base_url") or "").strip()
                if not url:
                    continue
            else:
                continue
            out[str(m.get("id") or "")] = {"url": url, "ok": endpoint_alive(url)}
        engine = endpoint_models(default_url)
        out["__engine__"] = {"url": default_url, "ok": endpoint_alive(default_url),
                             "loaded": (engine or [None])[0] if engine is not None else None}
        return out

    # ─── Runtime config (GET/POST /api/runtime-config) ─────────────────────────────
    # Live, restart-free tuning of the gateway's own agent-loop and executor caps. The
    # frontend's About > 运行参数 card edits these. They only matter in direct mode
    # (the gateway runs the agent loop here); in proxy mode the loop lives on the
    # upstream Strata host, so we 404 and the card stays hidden.
    #
    # `help` is the English source of truth (read directly by the en UI, like the engine's
    # /config help); the zh UI translates it via i18n keys rt.<key> (server-sourced, exempt
    # from parity). Each entry: (default, help).
    _RT_LOOP_KEYS = {           # live in gw_state, read by the agent loop each turn
        "max_rounds":     (1000, "Agent-loop round cap: how many think→tool cycles a single turn may run. "
                                "Coding tasks need many; default 1000. 0 falls back to the default."),
        "turn_budget_s":  (3600, "Absolute ceiling (seconds) for one turn — a runaway guard only. Refreshed "
                                 "on any progress, so a slow but productive turn is never cut off."),
        "idle_timeout_s": (180, "Stall watchdog (seconds): no token and no tool activity for this long ⇒ the "
                               "turn is wedged, stop. Refreshed on every sign of progress."),
    }
    _RT_EXEC_KEYS = {           # live in executor module-level DEFAULTS / SERVER_TIMEOUT_S
        "timeout_s":        (330, "Per-command timeout (seconds): one individual tool call may run this long "
                                 "before failing."),
        "server_timeout_s": (1800, "Per-server cumulative timeout (seconds): one MCP server's total wall time "
                                  "across the turn. 0 = unlimited."),
        "max_result_chars": (30000, "Tool-result truncation (characters): tool outputs longer than this are "
                                   "clipped (head-only) to keep the CURRENT turn's context bounded. The full "
                                   "text is saved to the tool-log and recoverable via recall_tool_log(id)."),
    }

    _RT_CAP_KEYS = {           # live in gw_state, applied to each tool result stored in history
        "tool_result_cap": (10000, "Tool-result history cap (chars): tool outputs longer than this in the "
                                   "live history are head/tail truncated inline; the full text is saved to the "
                                   "tool-log and recoverable via recall_tool_log(id). Keeps many-turn history "
                                   "bounded without losing data."),
        "tool_head_lines": (15, "Leading lines of an over-long tool result kept inline (errors/headers "
                                "usually live here)."),
        "tool_tail_lines": (15, "Trailing lines of an over-long tool result kept inline (the final result "
                                "usually lives here)."),
        "tool_keep_recent": (2, "Never cap the most recent N tool results — a same-turn chained call that "
                                "re-reads a just-produced output still sees it in full this turn."),
    }

    def _api_runtime_config(self, method: str):
        if not (self.state.direct_mode and self.state.executor is not None):
            self._json(404, {"error": {"type": "not_found",
                                       "message": "runtime config is only available in direct agent mode"}})
            return
        cd = _executor.current_defaults()

        def snapshot():
            keys = []
            for k, (dft, help_) in self._RT_LOOP_KEYS.items():
                keys.append({"key": k, "kind": "number", "value": getattr(self.state, k, dft),
                             "default": dft, "help": help_, "scope": "loop", "live": True})
            for k, (dft, help_) in self._RT_EXEC_KEYS.items():
                keys.append({"key": k, "kind": "number", "value": cd.get(k, dft),
                             "default": dft, "help": help_, "scope": "executor", "live": True})
            for k, (dft, help_) in self._RT_CAP_KEYS.items():
                keys.append({"key": k, "kind": "number", "value": getattr(self.state, k, dft),
                             "default": dft, "help": help_, "scope": "loop", "live": True})
            return keys

        if method == "GET":
            self._json(200, {"keys": snapshot(), "file": self.state.config_path, "mode": "direct"})
            return

        # POST {set: {key: number}} — validate, apply live, persist the mcp block.
        body = self._read_json()
        setmap = (body.get("set") if isinstance(body, dict) else None) or {}
        validated = {}
        for k in {**self._RT_LOOP_KEYS, **self._RT_CAP_KEYS, **self._RT_EXEC_KEYS}:
            if k not in setmap:
                continue
            try:
                v = float(setmap[k])
            except (TypeError, ValueError):
                self._json(400, {"error": {"type": "invalid_request", "message": f"{k} must be a number"}})
                return
            if v < 0:
                self._json(400, {"error": {"type": "invalid_request", "message": f"{k} must be >= 0"}})
                return
            validated[k] = v

        changed = []
        for k in (*self._RT_LOOP_KEYS, *self._RT_CAP_KEYS):
            if k in validated:
                setattr(self.state, k, int(validated[k]))
                changed.append(k)
        exec_subset = {k: validated[k] for k in self._RT_EXEC_KEYS if k in validated}
        if exec_subset:
            _executor.configure(exec_subset)        # mutates module-level DEFAULTS / SERVER_TIMEOUT_S
            changed.extend(exec_subset.keys())
        if changed:
            self._persist_runtime_config(validated)
        self._json(200, {"changed": changed, "file": self.state.config_path, "mode": "direct"})

    def _persist_runtime_config(self, values: dict) -> None:
        """Write the changed caps into the `mcp` block of mcp_servers.json (the file the
        gateway read them from at startup) so they survive a restart. Values are stored as
        ints to match the surrounding block; server_timeout_s 0 means 'disabled'."""
        path = self.state.config_path
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
        mcp = dict(cfg.get("mcp") or {})
        sess = dict(cfg.get("session") or {})
        for k, v in values.items():
            # executor keys persist to the mcp block (configure() reads them at startup);
            # loop keys also persist to mcp (gateway.main reads max_rounds/turn_budget_s/
            # idle_timeout_s from the mcp block); only the cap keys persist to the session
            # block (where gw_state reads tool_result_cap/head/tail/keep_recent at startup).
            if k in self._RT_CAP_KEYS:
                sess[k] = int(v)
            else:
                mcp[k] = int(v)
        cfg["mcp"] = mcp
        cfg["session"] = sess
        backup = f"{path}.bak-rt"
        try:
            shutil.copy2(path, backup)
        except Exception:
            pass
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)

    def _workspace_list(self):
        """GET /workspace/list - the folder browser. Mirrors serve/server.py so the picker
        behaves identically in both flavours. Active only in direct mode (a gateway in front
        of Strata forwards the request upstream instead)."""
        ws = _workspace_fs()
        root = _workspace_root(self.state)
        q = parse_qs(urlsplit(self.path).query)
        raw = (q.get("path") or [""])[0]
        listing = ws.list_dirs(raw, root) if (raw or "").strip() else None
        self._json(200, {"listing": listing, **ws.browse_roots(root)})

    def _workspace_mutate(self, path: str):
        """POST /workspace/{create,open} - mirror serve/server.py for the picker's buttons."""
        ws = _workspace_fs()
        root = _workspace_root(self.state)
        body = self._read_json()
        if path == "/workspace/create":
            name = (body.get("name") or "").strip()
            if not name or "/" in name or "\\" in name or name in (".", "..") or name.startswith("."):
                self._json(400, {"error": {"type": "invalid_request_error",
                                           "message": "send a single safe folder name (no path, no '..', no leading dot)"}})
                return
            base = Path(root)
            target = (base / name).resolve()
            if not str(target).startswith(str(base.resolve())):
                self._json(400, {"error": {"type": "invalid_request_error",
                                           "message": "the new folder must sit directly under the workspace root"}})
                return
            try:
                target.mkdir(parents=True, exist_ok=True)
                self._json(200, {"path": str(target)})
            except OSError as e:
                self._json(500, {"error": {"type": "server_error", "message": f"the folder could not be created: {e}"}})
            return
        if path == "/workspace/open":
            raw = (body.get("path") or "").strip()
            target = ws.resolve_workspace_folder(raw, root)
            if target is None:
                self._json(400, {"error": {"type": "invalid_request_error",
                                           "message": f"not an existing (or creatable) folder: {raw}"}})
                return
            try:
                ws.open_folder(target)
                self._json(200, {"path": str(target), "opened": True})
            except (OSError, AttributeError) as e:
                self._json(500, {"error": {"type": "server_error",
                                           "message": f"the folder could not be opened: {e}"}})
            return
        self._json(404, {"error": {"type": "not_found", "message": "no route"}})

    def _api_servers(self, method: str, rest: list):
        reg = self.state.registry
        if not rest:
            if method == "GET":
                self._json(200, {"servers": reg.list_servers()})
            elif method == "POST":
                body = self._read_json()
                self._json(200, reg.add_server(body.get("name"),
                                               body.get("spec") or body))
            else:
                self._json(405, {"error": {"type": "method_not_allowed",
                                           "message": f"{method} not allowed"}})
            return
        # Probe a spec without saving it — the UI uses this before an install lands.
        if rest[0] == "test" and method == "POST":
            body = self._read_json()
            self._json(200, reg.test_server(body.get("spec") or body))
            return
        if rest[0] == "reload" and method == "POST":
            self._json(200, self._reload_executor())
            return
        name = rest[0]
        if method == "GET":
            self._json(200, {"server": reg.get_server(name)})
        elif method == "PUT":
            body = self._read_json()
            self._json(200, reg.update_server(name, body.get("spec") or body))
        elif method == "DELETE":
            self._json(200, reg.delete_server(name))
        else:
            self._json(405, {"error": {"type": "method_not_allowed",
                                       "message": f"{method} not allowed"}})

    def _api_skills(self, method: str, rest: list):
        reg = self.state.registry
        if not rest:
            if method == "GET":
                self._json(200, {"skills": reg.list_skills()})
            elif method == "POST":
                body = self._read_json()
                self._json(200, reg.add_skill(body.get("name"),
                                              body.get("spec") or body))
            else:
                self._json(405, {"error": {"type": "method_not_allowed",
                                           "message": f"{method} not allowed"}})
            return
        name = rest[0]
        if method == "GET":
            for s in reg.list_skills():
                if s["name"] == name:
                    self._json(200, {"skill": s})
                    return
            raise RegistryError(f"skill '{name}' not found")
        if method == "PUT":
            body = self._read_json()
            self._json(200, reg.update_skill(name, body.get("spec") or body))
        elif method == "DELETE":
            self._json(200, reg.delete_skill(name))
        else:
            self._json(405, {"error": {"type": "method_not_allowed",
                                       "message": f"{method} not allowed"}})

    def _reload_executor(self) -> dict:
        """Rebuild the executor from the current config so edits take effect without a restart.

        The replacement is started BEFORE the old one is stopped: if a newly added server
        fails to launch, stopping first would leave the gateway with no tools at all.
        """
        st = self.state
        if not st.config_path:
            return {"ok": False, "error": "no config path configured"}
        try:
            from config_loader import load_config
            from executor import Executor
            from registry import resolve_servers
            cfg = load_config(st.config_path) or {}
            servers = resolve_servers(cfg, skills_dir=st.skills_dir)
            new = Executor(servers, defaults=cfg.get("mcp"))
            new.start_all()
            old = st.executor
            with st.lock:
                st.executor = new
            if old is not None:
                try:
                    old.stop_all()
                except Exception:
                    pass
            return {"ok": True, "servers": sorted(servers), "tools": len(new.tools)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ─── Direct mode: gateway-run agent loop (upstream LLM + local MCP) ────────────
    def _mcp_status(self) -> dict:
        """Expose the gateway's own MCP servers to the frontend (GET /mcp in direct mode).

        Shape must match what the Strata host returns, or the frontend renders wrong:
        each tool needs BOTH `name` (namespaced "server__tool") and `tool` (bare name) —
        the server chips read `t.tool`, and servers carry an `error` field.
        """
        servers, total = [], 0
        for name, srv in self.state.executor.servers.items():
            tools = [{"name": f"{name}__{t['name']}", "tool": t["name"],
                      "description": t.get("description", ""),
                      "input_schema": t.get("inputSchema", {})} for t in srv.tools]
            total += len(tools)
            servers.append({"name": name, "status": "ready", "transport": "stdio",
                            "error": None, "tools": tools,
                            "info": {"name": name, "version": "1.0.0"}})
        return {"servers": servers, "tools": total, "settings": {}}

    def _mcp_call(self):
        """POST /mcp/call — manual tool invocation from the Tools tab. Same-origin in both
        modes (the host serves it in parasitic mode; here we route to our own executor).

        Response envelope matches what the frontend's mcpCall() expects:
        {"server", "tool", "ok", "text", "chars", "ms", ...} — the payload rides in `text`.
        """
        try:
            body = self._read_json() or {}
        except Exception:
            body = {}
        server = (body.get("server") or "").strip()
        tool = (body.get("tool") or "").strip()
        args = body.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        ex = self.state.executor
        if not ex or not ex.tools:
            self._json(200, {"server": server, "tool": tool, "ok": False,
                             "text": "error: no tools available (executor not started)",
                             "chars": 0, "ms": 0})
            return
        name = f"{server}__{tool}" if server else tool
        t0 = time.time()
        try:
            result = ex.call(name, args)
            ok = not is_error(result)
            ms = int((time.time() - t0) * 1000)
            self._json(200, {"server": server, "tool": tool, "ok": ok,
                             "code": error_code(result),
                             "text": result if isinstance(result, str) else str(result),
                             "chars": len(result) if isinstance(result, str) else 0,
                             "ms": ms, "serverless": False})
        except Exception as e:  # noqa: BLE001
            self._json(200, {"server": server, "tool": tool, "ok": False,
                             "code": "exec",
                             "text": f"error: {e}", "chars": 0, "ms": 0})

    def _diag_empty_round(self, info):
        """Append one line per "round that produced nothing" to logs/empty-round.jsonl.

        These rounds are otherwise invisible after the fact: the turn ends cleanly from the
        client's point of view, so there is no error to look at. Keeping finish_reason, the
        usage block and how much thinking preceded the stop is what makes the next report
        diagnosable instead of guessed at.
        """
        try:
            rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
            rec.update(info)
            d = os.environ.get("STRATA_EMPTY_ROUND_DIR") or os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "empty-round.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception:
            pass                                    # diagnostics must never break a turn

    def _diag_turn(self, info):
        """Append one line per turn milestone to logs/turn.jsonl (start / end / crash).

        The 2026-10-20 report ("为什么又被打断了") was undiagnosable for exactly one reason: the
        gateway kept **no request log at all**. A turn whose socket or process dies leaves no
        traceback anywhere, so afterwards there was literally nothing to inspect -- only the
        browser's own interrupt-log, which records what the CLIENT saw and never why.

        A `start` line plus a closing `end`/`crash` line fixes that asymmetry: a turn with a
        start and no matching end is proof that the process died mid-flight, and the closing
        line says which of the four ways a turn actually finished (done / notice / crash /
        client_gone) instead of forcing another round of forensics.
        """
        try:
            rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
            rec.update(info)
            d = os.environ.get("STRATA_TURN_DIAG_DIR") or os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "turn.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception:
            pass                                    # diagnostics must never break a turn

    def _diag_round(self, info):
        """Append one line per LLM round to logs/rounds.jsonl.

        turn.jsonl says how a TURN ended but not what its rounds contained, so the 2026-10-20
        report ("思考完突然断了", ended `done` at round 3 with a one-line answer) still needed
        guesswork: the only surviving evidence was a screenshot. A per-round line with the
        finish reason, the size of text/thinking, the calls actually executed, whether call
        markup leaked into the text and whether the answer was pure narration makes the next
        occurrence readable in seconds instead of reconstructed from a screenshot.
        """
        try:
            rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
            rec.update(info)
            d = os.environ.get("STRATA_ROUND_DIAG_DIR") or os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "rounds.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception:
            pass                                    # diagnostics must never break a turn

    def _async_judge_turn(self, session_id, acc, shown_content, ending_kind, known):
        """Non-blocking per-turn behavior judge (heuristic, no model).

        Fired from the turn's `finally` so it can NEVER delay the stream's first or
        last token. The verdict lands in logs/judge_stream.jsonl and is surfaced by
        tools/scan_session.py. Must never raise: a judge hiccup is silent, not fatal.

        Notes:
          * `content` judged is `shown_content` (the CLEANED, user-visible text) -- not
            the raw `acc["content"]` -- so a markup leak the streaming cleaner MISSED
            shows up here as a hard finding, instead of being hidden by the rescue copy.
          * runs in a daemon thread; `acc`/`known` are copied defensively.
        """
        tools_dir = os.path.join(ROOT, "tools")
        acc_c = dict(acc or {})
        known_c = set(known) if known else None
        shown = shown_content or ""

        def _run():
            try:
                import sys as _sys
                if tools_dir not in _sys.path:
                    _sys.path.insert(0, tools_dir)
                import behavior_judge as bj
                turn = {
                    "id": f"{session_id}#{ending_kind}",
                    "content": shown,
                    "reasoning_content": acc_c.get("reasoning", "") or "",
                    "tool_calls": acc_c.get("tool_calls", []) or [],
                }
                res = bj.judge_turn(turn, known=known_c)
                rec = {
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "session": session_id,
                    "ending": ending_kind,
                    "ok": res["ok"],
                    "checks": res["checks"],
                }
                d = os.environ.get("STRATA_JUDGE_DIR") or os.path.join(ROOT, "logs")
                os.makedirs(d, exist_ok=True)
                with JUDGE_WRITE_LOCK:
                    with open(os.path.join(d, "judge_stream.jsonl"), "a", encoding="utf-8") as f:
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            except Exception:
                pass  # diagnostics must never break a turn
        threading.Thread(target=_run, name="turn-judge", daemon=True).start()

    # ── Step2-A: per-chunk monitor helpers ──────────────────────────────────────
    def _mon_chunk(self, typ, length, tokens=None):
        """Append one streamed event to the current request's chunk_timeline.

        `typ` is the classified event kind (thinking/content/usage/tool_call/tool_result/
        tool_progress/notice/error/stopped/done/proxy); `length` is the bytes written. The
        timeline is bounded (2000 entries) so a long turn can never blow up memory."""
        rec = getattr(self, "record", None)
        if rec is None:
            return
        tl = rec.get("chunk_timeline")
        if tl is None:
            return
        if len(tl) >= 2000:
            if not rec.get("chunk_timeline_truncated"):
                rec["chunk_timeline_truncated"] = True
            return
        try:
            t = round(time.perf_counter() - rec["_clock"], 4)
        except Exception:                         # noqa: BLE001 - the clock is always present; never break a stream
            t = None
        with self.state.status_lock:
            ev = {"t": t, "type": typ, "bytes": int(length)}
            if tokens:
                ev["tok"] = tokens
            tl.append(ev)

    @staticmethod
    def _chunk_type(c):
        """Classify a streamed event for the timeline (OpenAI-style chunks + agent-loop events)."""
        if not isinstance(c, dict):
            return "other"
        if c.get("usage") is not None:
            return "usage"
        if c.get("error") is not None:
            return "error"
        if c.get("strata_notice") is not None:
            return "notice"
        sm = c.get("strata_mcp")
        if isinstance(sm, dict):
            ev = sm.get("event")
            if ev == "call":
                return "tool_call"
            if ev == "result":
                return "tool_result"
            if ev == "progress":
                return "tool_progress"
            return "mcp"
        if c.get("stopped") is not None:
            return "stopped"
        d = ((c.get("choices") or [{}])[0].get("delta") or {}) if "choices" in c else (c.get("delta") or {})
        if d.get("reasoning_content"):
            return "thinking"
        if d.get("content"):
            return "content"
        if d.get("tool_calls"):
            return "tool_call"
        if "role" in d:
            return "role"
        return "other"

    def _agent_stream(self, body=None):
        """Run the agent loop for /v1/chat/completions when direct_mode is on.

        Streams OpenAI-compatible SSE to the frontend, injecting `strata_mcp` events so the
        existing tool UI renders local tool calls in real time.
        """
        if not isinstance(body, dict):
            body = self._cached_json()
        # Step2-A: open a monitor record + capture window for this turn (always on, cheap).
        self.record = self.state.begin_request(self.path.split("?")[0].rstrip("/"), body)
        ex = self.state.executor
        # Real tool names. Used both to rescue text-form calls at the round boundary
        # and to hide any leaked call markup from the user-facing stream (see the
        # per-delta cleaner below). Computed once here so streaming and the rescue
        # agree on the same allow-list.
        known_tools = {t["name"] for t in (getattr(ex, "tools", None) or []) if t.get("name")}
        messages = [dict(m) for m in body.get("messages", [])]
        # Per-round output budget asked by the composer (settings.max). The actual cap is
        # computed PER ROUND inside the loop from the free context space + OUTPUT_CEILING; this
        # value only feeds that computation. See OUTPUT_CEILING / the in-loop block for why the
        # cap is no longer a fixed 8192.
        try:
            _asked = int((body or {}).get("max_tokens") or 0)
        except Exception:
            _asked = 0
        try:                                                           # [CEILING-FEED]
            _ceiling = int((body or {}).get("max_ceiling") or 0) or OUTPUT_CEILING
        except Exception:
            _ceiling = OUTPUT_CEILING
        # 方案A增强：正文保底额度（前端发来；0=用 _DEFAULT_ANSWER_FLOOR 参与计算）。
        try:
            _answer_floor = int((body or {}).get("answer_floor_tokens") or 0) or _DEFAULT_ANSWER_FLOOR
        except Exception:
            _answer_floor = _DEFAULT_ANSWER_FLOOR
        # Thinking level: honour the composer's selector instead of pinning one here (see above).
        effort = reasoning_effort_of(body)
        budget = reasoning_budget_of(body)        # None for 跟随模型 / off
        # Sampling: the composer sends temperature / top_p / top_k / seed, but this loop used to
        # drop ALL of them, so the engine always ran on its own default (the model card's 1.0 for
        # thinking models). At 1.0 a reasoning model wanders, and it sometimes ends a round with
        # nothing but thinking -- which the UI can only show as "it just stopped". Forward what
        # the composer asked for, and omit whatever it left to the model.
        sampling = {}
        if isinstance(body, dict):
            for k in ("temperature", "top_p", "top_k", "seed"):
                v = body.get(k)
                if v is None:
                    continue
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                if fv < 0:
                    continue
                sampling[k] = int(fv) if k in ("top_k", "seed") else fv
        # Session id (frontend activeId) so context occupancy is tracked PER CONVERSATION, never leaked
        # across tasks/workspaces (see GatewayState.prompt_tokens_for).
        session_id = body.get("strata_session") if isinstance(body, dict) else None
        # A compaction request (frontend sets this when compactConversation() fires). The proactive 92%
        # guard below must NOT stop it -- otherwise the compaction that would fix an overflowing context
        # can never run, wedging the chat permanently. We reset the tracked occupancy for this session
        # instead, so the post-compact conversation starts from a clean (small) count.
        _is_compact = bool(body.get("strata_compact")) if isinstance(body, dict) else False
        if _is_compact and session_id:
            self.state.reset_prompt_tokens(session_id)
        # The user's chosen workspace: (a) make it the CURRENT base for fs/shell so relative
        # paths land in the project instead of this agent's install dir, and (b) put its
        # ABSOLUTE path in front of the model so it stops inventing a relative one.
        ws = body.get("strata_workspace")
        ws_abs = ""
        if isinstance(ws, str) and ws.strip():
            try:
                ws_abs = _record_workspace(ws, _workspace_root(self.state))
            except Exception:                                  # noqa: BLE001 - never kill a turn over this
                ws_abs = ""
        if ws_abs:
            messages = _with_workspace_hint(messages, ws_abs)
        oai_tools = [{"type": "function", "function": {
            "name": t["name"], "description": t["description"],
            "parameters": t["input_schema"]}} for t in ex.tools] or None

        # ── Cancellation ── a Stop click (or closing the tab) must truly stop inference
        # and any in-flight tool, not let the model keep generating into the void.
        stop_id = (body.get("stop_id") if isinstance(body, dict) else None) or None
        cancel = self.state.register_stream(stop_id)

        # Why the turn ended, for logs/turn.jsonl: done | notice:<code> | crash | client_gone.
        # Without this a turn that dies leaves no server-side trace whatsoever.
        ending = {"kind": "done", "detail": None}
        client_gone = [False]                              # a write failed -> the browser left
        # ... and WHY. The exception type/number is the only remaining evidence after a cut:
        # WinError 10054 (RST -- the peer vanished: closed tab, killed process, VPN/network reset)
        # and 10053 (the local stack aborted an established connection) point at different
        # culprits, while 10038 means we wrote to an already-closed socket. Discarding it (the old
        # behaviour) made "network error" + "client_gone" two halves of a story with no middle.
        client_gone_why = [None]
        turn_no = [0]                                      # round reached (for a crash before the loop)
        self._diag_turn({"kind": "start", "session": session_id,
                         "model": ((getattr(self, "_model_override", None) or {}).get("model")
                                   or self.state.model),
                         "messages": len(messages), "tools": len(oai_tools or []),
                         "max_rounds": self.state.max_rounds})

        fail_streak = {}                                   # signature -> consecutive failures
        # Turn-level counters for the two guards below (see logs/rounds.jsonl).
        tool_rounds = [0]        # rounds that actually EXECUTED a tool call
        nudges = [0]             # "you only described the step" reminders sent this turn
        b_nudges = [0]           # SEPARATE budget for the action-shape (plan-as-tool-call) guard
        verify_attempts = [0]          # self-verify gate attempts this turn (mirror loop.py)
        # ── Turn budget: two clocks, not one ──
        # The old code stopped the turn at a flat 10-minute wall clock. That is far too short
        # for a real coding job (14+ file writes, long reasoning rounds), so the agent was
        # killed mid-work: the model's remaining plan was lost and the UI showed a naked error.
        # Now: (a) a generous absolute ceiling, and (b) an idle watchdog that only fires when
        # NOTHING has progressed for idle_timeout_s. A productive turn may run long; a stalled
        # one (dead upstream / wedged tool) still dies fast instead of hanging for an hour.
        turn_deadline = time.monotonic() + self.state.turn_budget_s
        idle_until = [time.monotonic() + self.state.idle_timeout_s]
        # Per-server cumulative budget is meant per TURN ("one server must not eat the whole
        # turn"), but it accumulated for the life of the process -- a long session eventually
        # poisoned every server with "cumulative budget exceeded". Reset it at turn start.
        try:
            ex.reset_cum()
        except Exception:                                  # a mock/partial executor must not break chat
            pass

        def touch():
            """Mark progress: push the stall watchdog forward."""
            idle_until[0] = time.monotonic() + self.state.idle_timeout_s

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        write_lock = threading.Lock()      # two writers share this socket now: the loop + heartbeat

        def _write(text):
            with write_lock:
                try:
                    self.wfile.write(text.encode("utf-8"))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError) as e:
                    # client went away (tab closed / fetch aborted / the link itself dropped) — stop
                    # everything downstream. Remembered, because afterwards this is the ONLY way to
                    # tell "the browser left" apart from "we stopped on purpose" when reading the
                    # turn log -- and the exception itself is kept so the log can name the cause.
                    client_gone[0] = True
                    if client_gone_why[0] is None:
                        why = f"{type(e).__name__}"
                        if getattr(e, "errno", None) is not None:
                            why += f" [{e.errno}]"
                        text = str(e).strip()
                        if text and text not in why:
                            why += f": {text}"
                        client_gone_why[0] = why
                    cancel.set()

        def raw(text):
            # An SSE comment. Every client ignores it, which makes it the right keepalive: the
            # connection stays demonstrably alive without inventing an event the UI must handle.
            _write(text + "\n\n")

        def sse(obj):
            # A plain string is written VERBATIM. The terminal marker must be the OpenAI-standard
            # `data: [DONE]`; json.dumps("[DONE]") would produce `data: "[DONE]"`, which is legal
            # JSON but no client matches it -- so every healthy turn looked like a dropped
            # connection ("连接中断", the turn marked truncated, a pointless 继续 instead of a
            # finished answer).
            payload = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
            # Step2-A: record every streamed event in the request's chunk_timeline so the
            # debug suite can replay exactly where a turn broke (thinking/content/usage/tool
            # call+result/notice/error/[DONE]). A plain string (the [DONE] terminator) maps
            # to type "done"; anything else is classified by _chunk_type.
            if isinstance(obj, str):
                self._mon_chunk("done", len(payload.encode("utf-8")))
            else:
                _ct = self._chunk_type(obj)
                _tok = None
                if _ct == "usage" and isinstance(obj, dict):
                    _u = obj.get("usage") or {}
                    _det = _u.get("prompt_tokens_details") or {}
                    _tok = (_u.get("prompt_tokens"), _u.get("completion_tokens"),
                            _det.get("cached_tokens", _det.get("cache_read_input_tokens")))
                self._mon_chunk(_ct, len(payload.encode("utf-8")), tokens=_tok)
            _write("data: " + payload + "\n\n")

        def notice(code, **extra):
            """Report a *recoverable* stop. This is NOT an error: everything streamed so far
            (answer text, tool calls and their results) is kept, and the UI offers 继续.
            Sending `{"error": ...}` here used to mark the whole turn as failed and, because
            the banner was re-appended on each repaint, could pile up as several identical
            red boxes for one single stop."""
            payload = {"code": code, "resumable": True}
            payload.update(extra)
            ending["kind"], ending["detail"] = "notice", code
            # Step2-C: annotate the monitor record with where/how the turn broke so the debug
            # suite can show a breakpoint instead of a silent cut.
            rec = getattr(self, "record", None)
            if rec is not None:
                rec["end_reason"] = "notice:" + code
                rec["end_detail"] = extra.get("text") or code
                rec["resumable"] = bool(payload.get("resumable", True))
            sse({"strata_notice": payload})

        # ── Heartbeat: a long tool call writes NOTHING for minutes ───────────────────
        # `python build.py` / an install / a long model call leaves this stream at zero bytes for
        # as long as it runs. Nothing then knows the turn is alive: the browser's own idle clock
        # expires, an idle socket can be reaped by anything in between, and afterwards there is no
        # evidence anywhere that the turn ever existed. A comment line every 5s keeps the
        # connection warm; every 30s the live tool also reports its elapsed time, so the card
        # shows real progress instead of looking wedged.
        hb = {"id": None, "name": None}
        hb_stop = threading.Event()
        t_turn = time.monotonic()
        hb_s = float(os.environ.get("STRATA_HEARTBEAT_S") or 5.0)          # tests shorten these
        hb_report = float(os.environ.get("STRATA_HEARTBEAT_REPORT_S") or 30.0)
        last_report = [t_turn]

        def _heartbeat():
            while not hb_stop.wait(hb_s):
                if cancel.is_set():
                    return
                try:
                    now = time.monotonic()
                    if hb["id"] and now - last_report[0] >= hb_report:
                        last_report[0] = now
                        sse({"strata_mcp": {"event": "progress", "id": hb["id"], "text":
                             f"· {hb['name'] or '工具'} 仍在运行，已 {int(now - t_turn)}s\n"}})
                    else:
                        raw(": ping")
                except Exception:                   # a heartbeat must never be able to kill a turn
                    # ... and must never kill ITSELF either. The old `return` here did: one
                    # non-OSError hiccup (a serialisation edge case, a race with finish()) and
                    # the loop exited for good, so the rest of a long, tool-heavy turn had no
                    # keepalive at all. An idle connection is exactly what a proxy / VPN / OS
                    # reaps -- and that surfaces as "network error" in the browser and
                    # `client_gone` here. Skip the beat, keep the beat.
                    continue

        threading.Thread(target=_heartbeat, name="turn-heartbeat", daemon=True).start()

        def finish():
            """Close the turn: silence the heartbeat FIRST, then send the one terminator the
            client needs. Order matters -- a keepalive landing after [DONE] is a protocol wart."""
            hb_stop.set()
            sse("[DONE]")

        overflow_retried = False     # one quiet resend budget for a resident-contention 400
        vision_degraded = False      # [VISION-DEGRADE] one text-占位 resend budget when upstream rejects an image
        vision_retry = False         # set by the inner consumer to trigger that single resend
        try:
            # Fusion: mark the agent busy for the whole turn (paired with
            # end_interaction in this try's finally) so the scheduler host queues.
            self.state.begin_interaction()
            for rnd in range(1, self.state.max_rounds + 1):
                turn_no[0] = rnd
                if cancel.is_set():
                    sse({"stopped": True})
                    break
                now = time.monotonic()
                if now > turn_deadline:
                    notice("turn_budget", budget_s=self.state.turn_budget_s, rounds=rnd - 1)
                    break
                if now > idle_until[0]:
                    notice("idle", idle_s=self.state.idle_timeout_s, rounds=rnd - 1)
                    break
                # Proactive context guard: if THIS conversation's previous turn already filled most of
                # the window, stop *before* the upstream returns a fatal 400. Tracked per session, so a
                # fresh task (no prior usage for its id) never trips this — only a conversation that has
                # genuinely grown large does. The frontend's auto-compact may be disabled, so the gateway
                # enforces the ceiling too.
                _lp = self.state.prompt_tokens_for(session_id)
                _win = self.state.ctx_window(getattr(self, "_model_override", None))  # declared window > env > engine > fallback
                if (not _is_compact and _lp and _win
                        and _lp >= int(_win * 0.92)):
                    pct = round(100 * _lp / _win)
                    notice("context_overflow",
                           text=f"上下文已接近模型上限（约 {pct}%），上游将拒绝生成。"
                                "请开启自动压缩或发送 /compact 精简历史后点「继续」。")
                    break
                # Dynamic per-round output ceiling (the fix for "single turn capped at 8192").
                # Scale the generation budget to the FREE space of the context window so a
                # near-empty conversation can emit a large file in one turn, while a window near
                # full auto-shrinks the budget and can NEVER trigger an upstream 400. The
                # composer's explicit Max tokens is honoured as a cap but is itself clamped to
                # OUTPUT_CEILING. `_lp` is this conversation's last recorded prompt usage
                # (prompt_tokens_for), a safe proxy for how full the window already is.
                out_cap = compute_output_cap(_asked, _win or self.state.ctx_window(getattr(self, "_model_override", None)), _lp, _ceiling,
                                          reasoning_budget=budget, answer_floor=_answer_floor)
                view = system_view_with_fallback(messages)
                acc = {"content": "", "reasoning": "", "tool_calls": [], "finish": None, "usage": None}
                shown_content = ""           # how much of the CLEANED content we've SSE'd so far
                try:
                    for data in self._llm_stream(view, oai_tools, cancel=cancel,
                                                 stall_s=self.state.idle_timeout_s,
                                                 max_tokens=out_cap, reasoning_effort=effort,
                                                 reasoning_budget=budget,
                                                 sampling=sampling):
                        if cancel.is_set():
                            break
                        touch()                    # tokens flowing = the turn is alive
                        # [VISION-DEGRADE] upstream refused THIS image but the turn has one
                        # text-占位 resend budget: swap image blocks for text and re-send, instead
                        # of silently dropping the picture.
                        if (data.get("error") and not vision_degraded
                                and _is_vision_failure(data["error"])):
                            messages = _degrade_image_blocks(messages)
                            vision_degraded = True
                            vision_retry = True
                            break
                        _ch = (data.get("choices") or [{}])[0]
                        if _ch.get("finish_reason"):
                            # "length" = THIS ROUND ran out of output budget (not the turn). It has
                            # to be tracked: a capped round ends with no answer text and no tool
                            # call, and without this the loop just fell through to [DONE] with no
                            # explanation at all -- the "it silently stopped while thinking" report.
                            acc["finish"] = _ch["finish_reason"]
                        d = _ch.get("delta") or {}
                        u = data.get("usage")
                        if u:
                            acc["usage"] = u       # kept for the empty-round diagnostic below
                            # Forward the upstream usage so the frontend's live context fill and its own
                            # auto-compact can engage. Previously the gateway dropped it, so lastPromptTokens
                            # stayed 0 and auto-compact never fired -> the prompt grew until 8080 400'd.
                            pt = u.get("prompt_tokens")
                            if pt and not _is_compact:
                                self.state.record_prompt_tokens(session_id, pt)
                            sse({"usage": u})
                        if d.get("reasoning_content"):
                            acc["reasoning"] += d["reasoning_content"]
                            sse({"choices": [{"delta": {"reasoning_content": d["reasoning_content"]}}]})
                        if d.get("content"):
                            acc["content"] += d["content"]
                            # Send the user a CLEANED view: any call markup the engine
                            # leaks into `content` -- an orphan `</function></tool_call>`
                            # after a structured call, or a whole call written as text in
                            # FM4 -- must never reach the chat as visible XML. `acc["content"]`
                            # stays RAW so the end-of-round rescue (text_tool_calls) can still
                            # recover the structured call, and history is cleaned separately.
                            clean = text_tool_calls(acc["content"], known_tools)[1]
                            delta = clean[len(shown_content):] if clean.startswith(shown_content) else ""
                            if delta:
                                sse({"choices": [{"delta": {"content": delta}}]})
                            shown_content = clean
                        if d.get("tool_calls"):
                            self._merge_tc(acc["tool_calls"], d["tool_calls"])
                except UpstreamStalled:
                    if cancel.is_set():
                        break
                    # Silent engine: report a resumable stop, not a 10-minute hang / red error.
                    notice("idle", idle_s=self.state.idle_timeout_s, rounds=rnd - 1)
                    break
                except Exception as e:
                    if cancel.is_set():
                        break
                    msg = getattr(e, "detail", None) or str(e)
                    if isinstance(e, UpstreamHTTPError) and e.status == 400 and _is_context_overflow(msg):
                        if _is_compact:
                            # The compaction request itself overflowed the model window -- there is no
                            # smaller prompt that would fit, so re-offering "compact then continue" would
                            # loop forever. Surface a plain (non-recoverable) error instead.
                            sse({"error": {"message": f"upstream error: context window exceeded even when compacting"}})
                            break
                        # ── 2026-10-24: resident-contention vs true-overflow split. ──
                        # A 400 here is NOT always "the window is full". The n_ctx window is
                        # per-conversation and this conversation is often nowhere near it (the panel
                        # said 53%): what actually ran out is the engine's SHARED resident KV pool
                        # (--kv-resident budget, the conversation cache across ALL live sessions),
                        # and it refuses the request that TRIGGERED the eviction without reserving
                        # room for its own output. The eviction has now made room, so quietly
                        # resending THIS same request usually succeeds -- the user should never see
                        # a scary banner for it. Only if the resend ALSO fails do we surface a
                        # notice, and then we say what it actually is (contention), not the generic
                        # wording that misled the user this time.
                        _act = overflow_action(_lp, _win or self.state.ctx_window(getattr(self, "_model_override", None)), overflow_retried)
                        if _act == "retry":
                            overflow_retried = True
                            time.sleep(1.0)          # let the engine finish the eviction it just did
                            continue                 # same messages, same round -- quiet resend
                        if _act == "notice_contention":
                            notice("context_overflow", text=_CONTENTION_TEXT)
                            break
                        # "compact": near the ceiling for real -- a resend would 400 again.
                        notice("context_overflow",
                               text="上下文已超出模型上下文窗口，上游拒绝生成。"
                                    "请开启自动压缩或发送 /compact 精简历史后点「继续」。")
                        break
                    if _except_vision_resend(e, msg, not vision_degraded):
                        messages = _degrade_image_blocks(messages)
                        vision_degraded = True
                        continue                 # [VISION-DEGRADE] re-send once, image blocks now text
                    sse({"error": {"message": f"upstream error: {e}"}})
                    break

                if cancel.is_set():
                    break

                if vision_retry:
                    vision_retry = False
                    continue                 # [VISION-DEGRADE] re-send once with image blocks as text

                calls = [t for t in acc["tool_calls"] if t.get("function", {}).get("name")]
                capped = acc.get("finish") == "length"          # this round hit out_cap
                leaked = bool(acc["content"] and
                              ("<function=" in acc["content"] or "<tool_call" in acc["content"]))

                # Rescue a call the engine left as TEXT. Without this the round looks like a
                # finished answer and the loop breaks "final answer already streamed" while the
                # task is half-done -- the "思考完就突然断了" report (2026-10-20).
                rescued_names = []
                if not calls:
                    known = {t["name"] for t in (getattr(ex, "tools", None) or []) if t.get("name")}
                    got, cleaned = text_tool_calls(acc["content"] or "", known)
                    if got:
                        calls = [{"id": f"call_{rnd}_t{i}", "type": "function",
                                  "function": c["function"]} for i, c in enumerate(got)]
                        rescued_names = [c["function"]["name"] for c in got]
                    if cleaned != (acc["content"] or ""):
                        # Also covers the orphan-closer case: `</function></tool_call>` must not
                        # reach the history, or the model reads it as "the call already ran".
                        acc["content"] = cleaned
                narration = (not calls and not capped
                             and looks_like_narration(acc["content"] or ""))

                self._diag_round({
                    "session": session_id, "round": rnd, "finish": acc.get("finish"),
                    "content_chars": len(acc["content"] or ""),
                    "reasoning_chars": len(acc["reasoning"] or ""),
                    "calls": [t["function"]["name"] for t in calls],
                    "rescued": rescued_names, "call_markup_in_text": leaked,
                    "narration": narration, "nudges": nudges[0],
                    "content_tail": (acc["content"] or "")[-300:],
                    "usage": acc.get("usage"),
                })

                if calls or (acc["content"] or "").strip():
                    self.state.clear_empty_streak(session_id)   # productive round resets the streak
                if not calls:
                    if capped:
                        # Pure-thought round that ran out of budget: nothing reached the user, so
                        # say WHY instead of ending the turn as if it had answered. Everything
                        # streamed so far is kept and 继续 carries on from here.
                        notice("max_tokens", max_tokens=out_cap, resumable=True, rounds=rnd,
                               text=f"本轮达到单轮输出上限（{out_cap} tokens），生成被截断，"
                                    "已产出的内容都保留了。点「继续」接着做即可。")
                    elif not (acc["content"] or "").strip():
                        # The round ended having produced NOTHING the user can act on: no answer
                        # text, no tool call. The model either spent the round thinking and then
                        # emitted EOS, or the engine closed the stream early. Ending silently here
                        # is exactly what users report as "it just stopped mid-task" -- there was no
                        # error, no notice, and the composer came back enabled.
                        empty_rounds = self.state.note_empty_round(session_id)
                        self._diag_empty_round({
                            "session": session_id,
                            "model": ((getattr(self, "_model_override", None) or {}).get("model")
                                      or self.state.model),
                            "round": rnd,
                            "finish": acc.get("finish"), "content_chars": len(acc["content"] or ""),
                            "reasoning_chars": len(acc["reasoning"] or ""),
                            "usage": acc.get("usage"), "sampling": sampling,
                            "reasoning_effort": effort, "empty_streak": empty_rounds,
                        })
                        if empty_rounds >= 2:
                            # Two empty rounds in a row within this request: another nudge
                            # would burn a round the same way, so STOP and ask for a setting
                            # change rather than invite a blind retry.
                            notice("empty_round", resumable=False, rounds=rnd,
                                   finish=acc.get("finish"), streak=empty_rounds,
                                   text="连续两轮模型只产出思考，没有正文也没有工具调用，已停止以免空转。"
                                        "建议把温度降到 0.6、思考强度改为「中」后，再点「继续」重试。")
                        else:
                            # First thinking-only round: nudge the model to act and keep
                            # working instead of returning to the user. This mirrors loop.py
                            # so both chains auto-continue on the first pure-thinking round.
                            messages.append({"role": "assistant", "content": acc["reasoning"] or ""})
                            messages.append({"role": "user", "content":
                                             "[system] 你的回复只有思考链，没有产出正文或工具调用。"
                                             "如果任务还没做完：现在立刻调用工具执行，或给出明确的回复。"
                                             "如果确实已完成：用一句话说明「已完成」。"})
                            touch()
                            continue
                    # B (2026-10-24): the model hallucinated the markdown plan/next-steps
                    # fence as an XML tool call -- `<function=plan>` + a `<parameter=...>`
                    # argument, with a NAME the parser drops. The round then looks "answered"
                    # (non-empty text, no real call) and would break mid-task, which the user
                    # reports as an interruption that needs a manual 继续. It wrote an ACTION,
                    # so keep working. Has its OWN larger budget (b_nudges) separate from the
                    # model that keeps doing this is bounded, and only the *action* shape (an
                    # unknown name that CARRIES a parameter block) matches -- a normal answer
                    # that merely QUOTES the format stays prose and is not resumed here.
                    elif b_nudges[0] < 5 and hallucinated_tool_call(acc["content"], known_tools):
                        b_nudges[0] += 1
                        messages.append({"role": "assistant", "content": acc["content"]})
                        messages.append({"role": "user", "content":
                                         "[system] 你刚才把计划/建议用 <function=...> 写成了工具调用的样子，"
                                         "但它不是真正的工具调用（解析器无法识别那个名字），所以回合差点在这里结束。"
                                         "如果任务还没做完：现在用正确的工具调用语法真正执行下一步；"
                                         "如果那只是给用户的计划清单，请用 markdown 围栏写，不要写成工具调用语法。"})
                        touch()
                        continue
                    elif tool_rounds[0] and nudges[0] < 2 and narration:
                        # The model ANSWERED with its own plan: "目录为空、Node v24 可用。开始分块
                        # 构建。" and then EOS with no tool call. "Has text" was being read as "has
                        # answered", so the turn ended mid-task with the work not even started --
                        # logged as ending=done, i.e. indistinguishable from a real finish. Ask for
                        # the action instead of stopping. Capped at 2: a model that keeps narrating
                        # gets its answer treated as final rather than looping forever.
                        nudges[0] += 1
                        messages.append({"role": "assistant", "content": acc["content"]})
                        # A plain user-role system note, NOT role=system. The engine's template
                        # collects only the LEADING run of system messages into `merged_system`
                        # and raises "System message must be at the beginning." for any later one
                        # (chat_template.jinja), so a system note here would fail the whole call
                        # instead of nudging the model. A user-role note also lands adjacent to
                        # the generation point, which is what makes it work.
                        messages.append({"role": "user", "content":
                                         "[system] 你刚才只描述了下一步，并没有调用任何工具，所以回合就结束了。"
                                         "如果任务还没做完：现在就调用工具真正执行，不要只说明计划。"
                                         "如果确实已经全部完成：用一句话明确说明「已完成」和产出文件，"
                                         "不要再用「开始/接下来」这类措辞。"})
                        touch()
                        continue
                    # --- automated self-test gate (mirror of loop.py): a stated
                    # "done" must verify green. This serve path runs its own turn loop,
                    # so the wiring has to exist HERE too or config.verify never fires.
                    if (self.state.verifier is not None
                            and verify_attempts[0] < self.state.max_verify_retries
                            and (acc["content"] or "").strip()):
                        verify_attempts[0] += 1
                        passed, vout = self.state.verifier.check()
                        self._diag_turn({"kind": "verify", "session": session_id,
                                        "attempt": verify_attempts[0], "passed": passed,
                                        "output": vout[:400]})
                        if not passed:
                            messages.append({"role": "assistant", "content": acc["content"]})
                            messages.append({"role": "user", "content": (
                                f"[self-verify FAILED on attempt {verify_attempts[0]}] "
                                f"The task is not done yet. Verification output:\n{vout[:1500]}\n"
                                f"Fix the cause and try again.")})
                            touch()
                            continue
                    break  # final answer already streamed

                asst_calls = []
                for i, t in enumerate(calls):
                    fn = t.get("function", {})
                    asst_calls.append({"id": t.get("id") or f"call_{rnd}_{i}", "type": "function",
                                       "function": {"name": fn["name"], "arguments": fn.get("arguments", "")}})
                messages.append({"role": "assistant", "content": acc["content"] or None, "tool_calls": asst_calls})
                for i, t in enumerate(calls):
                    if cancel.is_set():
                        break
                    fn = t.get("function", {})
                    name = fn["name"]
                    args_raw = fn.get("arguments", "{}") or "{}"
                    args, args_ok = parse_tool_args(args_raw)
                    tid = t.get("id") or f"call_{rnd}_{i}"
                    server_part = name.split("__", 1)[0] if "__" in name else ""
                    if not args_ok:
                        # The arguments were cut off (typically the round ran out of output budget
                        # in the middle of a big file write). Running the tool anyway means running
                        # a real action with missing inputs, so it is skipped and reported back.
                        msg = ("[system] 这次工具调用的参数没有生成完整（JSON 被截断），已跳过、"
                               "未执行任何操作。请把这项操作拆成更小的几步后重新调用。")
                        sse({"strata_mcp": {"event": "call", "id": tid, "name": name, "tool": name,
                                            "server": server_part, "arguments": {}, "round": rnd}})
                        sse({"strata_mcp": {"event": "result", "id": tid, "text": msg, "ok": False,
                                            "chars": len(msg), "truncated": True, "ms": 0,
                                            "state": "error", "skipreason": "arg_truncated"}})
                        messages.append({"role": "tool", "tool_call_id": tid, "content": msg})
                        continue
                    sse({"strata_mcp": {"event": "call", "id": tid, "name": name, "tool": name,
                                        "server": server_part, "arguments": args, "round": rnd}})
                    hb["id"], hb["name"] = tid, name     # the heartbeat now reports on this call
                    t0 = time.time()
                    try:
                        result = ex.call(
                            name, args, cancel=cancel,
                            on_progress=lambda txt: sse({"strata_mcp": {"event": "progress",
                                                                      "id": tid, "text": txt,
                                                                      "round": rnd}}))
                    except Exception as e:                # noqa: BLE001 - one step, not the turn
                        # A tool call is ONE step. `executor._req` raises ToolError on a per-command
                        # timeout, a cancelled call and a dead MCP child; letting that escape killed
                        # the whole SSE stream without a terminator, which the UI can only show as
                        # "连接中断" -- and everything the model had planned was lost. Turn it into an
                        # ordinary failed result the model can react to instead.
                        result = tool_failure_text(e, name)
                        self._diag_turn({"kind": "tool_error", "session": session_id, "round": rnd,
                                         "tool": name, "error": f"{e.__class__.__name__}: {e}",
                                         "elapsed_s": round(time.time() - t0, 1)})
                    ms = int((time.time() - t0) * 1000)
                    hb["id"] = None
                    touch()                            # a finished tool call = progress
                    ok = not is_error(result)
                    if cancel.is_set():
                        sse({"strata_mcp": {"event": "result", "id": tid, "text": "[stopped]",
                                            "ok": ok, "chars": 0, "truncated": False, "ms": ms,
                                            "state": "cancelled"}})
                        break
                    if not ok:
                        sig = name + "|" + json.dumps(args, sort_keys=True, ensure_ascii=False)
                        fail_streak[sig] = fail_streak.get(sig, 0) + 1
                        if fail_streak[sig] >= 3:
                            result += ("\n[system] this exact tool call has failed "
                                       f"{fail_streak[sig]} times in a row -- do NOT repeat it; "
                                       "switch to a different command or approach.")
                    else:
                        sig = name + "|" + json.dumps(args, sort_keys=True, ensure_ascii=False)
                        fail_streak.pop(sig, None)
                    sse({"strata_mcp": {"event": "result", "id": tid, "text": result, "ok": ok,
                                        "chars": len(result), "truncated": False, "ms": ms,
                                        "state": "done" if ok else "error"}})
                    # Bound this tool result in the live history (Loop B), matching Loop A's
                    # lossless head/tail cap: only the most recent `tool_keep_recent` results
                    # stay full (protecting same-turn chains that re-read a just-produced
                    # output); older ones are head/tail truncated inline and the FULL text is
                    # saved to the tool-log for recall_tool_log(). The model still sees the
                    # executor-capped `result` this turn (sent above); only the stored
                    # history entry is tightened.
                    tool_count = sum(1 for m in messages if m.get("role") == "tool")
                    keep_full = (tool_count + 1) <= self.state.tool_keep_recent
                    cap = (lambda s: s) if keep_full else (
                        lambda s: cap_tool_result(
                            s, self.state.tool_result_cap, self.state.tool_head_lines,
                            self.state.tool_tail_lines, self.state.tool_log_dir))
                    # Build multimodal content parts for image-bearing results so the model
                    # actually receives the image (root cause of the "我没有视觉能力" report:
                    # the streaming Loop B previously stored the raw result dict, which the
                    # engine rejects as a non-list tool content and silently drops the image).
                    stored = _build_tool_content(result, cap)
                    messages.append({"role": "tool", "tool_call_id": tid, "content": stored})
                tool_rounds[0] += 1        # this round really executed calls (narration guard)
                if capped and not cancel.is_set():
                    # The round kept its calls, but its budget is spent -- it was cut mid-thought.
                    # Stop here with a reason instead of looping into a round that starts blind.
                    notice("max_tokens", max_tokens=out_cap, resumable=True, rounds=rnd,
                           text=f"本轮达到单轮输出上限（{out_cap} tokens），生成被截断，"
                                "已产出的内容都保留了。点「继续」接着做即可。")
                    break
            else:
                # Ran out of rounds while the model still wanted to call tools. Same contract as
                # the budget stop: keep the work, say why we stopped, offer 继续. Previously the
                # loop just fell through to [DONE] and the turn ended with no explanation.
                notice("rounds", rounds=self.state.max_rounds)
            finish()
        except Exception as e:                             # noqa: BLE001 - must never be a silent cut
            # CONTRACT: every turn terminates with [DONE]. Before this, [DONE] existed only on the
            # un-exceptional path of this try, so ANY exception skipped it and the socket just
            # closed: the browser saw EOF with no terminator and no notice, and could only report
            # "连接中断，本轮未跑完" while the turn's whole plan was silently lost (2026-10-20).
            # Say what happened, keep everything already streamed, and offer 继续.
            msg = f"{e.__class__.__name__}: {e}"
            ending["kind"], ending["detail"] = "crash", msg
            self._diag_turn({"kind": "crash", "session": session_id, "round": turn_no[0],
                             "error": msg, "trace": traceback.format_exc()[-3000:]})
            # Step2-C: a server-side crash is a breakpoint too: record it on the monitor record.
            rec = getattr(self, "record", None)
            if rec is not None:
                rec["end_reason"] = "crash"
                rec["end_detail"] = msg
                rec["resumable"] = True
            try:
                notice("turn_crash", rounds=turn_no[0], error=msg,
                       text=f"本轮在服务端出现异常（{msg}），已停止而不是继续空转。"
                            "已经写入磁盘的内容都保留，点「继续」可以接着做。")
            except Exception:
                pass
            finish()
        finally:
            hb_stop.set()
            self._diag_turn({"kind": "end", "session": session_id, "round": turn_no[0],
                             "ending": "client_gone" if client_gone[0] else ending["kind"],
                             "detail": (client_gone_why[0] or "write failed")
                                       if client_gone[0] else ending["detail"],
                             "elapsed_s": round(time.monotonic() - t_turn, 1)})
            # Step2-C: finalize the breakpoint annotation on the monitor record. The timeline
            # already shows the exact chunk the turn reached; here we freeze the reason, the
            # chunk count and the last chunk type so the debug drawer can render a breakpoint
            # ("broke after N chunks, at a <type> event, reason: …").
            rec = getattr(self, "record", None)
            if rec is not None:
                tl = rec.get("chunk_timeline") or []
                rec["chunks"] = len(tl)
                rec["last_chunk_type"] = tl[-1]["type"] if tl else None
                if "end_reason" not in rec:
                    rec["end_reason"] = "client_gone" if client_gone[0] else ending["kind"]
                if "resumable" not in rec:
                    rec["resumable"] = False
                # Step3-B: freeze a stable total duration from the timeline (wallclock_s in
                # request_records keeps growing for finished turns, so the waterfall must use this).
                try:
                    rec["duration_s"] = round(max((e.get("t", 0) for e in tl), default=0.0), 4)
                except Exception:
                    rec["duration_s"] = None
                rec["end_detail"] = rec.get("end_detail") or (
                    (client_gone_why[0] or "write failed") if client_gone[0] else ending["detail"])
            # Near-real-time behavior judge: fire AFTER the turn is fully closed, on a
            # daemon thread, so it cannot delay the stream. Findings land in
            # judge_stream.jsonl and are surfaced by tools/scan_session.py.
            try:
                self._async_judge_turn(session_id, acc, shown_content, ending["kind"], known_tools)
            except Exception:
                pass
            if stop_id:
                self.state.unregister_stream(stop_id)
            self.state.end_interaction()

    def _llm_stream(self, messages, tools, cancel=None, stall_s=None, max_tokens=None,
                    reasoning_effort=None, reasoning_budget=None, sampling=None):
        """Stream chat/completions from the upstream and yield each parsed SSE data object.

        A background reader thread drains the upstream socket into a queue while the caller
        iterates. The reader watches `cancel`: when set it breaks the read loop, which closes
        the upstream connection — that is what actually tells the 8080 engine to stop
        generating (the engine aborts on client disconnect). The caller also checks `cancel`
        so it stops forwarding tokens within ~0.25s.
        """
        entry = getattr(self, "_model_override", None)       # a custom model picked in the composer
        base = str((entry or {}).get("base_url") or self.state.upstream_url).rstrip("/")
        model = (entry or {}).get("model") or self.state.model
        url = base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")
        body = {"model": model, "messages": messages, "stream": True,
                "max_tokens": int(max_tokens or DEFAULT_OUTPUT_TOKENS)}
        # Forwarded, never pinned: an unknown value makes the upstream answer 400, so anything
        # outside REASONING_EFFORTS was already dropped and we simply let the engine choose.
        if reasoning_effort:
            body["reasoning_effort"] = reasoning_effort
        if reasoning_budget:                     # explicit cap; omitted for 跟随模型 -> engine default
            body["reasoning_budget_tokens"] = reasoning_budget
        if sampling:
            # Only the keys the composer actually set. temperature 0 is meaningful (greedy),
            # so it is forwarded too -- "unset" is expressed by the key being absent.
            body.update(sampling)
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        auth = self.headers.get("Authorization")
        if entry is not None and entry.get("api_key"):
            req.add_header("Authorization", "Bearer " + str(entry["api_key"]))
        elif auth:
            req.add_header("Authorization", auth)
        elif self.state.api_key:
            req.add_header("Authorization", f"Bearer {self.state.api_key}")

        q: "queue.Queue" = queue.Queue()

        def _read():
            """Push parsed payloads into the queue until upstream ends or cancel is set.

            We poll the upstream socket with select() (0.25s) and only call readline() when
            data is actually readable. This deliberately avoids setting a short socket timeout:
            a short timeout makes urllib's chunked-transfer decoder raise socket.timeout
            mid-chunk, which silently corrupts the decoder so every later SSE line is lost.
            A slow response (e.g. a vision turn where the engine thinks for several seconds
            before emitting) hits that idle gap and then streams nothing for the rest of the
            turn — that is what surfaced as the 180s idle watchdog firing when an image was
            sent. select() gives the same cancel/stall-wakeup cadence without touching the
            socket timeout.
            """
            last = [time.monotonic()]      # last payload time: the stall watch
            stalled = [False]
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    # Fileno for select-based polling. Fall back to a short socket timeout
                    # only when the transport exposes no usable fileno (rare / non-socket).
                    _sock = None
                    try:
                        _sock = r.fp.raw._sock
                    except Exception:
                        _sock = getattr(r, "_sock", None)
                    try:
                        fn = r.fileno()
                    except Exception:
                        fn = None
                    if fn is None and _sock is not None:
                        try:
                            _sock.settimeout(0.25)
                        except Exception:
                            pass
                    while True:
                        if cancel is not None and cancel.is_set():
                            break
                        # A local engine can accept the request and then wedge (GPU OOM, model
                        # swap) without ever closing the socket. Without this the turn would hang
                        # until the 600s urlopen timeout; the stall window ends it in ~idle_timeout_s.
                        if stall_s and (time.monotonic() - last[0]) > stall_s:
                            stalled[0] = True
                            break
                        if fn is not None:
                            try:
                                rdy, _, _ = select.select([fn], [], [], 0.25)
                            except (OSError, ValueError):
                                rdy = [fn]
                        else:
                            rdy = [1]
                        if not rdy:
                            continue
                        try:
                            raw = r.readline()
                        except (socket.timeout, OSError):
                            continue
                        if not raw:
                            break
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            continue
                        try:
                            item = json.loads(payload)
                        except Exception:
                            continue
                        last[0] = time.monotonic()       # real output = the turn is alive
                        q.put(item)
            except urllib.error.HTTPError as he:
                # A request-level error (e.g. 8080 returned 400 "exceeds the context window").
                # Keep the status + body so the loop can recognise a context overflow and turn it
                # into a recoverable notice instead of a fatal red error.
                detail = ""
                try:
                    detail = he.read().decode("utf-8", "replace")
                except Exception:
                    pass
                q.put(("__http_error__", he.code, he.reason, detail))
            except Exception as e:  # surface as a sentinel so the generator can raise
                q.put(("__error__", str(e)))
            finally:
                if stalled[0]:
                    q.put(("__stalled__", stall_s))
                q.put(None)  # end-of-stream sentinel

        reader = threading.Thread(target=_read, daemon=True)
        reader.start()

        while True:
            try:
                item = q.get(timeout=0.25)
            except queue.Empty:
                if cancel is not None and cancel.is_set():
                    break
                if not reader.is_alive():
                    break  # upstream died without a sentinel
                continue
            if item is None:
                break
            if isinstance(item, tuple) and item and item[0] == "__stalled__":
                raise UpstreamStalled(str(item[1]))
            if isinstance(item, tuple) and item and item[0] == "__http_error__":
                raise UpstreamHTTPError(item[1], item[2] or "", item[3] or "")
            if isinstance(item, tuple) and item and item[0] == "__error__":
                raise Exception(item[1])
            yield item

    @staticmethod
    def _merge_tc(calls, fragments):
        for tc in fragments:
            idx = tc.get("index", 0)
            while len(calls) <= idx:
                calls.append({"id": "", "function": {"name": "", "arguments": ""}})
            c = calls[idx]
            if tc.get("id"):
                c["id"] = tc["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                c["function"]["name"] += fn["name"]
            if fn.get("arguments"):
                c["function"]["arguments"] += fn["arguments"]


# ─── Entry point ─────────────────────────────────────────────────────────────────


    # ---- garbage-recycle (debug page card). Sends to the real Windows Recycle Bin via
    # Shell.Application COM (subprocess powershell; pywin32 not installed). Never a physical delete:
    # trash -> InvokeVerb delete, restore -> match-by-name in the bin and CopyHere back to the
    # recorded origin. An append-only JSONL audit ledger lives under <ws>/.strata-recycle/.
    RECYCLE_WHITELIST = ("RULES.md", "DESIGN.md", "MEMORY.md", "app.js", "app.css", "index.html",
                         "i18n.js", "server.py", "sprite.svg", "tokens.css", "components.css")
    RECYCLE_SCAN_DIRS = ("outputs", "logs", ".pytest_cache")          # whole-dir candidates
    RECYCLE_SCAN_ROOT_PAT = re.compile(r"^_.*[.](txt|png|log|md|json|html)$", re.I)  # top-level scratch
    RECYCLE_SCRATCH_PAT = re.compile(r"^_[^/\\]+[.](py|txt|png|log|md|json|html)$", re.I)  # agent scratch scripts
    RECYCLE_BACKUP_PAT = re.compile(r"[.]bak(-.*)?$", re.I)              # manual backups, anywhere
    RECYCLE_GENERATED_PAT = re.compile(r"[.](png|html)$", re.I)          # outputs/ images+html (regenerable)
    RECYCLE_CACHE_DIRS = (".pytest_cache", "__pycache__")               # whole-dir caches
    RECYCLE_CATEGORY_DEFAULTS = ("scratch_scripts", "backups", "generated", "caches")  # B1: 4 default-on
    RECYCLE_RETENTION_FLOOR_H = 1.0                                      # retention only gates tool_log; floor 1h

    def _recycle_paths(self, req):
        # [ws-空修复 2026-11-16] an empty workspace no longer bails: the ledger lands on the INSTALL ROOT
        # default. Callers only send a ws-empty request for url-shape paths (they resolve to the install
        # root via _recycle_resolve anyway); a fully unresolvable batch stays rejected by its own caller.
        ws = (req.get("workspace") or "").strip()
        base = Path(ws) if ws else Path(ROOT)
        ledger = base / ".strata-recycle" / "ledger.jsonl"
        return base, ledger

    def _recycle_scan(self, req):
        base, ledger = self._recycle_paths(req)
        if base is None or not base.is_dir():
            return 400, {"error": {"message": "workspace not found"}}
        cats = req.get("categories")
        cats = set(cats) if isinstance(cats, list) and cats else None
        try:
            retention_h = float(req.get("retention_hours", 72.0))
        except (TypeError, ValueError):
            retention_h = 72.0
        retention_h = max(self.RECYCLE_RETENTION_FLOOR_H, retention_h)
        cutoff = time.time() - retention_h * 3600.0
        out = []
        def add(f, category):
            if cats is not None and category not in cats:
                return
            name = f.name
            wl = name in self.RECYCLE_WHITELIST or ".strata-memory" in str(f)
            try:
                st = f.stat()
            except Exception:
                return
            if category == "tool_log" and st.st_mtime > cutoff:
                return
            out.append({"path": str(f), "name": name, "size": st.st_size,
                        "mtime": int(st.st_mtime), "type": ("dir" if f.is_dir() else "file"),
                        "category": category, "source": category, "whitelisted": wl})
        for root in (base, base / "tools"):
            if root.is_dir():
                for f in sorted(root.iterdir()):
                    if f.is_file() and self.RECYCLE_SCRATCH_PAT.match(f.name):
                        add(f, "scratch_scripts")
        for f in sorted(base.rglob("*")):
            if f.is_file() and self.RECYCLE_BACKUP_PAT.match(f.name):
                add(f, "backups")
        op = base / "outputs"
        if op.is_dir():
            for f in sorted(op.rglob("*")):
                if f.is_file() and self.RECYCLE_GENERATED_PAT.match(f.name):
                    add(f, "generated")
            for f in sorted(op.rglob("*")):
                if f.is_file() and (f.name.startswith("_") or f.name.endswith(".log")) and not self.RECYCLE_GENERATED_PAT.match(f.name):
                    add(f, "run_logs")
        for dname in self.RECYCLE_CACHE_DIRS:
            p = base / dname
            if p.is_dir():
                for f in sorted(p.rglob("*")):
                    if f.is_file():
                        add(f, "caches")
        lg = base / "logs"
        if lg.is_dir():
            for f in sorted(lg.rglob("*")):
                if f.is_file() and self.RECYCLE_BACKUP_PAT.match(f.name):
                    add(f, "dir_logs")
        tld = Path(os.path.join(ROOT, "data", "tool-log"))
        if tld.is_dir():
            for f in sorted(tld.iterdir()):
                if f.is_file() and f.name.startswith("tl_") and f.name.endswith(".txt"):
                    add(f, "tool_log")
        trashed = []
        if ledger.is_file():
            seen = set()
            for line in io.open(ledger, "r", encoding="utf-8"):
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("action") == "trash":
                    seen.add(rec.get("path"))
                if rec.get("action") == "restore":
                    seen.discard(rec.get("path"))
            for pth in sorted(seen):
                if not Path(pth).exists():
                    trashed.append(pth)
        return 200, {"candidates": out, "in_bin": trashed, "retention_hours": retention_h}
    def _recycle_powershell(self, script):
        r = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "").strip()[:400])
        return (r.stdout or "").strip()

    def _recycle_trash(self, req):
        base, ledger = self._recycle_paths(req)
        paths = req.get("paths") or []
        if base is None or not isinstance(paths, list) or not paths:
            return 400, {"error": {"message": "paths required"}}
        ledger.parent.mkdir(parents=True, exist_ok=True)
        if len(paths) <= _RECYCLE_TRASH_SYNC_MAX:
            # Small batches stay synchronous: a background job + thread pool costs more than
            # it saves when there are only a handful of files.
            done = []
            for raw in paths:
                try:
                    ok = self._recycle_trash_one(raw)
                except Exception as e:
                    return 500, {"error": {"message": "COM send failed: %s" % e}}
                if ok:
                    self._recycle_ledger_append(ledger, str(self._recycle_resolve(raw)))
                    done.append(str(self._recycle_resolve(raw)))
            return 200, {"trashed": done, "skipped": len(paths) - len(done)}
        # Large batch: background job so the caller can poll progress and stop mid-flight.
        job_id = uuid.uuid4().hex
        job = {"total": len(paths), "done": 0, "skipped": 0, "failed": 0, "cancelled": 0,
               "lock": threading.Lock(), "event": threading.Event(), "finished": False}
        with _RECYCLE_JOBS_LOCK:
            _RECYCLE_JOBS[job_id] = job
        threading.Thread(target=self._recycle_trash_run,
                          args=(job, ledger, paths), name="recycle-trash", daemon=True).start()
        return 200, {"job_id": job_id, "total": len(paths)}

    def _recycle_resolve(self, raw):
        # [删除增强 2026-11-15b] a served url shape maps to the install root (data/generated/images,
        # data/saved_images live OUTSIDE any workspace); everything else is workspace-absolute as before.
        clean = str(raw).split("?")[0]
        _n = clean if clean.startswith("/") else "/" + clean   # [缺前导斜杠修复 2026-11-16] normalize so a missing leading slash (stale localStorage generated entries) still maps to the install root
        if _n.startswith("/data/generated/images/"):
            return Path(GENERATED_DIR) / _n[len("/data/generated/images/"):]
        if _n.startswith("/data/saved_images/"):
            return Path(ROOT) / "data" / "saved_images" / _n[len("/data/saved_images/"):]   # same mapping the serving branch uses
        return Path(raw)

    def _api_gallery_reveal(self):
        """POST /api/gallery-reveal {ref}: open the OS folder that CONTAINS a gallery file.
        The ref is a served url (/data/generated/images/.. or /data/saved_images/..) — resolved
        through the SAME install-root mapping the recycle bin uses, so it never lands on the
        session-root resolution that broke the old relative-path call. Opens the PARENT folder.
        """
        import workspace_fs as ws
        body = self._read_json()
        ref = (body.get("ref") or "").strip()
        if not ref:
            self._json(400, {"error": {"type": "invalid_request", "message": "ref required"}})
            return
        target = self._recycle_resolve(ref)   # install-root mapping (url-shape refs only)
        if not str(ref).startswith("/data/") or not target.is_file():
            self._json(400, {"error": {"type": "invalid_request",
                                   "message": "ref must be an existing gallery file url"}})
            return
        folder = target.parent   # reveal the CONTAINING folder, not the file itself
        try:
            ws.open_folder(str(folder))
            self._json(200, {"path": str(folder), "opened": True})
        except (OSError, AttributeError) as e:
            self._json(500, {"error": {"type": "server_error", "message": str(e)}})
            return

    def _recycle_trash_one(self, raw):
        """Send ONE file to the Recycle Bin via its own PowerShell+COM. True = it moved."""
        f = self._recycle_resolve(raw)
        if not f.exists() or f.name in self.RECYCLE_WHITELIST:
            return False
        folder = str(f.parent); name = f.name
        script = ("$sh=New-Object -ComObject Shell.Application;"
                  "$it=$sh.Namespace('%s').ParseName('%s');if($it){$it.InvokeVerb('delete');'OK'}else{'NOITEM'}"
                  % (folder.replace("'", "''"), name.replace("'", "''")))
        return self._recycle_powershell(script) == "OK"

    def _recycle_batch_script(self, paths):
        """One PowerShell that sends a WHOLE batch via a single COM session.
        Emits one result line per path: 'OK:<path>' or 'NOITEM:<path>'."""
        arr = "$paths=@(" + ",".join("'%s'" % p.replace("'", "''") for p in paths) + ");"
        body = ("$sh=New-Object -ComObject Shell.Application;"
                "foreach($p in $paths){"
                "$d=Split-Path $p -Parent;$n=Split-Path $p -Leaf;"
                "$it=$sh.Namespace($d).ParseName($n);"
                "if($it){$it.InvokeVerb('delete');'OK:' + $p}else{'NOITEM:' + $p}}")
        return arr + body

    @staticmethod
    def _recycle_parse_batch(out, batch):
        """Map PowerShell output lines back to paths. Returns (ok_paths, not_found)."""
        by_suffix = {str(Path(p)).lower(): str(p) for p in batch}
        wanted = {p.lower() for p in batch}
        ok, seen = set(), set()
        for line in (out or "").splitlines():
            line = line.strip()
            if line.startswith("OK:"):
                key = line[3:].strip().lower()
                if key in wanted:
                    ok.add(by_suffix[key]); seen.add(key)
            elif line.startswith("NOITEM:"):
                key = line[7:].strip().lower()
                if key in wanted:
                    seen.add(key)
        missing = [by_suffix[k] for k in (wanted - seen)]  # e.g. whitelist-skipped in the pool path
        return sorted(ok), sorted(missing)

    def _recycle_ledger_append(self, ledger, raw):
        f = Path(raw)
        rec = {"action": "trash", "path": str(f), "name": f.name, "size": None,
               "origin": str(f.parent), "ts": int(time.time())}
        with _RECYCLE_LEDGER_LOCK:
            io.open(ledger, "a", encoding="utf-8").write(json.dumps(rec, ensure_ascii=False) + chr(10))

    def _recycle_trash_run(self, job, ledger, paths):
        """Batch pool: one PowerShell handles _RECYCLE_TRASH_BATCH paths, so the process
        cold-start cost (the old bottleneck) is amortised. Stop only cancels batches NOT
        yet started; a batch already running delivers all of it (the bin can undo later,
        this job cannot)."""
        batches = [paths[i:i + _RECYCLE_TRASH_BATCH] for i in range(0, len(paths), _RECYCLE_TRASH_BATCH)]
        def worker(batch):
            if job["event"].is_set():
                with job["lock"]:
                    job["cancelled"] += len(batch)
                return
            try:
                # [批量删除修复 2026-11-16] map url-shape paths to the INSTALL ROOT before
                # PowerShell sees them — the sync path already did this via _recycle_resolve, but the
                # batch job fed RAW urls to _recycle_batch_script (missing the strata-agent/ segment),
                # so every file > the sync threshold silently vanished. Parse-back keys match (we feed
                # the mapped batch to _recycle_batch_script), and the ledger records the mapped path.
                mapped = [str(self._recycle_resolve(x)) for x in batch]
                out = self._recycle_powershell(self._recycle_batch_script(mapped))
            except Exception:
                with job["lock"]:
                    job["failed"] += len(batch)
                return
            # [批量删除回锚修复 2026-11-16b] the OTHER shoe: parse-back keys MUST be the mapped
            # paths we actually fed to PowerShell — the 11-16 fix mapped the INPUT but left parse-back on RAW
            # urls, so every OK line missed the wanted-set, ok_paths came back empty (job said done=0,
            # the ledger logged nothing) even though the files HAD moved. Ledger keys map back to RAW
            # (the ledger´s cross-platform convention: url shape stays url-shaped).
            ok_paths, not_found = self._recycle_parse_batch(out, mapped)
            back = {str(self._recycle_resolve(x)): x for x in batch}
            with job["lock"]:
                job["done"] += len(ok_paths)
                job["skipped"] += len(not_found)
            for p in ok_paths:
                self._recycle_ledger_append(ledger, back.get(p, p))
        with futures.ThreadPoolExecutor(max_workers=_RECYCLE_TRASH_WORKERS) as pool:
            list(pool.map(worker, batches))
        with job["lock"]:
            job["finished"] = True

    def _recycle_progress(self, req):
        job_id = req.get("job_id")
        with _RECYCLE_JOBS_LOCK:
            job = _RECYCLE_JOBS.get(job_id)
        if job is None:
            return 404, {"error": {"message": "no such job"}}
        with job["lock"]:
            out = {"total": job["total"], "done": job["done"], "skipped": job["skipped"],
                   "failed": job["failed"], "cancelled": job["cancelled"],
                   "finished": job["finished"]}
        return 200, out

    def _recycle_cancel(self, req):
        job_id = req.get("job_id")
        with _RECYCLE_JOBS_LOCK:
            job = _RECYCLE_JOBS.get(job_id)
        if job is None:
            return 404, {"error": {"message": "no such job"}}
        job["event"].set()          # cancel files not yet picked up; already-sent ones stay
        return 200, {"cancelled": True}

    def _recycle_restore(self, req):
        base, ledger = self._recycle_paths(req)
        if base is None or not ledger.is_file():
            return 400, {"error": {"message": "no ledger"}}
        targets = req.get("paths") or []
        pending = {}
        for line in io.open(ledger, "r", encoding="utf-8"):
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("action") == "trash":
                pending[rec.get("name")] = rec
            elif rec.get("action") == "restore":
                pending.pop(rec.get("name"), None)
        restored = []
        for name in targets:
            rec = pending.get(name)
            if not rec:
                continue
            origin = rec.get("origin")
            if not origin or not Path(origin).is_dir():
                continue
            script = ("$sh=New-Object -ComObject Shell.Application;$bin=$sh.Namespace(10);"
                      "$hit=$null;foreach($i in $bin.Items()){if($i.Name -eq '%s'){$hit=$i;break}}"
                      "if($hit){$d=$sh.Namespace('%s');$d.CopyHere($hit.Path,16);'OK'}else{'NOITEM'}"
                      % (name.replace("'", "''"), origin.replace("'", "''")))
            try:
                res = self._recycle_powershell(script)
            except Exception as e:
                return 500, {"error": {"message": "COM restore failed: %s" % e}}
            if res != "OK":
                continue
            rec2 = {"action": "restore", "name": name, "path": rec.get("path"), "origin": origin, "ts": int(time.time())}
            io.open(ledger, "a", encoding="utf-8").write(json.dumps(rec2, ensure_ascii=False) + chr(10))
            restored.append(name)
        return 200, {"restored": restored}

    def _recycle_audit(self, req):
        base, ledger = self._recycle_paths(req)
        if base is None:
            return 400, {"error": {"message": "workspace not found"}}
        rows = []
        if ledger.is_file():
            for line in io.open(ledger, "r", encoding="utf-8"):
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
        return 200, {"audit": rows[-200:]}

    def _api_recycle(self, method: str):
        """POST /api/recycle - garbage-recycle card (debug page)."""
        req = self._read_json()
        action = req.get("action")
        if action == "scan":
            code, obj = self._recycle_scan(req)
        elif action == "trash":
            code, obj = self._recycle_trash(req)
        elif action == "progress":
            code, obj = self._recycle_progress(req)
        elif action == "cancel":
            code, obj = self._recycle_cancel(req)
        elif action == "restore":
            code, obj = self._recycle_restore(req)
        elif action == "audit":
            code, obj = self._recycle_audit(req)
        else:
            code, obj = 400, {"error": {"message": "unknown action"}}
        self._json(code, obj)
def run_server(state: GatewayState, host: str = "127.0.0.1", port: int = 8099):
    """Start the gateway HTTP server. Blocking."""
    GatewayHandler.state = state
    # Build the management registry here rather than in GatewayState: it needs an audit
    # log, and this is the one place both the config paths and the log location are known.
    if state.config_path:
        try:
            from registry import Registry
            from audit import AuditLog
            state.registry = Registry(
                state.config_path,
                state.skills_dir or os.path.join(ROOT, "skills"),
                audit=AuditLog(os.path.join(ROOT, "data", "audit.jsonl")),
            )
        except Exception as e:
            print(f"[gateway-http] management API disabled: {e}", file=sys.stderr)
    server = ThreadingHTTPServer((host, port), GatewayHandler)
    print(f"[gateway-http] standalone mode on http://{host}:{port}")
    print(f"[gateway-http]   web root: {WEB_DIR}")
    print(f"[gateway-http]   proxy → {state.upstream_url}")
    if state.registry:
        print(f"[gateway-http]   management API: /api/servers, /api/skills (localhost only)")
    print(f"[gateway-http]   open in browser: http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[gateway-http] shutting down")
        server.shutdown()
