# -*- coding: utf-8 -*-
"""CI test: shell-server output truncation must NOT produce mojibake on UTF-8 output.

The rule this guards (2026-10-26 finding, promoted from the one-shot
servers/_verify_after_restart.py into CI):

  shell_server captures stdout/stderr into temp files, then reads at most
  _MAX_OUTPUT_BYTES+1 bytes. When a capture is LONGER than the cap, the read is
  truncated at a raw BYTE boundary. If that boundary lands mid multi-byte character,
  a naive decode would emit U+FFFD, and worse -- if the surviving bytes happen to
  also be valid GBK, smart_decode's GBK fallback wins and returns whole-segment
  mojibake ("星云智能体" truncated by 1 byte -> "鏄熶簯鏅鸿兘浣").

  _trim_incomplete_utf8_tail trims the dangling lead+continuations back to the last
  WHOLE character before decoding, so the decoder always sees complete characters.
  A whole (untruncated) capture is decoded as-is so a genuine GBK (cmd.exe built-in)
  stream is never mangled -- the trim only ever sees a truncated UTF-8 stream.

  Threshold: _MAX_OUTPUT_BYTES == 2_000_000 (2MB). Daily output basically never
  reaches 2MB, so the mojibake path rarely fires; this test forces it.

NOTE on the byte math: CAP = 2_000_000 and 2_000_000 % 3 == 2, so a slice head of a
pure-3-byte-CJK stream ends 2 bytes into a char (lead + 1 continuation, missing the
3rd) -> trim drops exactly those 2 bytes.

Run: python tests/test_shell_utf8_trim.py
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS = os.path.join(ROOT, "servers")
sys.path.insert(0, SERVERS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import shell_server as sh                      # noqa: E402
from shell_server import _trim_incomplete_utf8_tail as trim   # noqa: E402
from _mcp_base import smart_decode as sd        # noqa: E402

CAP = sh._MAX_OUTPUT_BYTES
CN = "\u4e2d"      # CJK ideograph, 3 bytes in UTF-8 (the 1110xxxx range)
CN2 = "\u6587"     # 3 bytes

assert CAP == 2_000_000
assert CAP % 3 == 2   # the math this test relies on


def cn_run(n_chars):
    """A UTF-8 string of n_chars all-CJK chars (3 bytes each => len(n_chars*3))."""
    return CN * n_chars


class CapTest(unittest.TestCase):
    def test_cap_is_2mb(self):
        self.assertEqual(CAP, 2_000_000)


class TrimOnTruncatedBoundaryTest(unittest.TestCase):
    """Simulate a slice head that ends mid-character and require the trim drops it."""

    def test_real_cap_cut_drops_partial_char(self):
        # full pure-CJK stream bigger than cap; slice head = out_b[:CAP].
        # CAP % 3 == 2 -> last char incomplete (lead + 1 continuation) -> drop 2 bytes.
        full = cn_run((CAP + 6) // 3)                       # > CAP bytes
        slice_head = full.encode("utf-8")[:CAP]             # 2_000_000 bytes
        trimmed = trim(slice_head)
        self.assertEqual(len(slice_head) - len(trimmed), 2)
        decoded = sd(trimmed)
        self.assertNotIn("\ufffd", decoded)
        self.assertEqual(decoded, full[:CAP // 3])          # whole chars only (floor)
        self.assertEqual(len(decoded), CAP // 3)            # 666666 whole chars

    def test_onebyte_lead_of_threebyte_char(self):
        filler = cn_run(5000)
        data = filler.encode("utf-8") + CN.encode("utf-8")[:1]   # lead only
        self.assertEqual(trim(data), filler.encode("utf-8"))
        self.assertNotIn("\ufffd", sd(trim(data)))

    def test_lead_plus_one_cont_of_threebyte_char(self):
        filler = cn_run(5000)
        data = filler.encode("utf-8") + CN.encode("utf-8")[:2]   # lead + 1 continuation
        self.assertEqual(trim(data), filler.encode("utf-8"))

    def test_two_byte_char_lead_only(self):
        ch = "\u00e9"                                  # 2 bytes: c3 a9
        self.assertEqual(len(ch.encode("utf-8")), 2)
        filler = cn_run(5000)
        data = filler.encode("utf-8") + ch.encode("utf-8")[:1]   # lead only
        self.assertEqual(trim(data), filler.encode("utf-8"))

    def test_four_byte_char_lead_only(self):
        emoji = "\U0001F680"
        self.assertEqual(len(emoji.encode("utf-8")), 4)
        filler = cn_run(5000)
        data = filler.encode("utf-8") + emoji.encode("utf-8")[:1]   # lead only
        self.assertEqual(trim(data), filler.encode("utf-8"))

    def test_four_byte_char_three_of_four_kept(self):
        emoji = "\U0001F680"
        filler = cn_run(5000)
        data = filler.encode("utf-8") + emoji.encode("utf-8")[:3]   # lead + 2 cont, missing 4th
        self.assertEqual(trim(data), filler.encode("utf-8"))


class PassthroughTest(unittest.TestCase):
    def test_exact_boundary_no_trim(self):
        # data ending exactly on a whole char -> untouched.
        data = cn_run(CAP // 3).encode("utf-8")   # 666666 whole chars
        self.assertEqual(trim(data), data)

    def test_ascii_only_untouched(self):
        data = b"plain ascii output" * 1000
        self.assertEqual(trim(data), data)

    def test_empty_passthrough(self):
        self.assertEqual(trim(b""), b"")

    def test_trailing_full_multibyte_never_raises(self):
        data = cn_run(500).encode("utf-8")
        self.assertEqual(trim(data), data)
        self.assertIsInstance(sd(trim(data)), str)


class GbkPassthroughTest(unittest.TestCase):
    def test_gbk_full_capture_decodes_right(self):
        # A whole (untruncated) capture is decoded as-is; smart_decode resolves GBK.
        text = (CN + CN2) * 5000
        gbk_bytes = text.encode("gbk")
        self.assertLessEqual(len(gbk_bytes), CAP)
        self.assertEqual(sd(gbk_bytes), text)


class FullTruncationPathTest(unittest.TestCase):
    """End-to-end: replicate shell_server.call_tool's truncation branch for UTF-8 output."""

    def _truncate_decode(self, out_b):
        # mirrors call_tool: if len > cap -> trim slice head then decode
        if len(out_b) > CAP:
            return sd(trim(out_b[:CAP]))
        return sd(out_b)

    def test_over_cap_utf8_output_decodes_clean(self):
        # 2.5 MB of pure UTF-8 Chinese; read(cap+1), run the truncation path
        full = CN * (2_500_000 // 3)
        out_b = full.encode("utf-8")[:CAP + 1]        # read(cap+1)
        self.assertGreater(len(out_b), CAP)           # truncation fires
        decoded = self._truncate_decode(out_b)
        self.assertNotIn("\ufffd", decoded)
        self.assertTrue(decoded.startswith(CN * 100))
        self.assertTrue(decoded.endswith(CN))         # ends on a whole char
        self.assertEqual(len(decoded), CAP // 3)      # 666666 whole chars, no partial

    def test_under_cap_passthrough(self):
        full = CN * (500_000 // 3)
        out_b = full.encode("utf-8")
        self.assertLessEqual(len(out_b), CAP)         # no truncation
        self.assertEqual(self._truncate_decode(out_b), full)


if __name__ == "__main__":
    unittest.main(verbosity=2)
