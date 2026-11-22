#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""backup_precheck.py — backup-bundle 的前置检查（每日备份 task 的第一步）。

背景：backup-bundle 取的是运行时 HEAD，git bundle 只打包【已提交历史】，
工作区未提交改动本就不会进 bundle —— 所以"无漂移"的真正含义不是 status 干净，
而是：先 git fetch 坐实本地与远端 main 没有分叉。

判定（decide(behind, ahead)，behind=远端独有提交数, ahead=本地独有提交数，
来自 git rev-list --left-right --count origin/main...HEAD）：
  - 分叉（behind>0 且 ahead>0）：真异常，必须先人工整合再备份 —— 阻断（退出 2，
    与 backup 用 && 链会因此跳过备份）。
  - 仅本地 ahead（behind=0,ahead>0）：新工作尚未推送，属正常，备份当前点即正确。放行。
  - 仅远端领先 behind（behind>0,ahead=0）：本机落后（别的机器推过）。告警但仍备份本地当前点。放行。
  - 0 0 一致：坐实无分叉。放行。
  - fetch 网络失败 / 读不到 ahead-behind（如全新远端无 origin/main）：best-effort
    —— 告警后仍放行退出 0（bundle 不依赖 fetch 成功，离线也不能漏当天备份）。
输出统一纯 ASCII（经调度器管道/代码页不被吞）。判定纯函数 decide() 可被测试离线差分调用。
"""
import subprocess
import sys

# decide() 返回的退出码语义：0=放行备份，2=阻断（分叉需人工先整合）。
EXIT_PASS = 0
EXIT_BLOCK = 2


def decide(behind, ahead):
    """纯判定，无副作用：输入 (behind, ahead) -> (exit_code, level, message)。

    level ∈ {"FAIL","WARN","OK"}，供调用方原样打印（纯 ASCII）。
    """
    if behind < 0 or ahead < 0:
        raise ValueError("counts must be non-negative, got (%r, %r)" % (behind, ahead))
    if behind > 0 and ahead > 0:
        return (EXIT_BLOCK, "FAIL",
                "diverged: local ahead=%d AND remote-only=%d "
                "-- integrate before backing up (blocking)" % (ahead, behind))
    if behind > 0:
        return (EXIT_PASS, "WARN",
                "behind origin/main by %d -- backing up local HEAD is still safe"
                % behind)
    if ahead > 0:
        return (EXIT_PASS, "OK",
                "local ahead=%d of origin/main (normal unpushed work; "
                "bundle captures current HEAD)" % ahead)
    return (EXIT_PASS, "OK", "0 0 in sync with origin/main -- no divergence")


def _git(args):
    # cwd 由调用方保证在仓库内，git 向上找根。
    p = subprocess.run(["git"] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace",
                       stdin=subprocess.DEVNULL, timeout=120)
    return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()


def ahead_behind():
    rc, out, err = _git(["rev-list", "--left-right", "--count",
                         "origin/main...HEAD"])
    if rc != 0:
        return None
    parts = out.split()
    if len(parts) != 2:
        return None
    try:
        return int(parts[0]), int(parts[1])   # (behind_remote, ahead_local)
    except ValueError:
        return None


def main(argv=None) -> int:
    rc, out, err = _git(["fetch", "origin"])
    if rc != 0:
        print("PRECHECK WARN fetch failed rc=%s (%s) -- continue backup anyway"
              % (rc, err[:120]))
        return EXIT_PASS
    print("PRECHECK fetch OK")

    ab = ahead_behind()
    if ab is None:
        print("PRECHECK WARN cannot read ahead/behind vs origin/main "
              "-- continue backup anyway")
        return EXIT_PASS
    code, level, msg = decide(ab[0], ab[1])
    print("PRECHECK %s %s" % (level, msg))
    return code


if __name__ == "__main__":
    sys.exit(main())
