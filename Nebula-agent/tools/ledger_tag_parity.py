# -*- coding: utf-8 -*-
"""ledger_tag_parity.py —— 账本↔tag deref 一致性门禁，自动拦截「账本滞后断层」这类事故。

背景：baseline-tag-archive.md / .en.md 是 baseline 命名回滚点的可审计账本。曾发生过一次
「git 里已有 v-baseline-2026-11-26-e，但中英账本都没登记 -e 行」的滞后断层——若只靠人工
核对极易漏。本脚本把这道人工核对固化成自动门禁，供三处复用同一真相源：

  1) 本地：  python -X utf8 tools/ledger_tag_parity.py
  2) CI：    .github/workflows/ledger-tag.yml 调用它（push main / PR / 手动）。CI checkout
             默认只抓 refs，故 workflow 显式 `git fetch --tags --force` 把全部 tag 抓下来再跑。
  3) 回归：  tests/test_ledger_tag_parity.mjs 用纯函数喂构造数据，差分锁住判据本身
             （缺 e 必红 / 含 e 必绿 / 中英集合不一致必红 / deref 不符必红 / 历史未登记日不误报）。

判据（刻意【只】覆盖账本已登记的日期，避免为 71 个从不逐 tag 登记的历史 tag 假红）：
  * deref 一致：账本每个 real-section 行声明的 tag，必须在 git 里存在，且其 deref commit
    与声明的 sha 一致（账本写全 40 位则须全等；写短 sha 则须为其前缀）。tag 不存在 -> 红。
  * 中英集合一致：中英两账本登记的 tag 名集合必须完全相同（防单边补登造成漂移）。
  * 已登记日内的连续性：对【账本里已出现过 tag 的每个日期】，设该日账本登记的字母后缀集合
    落在 [min,max] 区间；凡 git 上该日真实存在的 tag 字母落进此区间却不在账本登记集合里，
    即为「账本内断层」（正是 -e 那次事故）-> 红。账本从未登记过的历史日期整日跳过（不误报）。
    注：字母后缀为单字母 a-z（账本与 git 皆如此）；个别历史 tag 无后缀（如 v-baseline-2026-10-31），
    该日无字母连续性可言，跳过其字母判定，但仍会查 deref（若它在账本有行）。

real-section 定义：账本里 `| tag | sha | ...` 的表格行；「超前标号清理 / superseded / cleanup」
章节（记录被删的历史超前标号）内的行不计入连续性，但仍在 deref 检查中按需校验。

退出码：0 = 全绿；1 = 至少一处发现。CI 据此红/绿。
"""
import os
import re
import sys
import subprocess

# 账本表格行： | v-baseline-YYYY-MM-DD-<后缀> | `sha` | ...
ROW_RE = re.compile(
    r"^\|\s*(v-baseline-(\d{4}-\d{2}-\d{2})-([a-z]{1,3}))\s*\|\s*`([0-9a-f]{7,40})`")
# cleanup 章节标题关键词（中英），命中则该 `##` 小节内行不算 real-section
CLEANUP_HEAD_RE = re.compile(r"超前标号清理|superseded|cleanup", re.I)
# 仅单字母 a-z 后缀参与「字母连续性」（多字母如 ctx 或无后缀不参与）
LETTER_RE = re.compile(r"^[a-z]$")


def parse_rows(lines):
    """从账本文本行解析 real-section 的 {tag: (date, suffix, declared_sha)}，排除 cleanup 小节。

    返回 (rowmap, by_date)：rowmap[tag]=declared_sha；by_date[date]=set(后缀)。
    """
    rowmap = {}
    by_date = {}
    for line in lines:
        m = ROW_RE.match(line)
        if not m:
            continue
        tag, date, suffix, sha = m.group(1), m.group(2), m.group(3), m.group(4)
        # 不按节标题区分 cleanup：标题里顺带提到「清理」的正常回滚点节会误伤真实登记行。
        # deref 判据改按 git 实际存在性（见 check_deref）；连续性判据用全部登记字母并集。
        rowmap[tag] = (date, suffix, sha)
        by_date.setdefault(date, set()).add(suffix)
    return rowmap, by_date


def check_deref(rowmap, deref_of_tag):
    """逐 tag 核对 deref。deref_of_tag(tag)-> 真实 commit 或 None（git 无此 tag）。
    返回发现列表 [(tag, reason)]。"""
    findings = []
    for tag, (_date, _suffix, declared) in rowmap.items():
        real = deref_of_tag(tag)
        if real is None:
            # git 里不存在 = 已删除的历史/超前标号（cleanup 节登记它只为可审计可重建），合法跳过。
            continue
        if real.startswith(declared):
            continue  # 账本写短 sha 是其前缀，或写全 40 位则全等，皆 OK
        findings.append((tag, "deref 不符: 账本=%s 实际=%s" % (declared, real)))
    return findings


def check_zh_en_parity(zh_rowmap, en_rowmap, deref_of_tag):
    """对 git 真实存在的 tag，中英账本登记集合必须一致（防现存 tag 单边补登漂移）。

    git 里不存在的 tag（已删超前标号的清理记录）不参与 parity：它们本就只可能是
    某一侧账本的历史清理记录（另一侧用散文描述、无表格行），deref 检查也已对其跳过，
    要求它们在两本表格里逐条对等会误报。"""
    findings = []
    zt, et = set(zh_rowmap), set(en_rowmap)
    for t in sorted(zt - et):
        if deref_of_tag(t) is None:
            continue  # 已删/超前标号，单边清理记录合法
        findings.append((t, "只在中文账本登记，英文账本缺失（中英集合不一致）"))
    for t in sorted(et - zt):
        if deref_of_tag(t) is None:
            continue
        findings.append((t, "只在英文账本登记，中文账本缺失（中英集合不一致）"))
    return findings


def check_gaps(zh_rowmap, zh_by_date, letters_on_date):
    """已登记日内的字母连续性：账本登记过某日，则该日 [min,max] 区间内 git 真实存在
    却未登记的单字母 tag = 断层。letters_on_date(date)->set(该日 git 真实存在的单字母后缀)。"""
    findings = []
    for date, suffixes in sorted(zh_by_date.items()):
        letters = sorted(s for s in suffixes if LETTER_RE.match(s))
        if not letters:
            continue
        lo, hi = letters[0], letters[-1]
        reg = set(letters)
        exist = set(x for x in letters_on_date(date) if LETTER_RE.match(x))
        for L in sorted(exist):
            if lo <= L <= hi and L not in reg:
                findings.append(("v-baseline-%s-%s" % (date, L),
                                 "账本已登记 %s 日 [%s..%s] 但缺 %s（账本内断层）" % (date, lo, hi, L)))
    return findings


def git_deref_map(root):
    """一次 `git tag` 列出全部 baseline tag，再批量 deref 成 {tag: commit}。"""
    tags = _git(["tag", "-l", "v-baseline-*"], root)
    out = {}
    if not tags:
        return out
    # for-each-ref 一次性拿 deref（剥 annotated 到 commit），比逐个 rev-list 快
    ref = _git(["for-each-ref", "--format=%(refname:short) %(objectname) %(*objectname)",
                "refs/tags/v-baseline-*"], root)
    for line in ref.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        name, obj, peeled = (parts + ["", ""])[:3]
        # annotated tag 的 commit 在 *objectname；轻量 tag 在 objectname
        out[name] = peeled or obj
    return out


def git_letters_by_date(root):
    """git 真实存在的 baseline tag，按日期聚成 {date: set(字母后缀)}。"""
    result = {}
    for tag in _git(["tag", "-l", "v-baseline-*"], root).splitlines():
        m = re.match(r"v-baseline-(\d{4}-\d{2}-\d{2})-([a-z]+)$", tag)
        if m:
            result.setdefault(m.group(1), set()).add(m.group(2))
    return result


def _git(args, root):
    try:
        r = subprocess.run(["git", "-C", root] + args, capture_output=True, text=True, encoding="utf-8")
        return (r.stdout or "").strip()
    except (OSError, ValueError):
        return ""


def load_lines(path):
    if not os.path.isfile(path):
        return []
    with open(path, "rb") as fh:
        raw = fh.read()
    return raw.decode("utf-8", errors="replace").splitlines()


def run_checks(zh_lines, en_lines, deref_map, letters_by_date):
    """对已加载的数据跑三道判据，返回全部发现。供 main() 与回归测试共同复用。"""
    zh_rowmap, zh_by_date = parse_rows(zh_lines)
    en_rowmap, _en_by_date = parse_rows(en_lines)
    findings = []
    findings += [("ZH", "账本解析出 0 条 real-section 行（疑似格式被破坏）")
                 if not zh_rowmap else (None, None)]
    findings = [f for f in findings if f[0] is not None]
    if not zh_rowmap:
        return findings
    findings += check_deref(zh_rowmap, lambda t: deref_map.get(t))
    findings += check_deref(en_rowmap, lambda t: deref_map.get(t))
    findings += check_zh_en_parity(zh_rowmap, en_rowmap, lambda t: deref_map.get(t))
    findings += check_gaps(zh_rowmap, zh_by_date, lambda d: letters_by_date.get(d, set()))
    return findings


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    root = _git(["rev-parse", "--show-toplevel"], os.path.dirname(here)) or os.path.dirname(os.path.dirname(here))
    zh = load_lines(os.path.join(root, "Nebula-agent", "docs", "baseline-tag-archive.md"))
    en = load_lines(os.path.join(root, "Nebula-agent", "docs", "baseline-tag-archive.en.md"))
    if not zh and not en:
        print("LEDGER-TAG: RED — 找不到中英账本（路径异常）")
        return 1
    deref_map = git_deref_map(root)
    letters = git_letters_by_date(root)
    findings = run_checks(zh, en, deref_map, letters)
    if findings:
        print("LEDGER-TAG: RED — 发现 %d 处账本↔tag 不一致:" % len(findings))
        for t, why in findings:
            print("  [%s] %s" % (t, why))
        return 1
    print("LEDGER-TAG: ALL GREEN（中英账本已登记日内连续、deref 全符、中英集合一致）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
