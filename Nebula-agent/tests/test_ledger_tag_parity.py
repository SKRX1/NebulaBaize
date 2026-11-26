# -*- coding: utf-8 -*-
"""ledger_tag_parity 判据差分锁（纯 stdlib，无外部依赖）。

把「账本↔tag deref 一致性」这道人工核对的判据本身锁成 load-bearing：每道判据都用
单变量差分证它真在起作用（翻转一维，结果随之翻转），而非碰巧空跑。

  S1 已登记日内缺字母（-e 那类账本滞后断层）         -> 必红
  S2 补上缺失字母后                                    -> 必绿（与 S1 构成单变量差分）
  S3 deref 不符（账本声明 sha 与 git 真实 commit 不一致）-> 必红
  S4 已删除的超前标号（账本有行但 git 不存在）        -> 不误报（合法跳过）
  S5 中英集合不一致（只一边登记某 tag）               -> 必红
  S6 中英集合一致                                      -> 绿（与 S5 差分）
  S7 历史未登记日（git 有该日 tag 但账本整日零登记）  -> 不误报（覆盖窗边界）
  S8 真实仓库自举：对当前磁盘账本 + git tag 跑 -> 0 发现（ALL GREEN）

Run: python -X utf8 tests/test_ledger_tag_parity.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # Nebula-agent
sys.path.insert(0, os.path.join(ROOT, "tools"))
import ledger_tag_parity as G  # noqa: E402

FAILURES = []


def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (" " + extra if extra else ""))
    if not cond:
        FAILURES.append(label)


BASE = "2026-12-01"


def tagname(date, letter):
    return "v-baseline-%s-%s" % (date, letter)


def sha40(seed):
    # 40 位 hex，由 seed 派生，账本声明与 deref_map 都用它以保证「匹配」基线
    return ("%040x" % seed)[:40]


def build(git_letters, zh_reg, en_reg=None, deref_override=None):
    """构造 run_checks 的四份输入。
    git_letters: 该日 git 真实存在的字母（决定连续性覆盖窗 + 集合）。
    zh_reg/en_reg: 中英账本各自登记的字母（生成 real-section 行）。
    deref_override: {letter: sha} 覆盖某些 tag 的 deref_map（测 deref 不符）。
    """
    if en_reg is None:
        en_reg = zh_reg
    # git 真实 deref：默认与账本声明一致（sha40(ord(L))），deref_override 单独改写它（测不符）。
    deref = {}
    for L in git_letters:
        deref[tagname(BASE, L)] = sha40(ord(L))
    if deref_override:
        for L, s in deref_override.items():
            deref[tagname(BASE, L)] = s
    letters_by_date = {BASE: set(git_letters)}

    def rows(reg):
        out = ["# 假账本", ""]
        for L in sorted(reg):
            # 账本声明 sha 恒用「匹配基线」sha40(ord(L))，与 deref_map 解耦：
            # 这样 deref_override 改 deref 才能制造「声明 != 实际」的不符（否则夹具自相矛盾）。
            out.append("| %s | `%s` | 性质 |" % (tagname(BASE, L), sha40(ord(L))))
        return out

    return rows(zh_reg), rows(en_reg), deref, letters_by_date


print("=== S1/S2: 已登记日内缺字母 = 账本内断层（单变量差分：补 e 即红翻绿）===")
# git 有 a..f，账本登记 a,b,c,d,f（缺 e）-> 区间 [a..f] 内 e 存在却未登记 -> 红
zh1, en1, deref1, lbd1 = build("abcdef", "abcdf")
f1 = G.run_checks(zh1, en1, deref1, lbd1)
check("S1 缺 e -> 必红（发现断层）", any("缺 e" in w for _t, w in f1), "findings=%s" % (f1,))
# 补上 e -> 绿
zh2, en2, deref2, lbd2 = build("abcdef", "abcdef")
f2 = G.run_checks(zh2, en2, deref2, lbd2)
check("S2 补 e 后 -> 必绿", f2 == [], "findings=%s" % (f2,))
check("S1-vs-S2 差分 load-bearing（唯一变量=是否登记 e）", bool(f1) and not f2)

print("=== S3: deref 不符（账本写错 sha）-> 必红 ===")
# 只翻转 a 的 deref 为不一致值（其余全配），且字母登记完整 -> 仅 deref 一处红
zh3, en3, deref3, lbd3 = build("abcdef", "abcdef", deref_override={"a": sha40(999999)})
f3 = G.run_checks(zh3, en3, deref3, lbd3)
check("S3 deref 不符 -> 必红", any("deref 不符" in w for _t, w in f3), "findings=%s" % (f3,))
# 中英两账本都会各报一次 a 的不符（合理），但绝不应波及其它字母：去重后 tag 集合 == {a}。
tags_reported = set(t for t, _w in f3)
only_deref = all("deref 不符" in w for _t, w in f3)
check("S3 仅波及 a、不误伤其它字母（中英各报一次去重后={a}）",
      tags_reported == {tagname(BASE, "a")} and only_deref,
      "tags=%s deref_only=%s" % (tags_reported, only_deref))

print("=== S4: 已删超前标号（账本有行但 git 不存在）-> 不误报 ===")
# 账本多登记一个 git 没有的 tag（cleanup 节登记被删 tag 的正常情形）
zh4 = build("abcdef", "abcdef")[0] + ["", "| %s | `%s` | 已删超前标号 |" % (tagname(BASE, "z"), sha40(7))]
en4 = build("abcdef", "abcdef")[1] + ["", "| %s | `%s` | 已删超前标号 |" % (tagname(BASE, "z"), sha40(7))]
deref4 = build("abcdef", "abcdef")[2]   # deref_map 里没有 z
lbd4 = {BASE: set("abcdef")}            # git 也没有 z
f4 = G.run_checks(zh4, en4, deref4, lbd4)
check("S4 已删 tag 不误报（git 无则 deref 跳过）", f4 == [], "findings=%s" % (f4,))

print("=== S5/S6: 中英集合一致性（单变量差分）===")
# 英文账本缺 e（中文有）-> 集合不一致红（即便 deref/连续性都对英文无影响）
zh5, en5, deref5, lbd5 = build("abcdef", "abcdef", en_reg="abcdf")
f5 = G.run_checks(zh5, en5, deref5, lbd5)
check("S5 英文缺 e -> 中英集合不一致必红",
      any("中英集合不一致" in w for _t, w in f5), "findings=%s" % (f5,))
# 两边都登记 a..f -> 集合一致绿
f6 = G.run_checks(build("abcdef", "abcdef", en_reg="abcdef")[0],
                  build("abcdef", "abcdef", en_reg="abcdef")[1], deref5, lbd5)
check("S6 中英一致 -> 必绿", f6 == [], "findings=%s" % (f6,))

print("=== S7: 历史未登记日（git 有该日 tag 但账本整日零登记）-> 不误报 ===")
# 在 deref/letters 里多塞一个账本从未登记的日期，账本无该日任何行 -> 连续性不覆盖它
deref7 = build("abcdef", "abcdef")[2]
lbd7 = dict(build("abcdef", "abcdef")[3])
lbd7["2020-01-01"] = set("xyz")          # git 有，但账本完全没登记这天
for L in "xyz":
    deref7[tagname("2020-01-01", L)] = sha40(1000 + ord(L))
f7 = G.run_checks(build("abcdef", "abcdef")[0], build("abcdef", "abcdef")[1], deref7, lbd7)
check("S7 账本未登记的整日被跳过（不误报 71 个历史 tag 那种）", f7 == [], "findings=%s" % (f7,))

print("=== S8: 真实仓库自举 = ALL GREEN ===")
rc = G.main([])
check("S8 对当前磁盘账本+git tag 自举返回 0（全绿）", rc == 0, "rc=%s" % rc)

print("\n%s" % ("LEDGER-TAG-TEST: ALL GREEN" if not FAILURES else "FAILURES: %s" % FAILURES))
sys.exit(1 if FAILURES else 0)
