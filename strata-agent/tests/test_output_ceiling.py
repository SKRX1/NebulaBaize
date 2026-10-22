# -*- coding: utf-8 -*-
"""Contract test: the output-budget CEILING must be raisable from the frontend.

The factory OUTPUT_CEILING (32768) used to be write-hardened: the composer's Max tokens
field was clamped to it, so raising it never helped. The fix feeds a per-request
`max_ceiling` from the frontend (drawer field s-ceiling -> body.max_ceiling) into
compute_output_cap's `ceiling` parameter.

  C1  the ceiling param actually MOVES the cap: frontend 65536 > factory 32768 > 16384.
  C2  a frontend ceiling larger than the factory default is honoured (the 32768 is raisable).
  C3  an explicit ask below the raised ceiling is still honoured as a cap.
  Fallback: empty/absent max_ceiling falls back to the factory OUTPUT_CEILING (old saves).
  Window clamp still wins over a big ceiling (a huge ceiling can't trigger an upstream 400).

  Static guards: DEFAULTS has maxCeiling, the send path writes body.max_ceiling, and the
  drawer read/save read+write s-ceiling.

Pure-ASCII assertions only (Chinese is display-only, per the test rule).
Run: python tests/test_output_ceiling.py
"""
import io
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNTIME = ROOT / "runtime"
WEB = ROOT / "serve" / "web"
sys.path.insert(0, str(RUNTIME))

from http_server import compute_output_cap, OUTPUT_CEILING  # noqa: E402


def read_text(p):
    with io.open(str(p), encoding='utf-8') as fh:
        return fh.read()


class CeilingMovesTest(unittest.TestCase):
    def test_ceiling_moves_the_cap(self):
        big = compute_output_cap(0, 131072, 0, ceiling=65536)
        mid = compute_output_cap(0, 131072, 0, ceiling=32768)
        low = compute_output_cap(0, 131072, 0, ceiling=16384)
        self.assertEqual((big, mid, low), (65536, 32768, 16384))

    def test_raised_ceiling_beats_factory(self):
        self.assertEqual(compute_output_cap(0, 131072, 0, ceiling=90000), 90000)

    def test_ask_below_raised_ceiling(self):
        self.assertEqual(compute_output_cap(50000, 131072, 0, ceiling=90000), 50000)


class FallbackTest(unittest.TestCase):
    def test_empty_ceiling_falls_back_to_factory(self):
        self.assertEqual(compute_output_cap(0, 131072, 0, OUTPUT_CEILING), OUTPUT_CEILING)

    def test_window_clamp_wins_over_big_ceiling(self):
        self.assertEqual(compute_output_cap(0, 131072, 120000, ceiling=200000), 6976)


class StaticWiringTest(unittest.TestCase):
    def test_defaults_has_field(self):
        self.assertIn('maxCeiling: ""', read_text(WEB / 'app.js'))

    def test_send_writes_body_field(self):
        self.assertIn('body.max_ceiling = +settings.maxCeiling', read_text(WEB / 'app.js'))

    def test_loaddrawer_reads_field(self):
        self.assertIn('s-ceiling").value = s.maxCeiling', read_text(WEB / 'app.js'))

    def test_save_writes_field(self):
        self.assertIn('maxCeiling: $("s-ceiling").value.trim()', read_text(WEB / 'app.js'))

    def test_html_has_input(self):
        self.assertIn('id="s-ceiling"', read_text(WEB / 'index.html'))

    def test_backend_reads_body_field(self):
        src = read_text(RUNTIME / 'http_server.py')
        self.assertIn('get("max_ceiling")', src)
        self.assertIn('compute_output_cap(_asked, _win or self.state.ctx_window(), _lp, _ceiling)', src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
