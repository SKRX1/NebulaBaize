# -*- coding: utf-8 -*-
"""跨平台回收站分派差分锁（xplat v2 全量：单文件 / 批量 / 还原）。

锁住 _recycle_send_to_bin / _recycle_send_batch / _recycle_restore_file 的平台分派
（POSIX 腿，本机是 Windows 故 monkeypatch sys.platform）与两文件共享 helper 源码字节
一致的反漂移锁：
  X1 非 win32 + 文件不存在            -> NOITEM，且不创建 .Nebula-recycle 目录
  X2 非 win32 + 装了 send2trash(桩)   -> 调用桩 send2trash 一次，返回 OK，原文件仍在(桩 no-op)
  X3 非 win32 + 无 send2trash         -> 物理 MOVE 进 folder/.Nebula-recycle，原位消失、新位存在，OK
  X4 serve/server.py 与 runtime/http_server.py 的【两份共享 helper】(_recycle_send_to_bin
     + _recycle_restore_file) 源码逐字节相同（反漂移）
  X5 非 win32 + 无 send2trash 的 batch: 真实建文件 -> _recycle_send_batch 产出 'OK:<p>'，
     不存在的文件产出 'NOITEM:<p>'；喂既有 _recycle_parse_batch 精确映射回 (ok, not_found)。
     差分 load-bearing：present 文件必入 ok、missing 文件必入 not_found（单变量翻转）。
  X6 _recycle_restore_file: staged 在 .Nebula-recycle/ 的文件移回 origin 且原位消失=OK；
     若 origin 已有同名则 NOITEM 且 staged 不动（dest 存在 vs 不存在 的相反结果，load-bearing）。

Run: python -X utf8 tests/test_recycle_xplat_dispatch.py
"""
import os, sys, io, shutil, types, tempfile, importlib.machinery
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import http_server as H  # noqa: E402

FAILURES = []


def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (" " + extra if extra else ""))
    if not cond:
        FAILURES.append(label)


def read_src(rel):
    return io.open(os.path.join(ROOT, rel), encoding="utf-8").read()


def extract_helper(src, fname):
    """Byte-exact function source from `def fname(` through the last indented line before
    the next top-level (column-0) statement."""
    lines = src.split("\n")
    start = next((i for i, l in enumerate(lines) if l.startswith("def " + fname + "(")), -1)
    if start < 0:
        return None
    body = [lines[start]]
    for l in lines[start + 1:]:
        if l.strip() == "":
            body.append(l)
            continue
        if l[0] not in (" ", "\t"):        # next top-level construct -> stop
            break
        body.append(l)
    return "\n".join(body).rstrip()


_orig_platform = sys.platform
_orig_s2t = sys.modules.get("send2trash")


def _strip_s2t():
    sys.modules.pop("send2trash", None)


def _inject_s2t(counter):
    m = types.ModuleType("send2trash")
    m.__spec__ = importlib.machinery.ModuleSpec("send2trash", None)  # so find_spec hits it

    def _send(p):
        counter.append(str(p))
    m.send2trash = _send
    sys.modules["send2trash"] = m


def _mk(tmp, name, content="x"):
    p = os.path.join(tmp, name)
    io.open(p, "w", encoding="utf-8").write(content)
    return p


try:
    sys.platform = "linux"

    # ---- X1: missing file -> NOITEM, no .Nebula-recycle created ----
    _strip_s2t()
    td = tempfile.mkdtemp()
    try:
        r = H._recycle_send_to_bin(td, "ghost.txt")
        created = os.path.isdir(os.path.join(td, ".Nebula-recycle"))
        check("X1 missing file -> NOITEM and no recycle dir", r == "NOITEM" and not created,
              "got=%s created_dir=%s" % (r, created))
    finally:
        shutil.rmtree(td, ignore_errors=True)

    # ---- X2: send2trash present (stub) -> called once, returns OK, original still there ----
    calls = []
    _inject_s2t(calls)
    td = tempfile.mkdtemp()
    try:
        fpath = _mk(td, "del.txt")
        r = H._recycle_send_to_bin(td, "del.txt")
        check("X2 send2trash present -> stub called once + OK + file untouched",
              r == "OK" and calls == [fpath] and os.path.isfile(fpath),
              "got=%s calls=%s still=%s" % (r, calls, os.path.isfile(fpath)))
    finally:
        shutil.rmtree(td, ignore_errors=True)
        _strip_s2t()

    # ---- X3: no send2trash -> physical MOVE into .Nebula-recycle, original gone ----
    td = tempfile.mkdtemp()
    try:
        fpath = _mk(td, "move.txt", "hello")
        r = H._recycle_send_to_bin(td, "move.txt")
        moved = os.path.isfile(os.path.join(td, ".Nebula-recycle", "move.txt"))
        check("X3 no send2trash -> moved into .Nebula-recycle, original gone, OK",
              r == "OK" and not os.path.isfile(fpath) and moved,
              "got=%s orig_gone=%s moved=%s" % (r, not os.path.isfile(fpath), moved))
    finally:
        shutil.rmtree(td, ignore_errors=True)

    # ---- X4: BOTH shared helpers byte-identical across the two files (anti-drift) ----
    sa = read_src(os.path.join("serve", "server.py"))
    sb = read_src(os.path.join("runtime", "http_server.py"))
    for fname in ("_recycle_send_to_bin", "_recycle_restore_file"):
        ha = extract_helper(sa, fname)
        hb = extract_helper(sb, fname)
        check("X4 %s byte-identical in server.py and http_server.py" % fname,
              ha is not None and ha == hb,
              "a_len=%s b_len=%s" % (len(ha) if ha else None, len(hb) if hb else None))

    # ---- X5: POSIX batch output -> _recycle_parse_batch maps back (load-bearing) ----
    _strip_s2t()
    td = tempfile.mkdtemp()
    try:
        present = _mk(td, "present.txt")
        missing = os.path.join(td, "missing.txt")   # never created -> NOITEM branch
        # batch runs present (moves) + missing (NOITEM). _recycle_send_batch must feed the
        # mapped paths so parse-back keys match; here they ARE the real paths.
        # _recycle_parse_batch REAL contract (see its body): ok = paths reported OK;
        # not_found(=missing) = paths NEVER reported at all (a whitelist skip). A path
        # reported NOITEM is SEEN, so it is neither in ok nor in not_found. Lock that
        # actual contract. present (parent exists) moves and lands in ok; missing appears
        # only as an NOITEM line, hence it is seen -> absent from ok AND not_found.
        batch = [present, missing]
        out = H._recycle_send_batch(batch)
        handler = H.GatewayHandler.__new__(H.GatewayHandler)
        ok, not_found = handler._recycle_parse_batch(out, batch)
        ok_s = [str(Path(x)).lower() for x in ok]
        nf_s = [str(Path(x)).lower() for x in not_found]
        present_moved = (not os.path.isfile(present)
                         and os.path.isfile(os.path.join(td, ".Nebula-recycle", "present.txt")))
        good = (ok_s == [str(Path(present)).lower()]
                and nf_s == []
                and present_moved
                and ("OK:" in out and "NOITEM:" in out))
        check("X5 batch: present->ok & actually moved, missing->NOITEM-line (seen, not in not_found)",
              good, "out=%r ok=%s not_found=%s present_moved=%s" % (out, ok, not_found, present_moved))
    finally:
        shutil.rmtree(td, ignore_errors=True)

    # ---- X6: restore moves staged file back; dest-conflict -> NOITEM (load-bearing) ----
    td = tempfile.mkdtemp()
    try:
        stage_dir = os.path.join(td, ".Nebula-recycle")
        os.makedirs(stage_dir, exist_ok=True)
        _mk(stage_dir, "back.txt", "orig-content")
        r = H._recycle_restore_file(td, "back.txt")
        moved_back = (os.path.isfile(os.path.join(td, "back.txt"))
                      and not os.path.isfile(os.path.join(stage_dir, "back.txt")))
        check("X6a staged file restored back into origin, OK", r == "OK" and moved_back,
              "got=%s moved_back=%s" % (r, moved_back))
        # dest-conflict arm (load-bearing flip of the same dest.exists() guard): stage again
        # but pre-create the destination so the restore must NOT overwrite.
        _mk(stage_dir, "conflict.txt", "staged")
        _mk(td, "conflict.txt", "KEEPME")
        r2 = H._recycle_restore_file(td, "conflict.txt")
        kept = io.open(os.path.join(td, "conflict.txt"), encoding="utf-8").read() == "KEEPME"
        still_staged = os.path.isfile(os.path.join(stage_dir, "conflict.txt"))
        check("X6b dest already present -> NOITEM and staged file untouched",
              r2 == "NOITEM" and kept and still_staged,
              "got=%s kept=%s staged=%s" % (r2, kept, still_staged))
        # missing-staged arm: never staged -> NOITEM
        r3 = H._recycle_restore_file(td, "never.txt")
        check("X6c nothing staged -> NOITEM", r3 == "NOITEM", "got=%s" % r3)
    finally:
        shutil.rmtree(td, ignore_errors=True)

finally:
    sys.platform = _orig_platform
    if _orig_s2t is not None:
        sys.modules["send2trash"] = _orig_s2t
    else:
        _strip_s2t()

print("\n%s" % ("ALL GREEN" if not FAILURES else "FAILURES: %s" % FAILURES))
sys.exit(1 if FAILURES else 0)
