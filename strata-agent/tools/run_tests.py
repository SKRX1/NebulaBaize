"""Single entry point for the full regression suite (the CI contract).

Runs every suite as a subprocess, aggregates, and exits 0 only when all suites are
green (or skipped). A suite that returns 0 — including its own skip path — counts as
green; any non-zero exit fails the contract. Pure stdlib.

Run from the strata-agent folder:
    python tools/run_tests.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable

# Node for the .mjs suites. PATH first (the managed runtime exports it), then the
# known managed location as a fallback. The .mjs tests resolve jsdom through an
# absolute createRequire, so no NODE_PATH juggling is needed here.
NODE = shutil.which("node") or r"C:\Users\sk\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

# Suites in stable order. e2e / daemon are the live/optional ones; they self-skip
# (return 0) when their gate isn't met, which keeps CI deterministic.
# test_tools_tab_live.mjs is deliberately NOT here: it needs a running host.
SUITES = [
    "tests/test_smoke.py",
    "tests/test_undefined_names.py",
    "tests/test_skillhub.py",
    "tests/test_registry_server.py",
    "tests/test_memory_server_tools.py",
    "tests/test_policy.py",
    "tests/test_i18n.mjs",
    "tests/test_spark.mjs",
    "tests/test_admin_render.mjs",
    "tests/test_stream_intel.mjs",
    "tests/test_sidebar_tree.mjs",
    "tests/test_switch_busy.mjs",
    "tests/test_switch_busy_e2e.mjs",
    "tests/test_edit_resend.mjs",
    "tests/test_steps_fold.mjs",        # 2026-10-20: 执行过程折叠（工具回合收纳中间段，结束自动折叠）
    "tests/test_think_segments.mjs",
    "tests/test_think_latest_open.mjs",
    "tests/test_stop_notice.mjs",
    "tests/test_turn_stats.mjs",
    "tests/test_auto_resume.mjs",
    "tests/test_auto_memory.mjs",
    "tests/test_proposal_card.mjs",
    "tests/test_autosteps.mjs",
    "tests/test_thinking.mjs",
    "tests/test_interrupted_resume.mjs",
    "tests/test_interrupt_log.mjs",
    "tests/test_stream_done.mjs",
    "tests/test_conn_cut_resume.mjs",   # 2026-10-20: transport cut == truncated, NOT fatal
    "tests/test_dynamic_output_cap.py", # 2026-10-20: dynamic per-round cap + fs append mode
    "tests/test_output_ceiling.py",   # 2026-10: the write-hardened 32768 ceiling is raisable from the frontend
    "tests/test_bottom_anchor.mjs",
    "tests/test_tool_timer.mjs",
    "tests/test_stats_flicker.mjs",
    "tests/test_seed_display.mjs",       # 2026-10-20: random seed actually used is shown + replayable
    "tests/test_nebula.mjs",
    "tests/test_compact_resume.js",
    "tests/test_compact_request_flag.js",   # 2026-10-20: compaction turn tagged strata_compact (guard bypass)
    "tests/test_compact_reset.py",         # 2026-10-20: reset_prompt_tokens zeroes occupancy (fixes wedged compact)
    "tests/test_chunked_compact.mjs",      # 2026-10-20: oversized history folds in bounded chunks before the single-shot compact
    "tests/test_compact_target.mjs",       # 2026-10: the compression-target slider actually moves the post-compact tail budget
    "tests/test_stale_tab.mjs",            # 2026-10-20: stale tab detects newer server build and reloads itself once
    "tests/test_model_registry.py",
    "tests/test_gateway_http.py",
    "tests/test_session_compact.py",
    "tests/test_runtime_cap.py",
    "tests/test_tool_multimodal.py",   # 2026-10-20: streaming multimodal tool-result -> parts list
    "tests/test_system_view.py",
    "tests/test_model_forward.py",
    "tests/test_model_switcher.mjs",
    "tests/test_model_probe.mjs",
    "tests/test_runtime_config_frontend.mjs",
    "tests/test_workspace_picker.mjs",
    "tests/test_workspace_fs.py",
    "tests/test_fs_server.py",
    # These three guard "which directory do relative paths resolve against". They existed
    # but were never registered, so the 2026-10-20 wrong-base bug shipped green.
    "tests/test_fs_workspace_base.py",
    "tests/test_shell_workspace_cwd.py",
    "tests/test_workspace_base.py",
    "tests/test_browser.py",
    "tests/test_browser_fallback.py",   # 2026-10-20: VTB hang -> --timeout capture policy
    "tests/test_page_sim.py",           # 2026-10-20: deterministic page sandbox (browser__sim)
    "tests/test_thinking_budget.mjs",   # 2026-10-20: 低/中/高 carry reasoning_budget_tokens; 跟随模型 omits both
    "tests/test_nextsteps_group.mjs",   # 2026-10-20: 推荐建议置顶 + 「推荐」徽标 + 绿/灰双色分组
    "tests/test_proposal_tier.mjs",     # 2026-10-20: 决策卡推荐选项绿档 + 推荐徽标 + 主/幽灵按钮分档
    "tests/test_suggestion_tiers.mjs",  # 2026-10-20: 建议三档（推荐/可选/不推荐）解析+渲染+proposal+i18n
    "tests/test_code_style.mjs",        # 2026-10-20: 代码块语法高亮 + 思考区围栏渲染成真代码卡片
    "tests/test_shell_timeout.py",
    "tests/test_agent_loop.py",
    "tests/test_turn_budget.py",
    "tests/test_empty_round.py",
    "tests/test_turn_guard.py",
    "tests/test_narration_guard.py",
    "tests/test_adversarial_llm.py",
    "tests/test_toolcall_fuzz.py",
    "tests/test_stream_clean.py",
    "tests/test_scan_session.py",
    # New layering (2026-10-20): ⑥ startup self-check, ④ behavior judge, ② soak
    "tests/test_startup_selfcheck.py",
    "tests/test_behavior_judge.py",
    "tests/test_behavior_judge_llm.py",
    "tests/test_soak.py",
    "tests/test_soak_live.py",
    "tests/test_user_scenarios.py",
    "tests/test_async_judge.py",
    "tests/test_executor.py",
    "tests/test_e2e.py",
    "tests/test_daemon.py",
    "tests/test_corpus.py",
    "tools/_seg_scroll_baseline.py",
    "tools/_semantic_summarizer_gate.py",   # live-gate: LLM semantic summarizer >= keyword on decision survival (self-skips if upstream down)
    "tools/_archive_gate.py",   # deterministic gate: archive write/read zero-loss + whitelist N=3 + default-on (locks the recoverable-archive design)
    "tests/test_ctx_denominator.py",   # 2026-10: the gateway denominator == the engine's real n_ctx (no 128K-vs-256K split)
]


def run_suite(rel: str) -> tuple[bool, str]:
    """Return (passed, summary_line). Exit code 0 == green (skip counts as green)."""
    p = os.path.join(ROOT, rel)
    cmd = [NODE if rel.endswith((".mjs", ".js")) else PY, p]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=300, cwd=ROOT)
    except Exception as e:
        return False, f"{rel}: could not run: {e}"
    combined = ((out.stdout or "") + ("\n[stderr]\n" + out.stderr if out.stderr else "")).strip()
    last = combined.splitlines()[-1] if combined else ""
    return out.returncode == 0, f"{rel}: {last}"


def main() -> int:
    results = []
    for s in SUITES:
        ok, line = run_suite(s)
        results.append((s, ok, line))
        print(line)
    print("---- regression summary ----")
    all_ok = all(ok for _, ok, _ in results)
    for _, ok, line in results:
        print(("PASS " if ok else "FAIL ") + line)
    print("REGRESSION: " + ("ALL GREEN" if all_ok else "RED — contract broken"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
