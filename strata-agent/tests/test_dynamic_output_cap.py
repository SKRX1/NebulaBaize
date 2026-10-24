"""Regression tests for the dynamic per-round output ceiling (2026-10-20).

Covers two things that together kill the "single turn capped at 8192" report:

  1. runtime.http_server.compute_output_cap -- the pure function the agent loop now
     calls every round to scale generation to the FREE context space. Verifies the
     contract: honour an explicit Max tokens as a cap, never exceed the hard ceiling
     (OUTPUT_CEILING), never exceed free window space (so a huge ask can't 400), and
     auto-shrink near a full window.
  2. servers/fs_server.py write mode='append' -- the complementary fix that lets the
     model write a large file in several small calls instead of one giant call that
     blows the per-turn budget.

Run: python tests/test_dynamic_output_cap.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNTIME = ROOT / "runtime"
sys.path.insert(0, str(RUNTIME))  # so `import http_server` and `import output_cap` resolve

from http_server import compute_output_cap, OUTPUT_CEILING  # noqa: E402

CEIL = OUTPUT_CEILING  # 32768 by default


class ComputeOutputCapTest(unittest.TestCase):
    STD = 32768   # pin the factory default so these two cases are immune to a drifted OUTPUT_CEILING
    # Window empty (what the user's screenshot looked like: ~5% used) -> full ceiling.
    def test_empty_window_uses_ceiling(self):
        self.assertEqual(compute_output_cap(0, 131072, 0), CEIL)
        self.assertEqual(compute_output_cap(None, 131072, None), CEIL)

    # Half-full window: ceiling still applies (free space > ceiling).
    def test_half_full_window_uses_ceiling(self):
        # free = 131072 - 80000 - 4096 = 46976 > STD, so the pinned ceiling wins.
        self.assertEqual(compute_output_cap(0, 131072, 80000, ceiling=self.STD), self.STD)

    # Near-full window: budget auto-shrinks to what's free, never 400.
    def test_near_full_window_shrinks(self):
        # free = 131072 - 120000 - 4096 = 6976
        self.assertEqual(compute_output_cap(0, 131072, 120000), 6976)

    # Even closer: floor keeps it at _MIN_CAP (2048), not 0.
    def test_window_floor(self):
        # free would be negative -> clamped to 2048
        self.assertEqual(compute_output_cap(0, 131072, 131000), 2048)

    # Composer asks below ceiling -> honour it.
    def test_explicit_ask_below_ceiling_honoured(self):
        self.assertEqual(compute_output_cap(16384, 131072, 0), 16384)

    # Composer asks above ceiling -> clamped to ceiling (never exceed).
    def test_explicit_ask_above_ceiling_clamped(self):
        self.assertEqual(compute_output_cap(200000, 131072, 0), CEIL)

    # Composer asks above ceiling AND window free is also small -> ceiling wins.
    def test_ceiling_wins_over_ask_and_window(self):
        # asked 50000, ceiling 32768 (pinned), free 36976 -> min(eff,ceiling,free) = 32768
        self.assertEqual(compute_output_cap(50000, 131072, 90000, ceiling=self.STD), self.STD)

    # Composer asks something, window free is the binding constraint -> window wins.
    def test_window_wins_when_smaller_than_ask_and_ceiling(self):
        # asked 50000, ceiling 32768, free = 131072 - 110000 - 4096 = 16976 -> min = 16976
        self.assertEqual(compute_output_cap(50000, 131072, 110000), 16976)

    # Window unknown: ceiling still binds an absurd ask.
    def test_unknown_window_clamps_to_ceiling(self):
        self.assertEqual(compute_output_cap(100000, 0, 0), CEIL)
        self.assertEqual(compute_output_cap(0, 0, 0), CEIL)

    # Unknown window, reasonable ask -> honoured (no free-space clamp available).
    def test_unknown_window_reasonable_ask(self):
        self.assertEqual(compute_output_cap(8192, 0, 0), 8192)


class FsAppendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        env = dict(os.environ)
        env.update({
            "FS_ROOT": str(self.root),
            "FS_ALLOW": str(self.root),
            "FS_ALLOW_FILE": str(self.root / "_no_such_roots.txt"),
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
        })
        self.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "servers" / "fs_server.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=env, cwd=str(ROOT),
            text=True, encoding="utf-8")
        self.rpc("initialize", {})

    def tearDown(self):
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                stream.close()
            except Exception:
                pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        self.tmp.cleanup()

    def rpc(self, method, params, rid=1):
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params},
            ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        self.assertTrue(line, "server closed the connection")
        return json.loads(line)

    def call(self, tool, args):
        r = self.rpc("tools/call", {"name": tool, "arguments": args})
        if r.get("error"):
            return r["error"]["message"], None
        out = r.get("result", {}).get("content") or []
        text = out[0]["text"] if out else ""
        return None, text

    def read(self, path):
        err, text = self.call("read", {"path": path})
        self.assertIsNone(err, err)
        return text

    # overwrite then two appends must concatenate exactly.
    def test_append_concats(self):
        err, _ = self.call("write", {"path": "out.txt", "content": "AAA", "mode": "overwrite"})
        self.assertIsNone(err, err)
        err, _ = self.call("write", {"path": "out.txt", "content": "BBB", "mode": "append"})
        self.assertIsNone(err, err)
        err, _ = self.call("write", {"path": "out.txt", "content": "CCC", "mode": "append"})
        self.assertIsNone(err, err)
        self.assertEqual(self.read("out.txt"), "AAABBBCCC")

    # append to a file that does not exist must create it (not error).
    def test_append_creates_missing_file(self):
        err, _ = self.call("write", {"path": "new.txt", "content": "X", "mode": "append"})
        self.assertIsNone(err, err)
        self.assertEqual(self.read("new.txt"), "X")

    # default mode (no mode given) is overwrite, so it must NOT accumulate.
    def test_default_mode_is_overwrite(self):
        self.call("write", {"path": "d.txt", "content": "1"})
        self.call("write", {"path": "d.txt", "content": "2"})
        self.assertEqual(self.read("d.txt"), "2")

    # illegal mode string is a clear error, never a silent success.
    def test_illegal_mode_rejected(self):
        err, _ = self.call("write", {"path": "z.txt", "content": "q", "mode": "bogus"})
        self.assertIsNotNone(err, "illegal mode must be rejected")
        self.assertIn("overwrite", err)
        self.assertIn("append", err)



class SeparatedThinkAnswerFloorTest(unittest.TestCase):
    """方案A增强：思考预算与正文保底分开算，证明思考吃满后正文仍有独立预算。

    显式传 ceiling=32768（出厂默认），不依赖环境变量——测试必须对运行环境的
    STRATA_MAX_OUTPUT_CEILING 免疫。CEIL 仅在默认环境成立，本类一律用字面 32768。
    """
    STD = 32768

    # 核心场景（用户截图 low 档）：思考=1024 吃满，正文保底=16384 独立可用。
    # 旧版只给到 finish=length 的 ~1.2K；现在思考满后正文仍有 16384。
    def test_low_think_keeps_full_answer_floor(self):
        # 总闸门 = 1024 + 16384 = 17408；窗口空 free=126976，ceiling=32768 -> 取 17408
        self.assertEqual(
            compute_output_cap(0, 131072, 0, ceiling=self.STD,
                               reasoning_budget=1024, answer_floor=16384), 17408)

    # 中档思考 4096 + 正文保底 16384 = 20480。
    def test_medium_think_plus_floor(self):
        self.assertEqual(
            compute_output_cap(0, 131072, 0, ceiling=self.STD,
                               reasoning_budget=4096, answer_floor=16384), 20480)

    # 思考+正文相加超过 ceiling -> ceiling 赢（绝不超过总天花板）。
    def test_sum_over_ceiling_clamped(self):
        # 20000 + 16384 = 36384 > 32768 -> 32768
        self.assertEqual(
            compute_output_cap(0, 131072, 0, ceiling=self.STD,
                               reasoning_budget=20000, answer_floor=16384), 32768)

    # 长历史：free 成为绑定约束（思考+正文再大也受剩余窗口封顶，绝不触发上游 400）。
    def test_long_history_window_wins(self):
        # free = 131072 - 120000 - 4096 = 6976；eff=17408 -> min(17408, 32768, 6976)=6976
        self.assertEqual(
            compute_output_cap(0, 131072, 120000, ceiling=self.STD,
                               reasoning_budget=1024, answer_floor=16384), 6976)

    # 向后兼容：asked=0 且无任何分项 -> 回退 ceiling（旧行为，现有测试依赖此点）。
    def test_no_components_falls_back_to_ceiling(self):
        self.assertEqual(
            compute_output_cap(0, 131072, 0, ceiling=self.STD), self.STD)

    # 显式 asked 优先于分项（asked 是用户对该轮的硬封顶）。
    def test_explicit_ask_outranks_components(self):
        # asked=8192 优先；分项即便更大也不覆盖显式 asked
        self.assertEqual(
            compute_output_cap(8192, 131072, 0, ceiling=self.STD,
                               reasoning_budget=1024, answer_floor=16384), 8192)


if __name__ == "__main__":
    unittest.main(verbosity=2)
