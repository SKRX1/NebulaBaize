# -*- coding: utf-8 -*-
"""secret_scan.py —— 把"token 是否泄露进将被公开的 git 内容"这道手工审计固化成自动门禁。

动机：本仓库的 GitHub token 全程只应经 env / --token-file 传入，绝不落进任何会被推到
公开库（SKRX1/NebulaBaize）的文件里。一次手工审计（对远端那一棵树 grep 真实 token 值
模式，零命中）坐实了它是干净的。本脚本把那套判据固化下来，供三处复用同一个真相源：

  1) 本地：python -X utf8 tools/secret_scan.py            # 扫当前工作区所有【被 git 跟踪】文件
  2) CI / push：.github/workflows/secret-scan.yml 调用它   # push 前/CI 自动守护
  3) 回归：tests/test_secret_scan.py import 本模块的 scan_text / classify，用差分锁住判据
     本身 load-bearing（真 token 必红、占位符/变量名/文档链接必绿）。

判据（gitleaks 风格，纯 stdlib，无外部二进制）：
  * 命中真实凭据形态 -> 报告为发现：
      - GitHub 经典 PAT:        gh[pousr]_ + ≥30 位 base62（真实 classic PAT 恰为 36 位）
      - GitHub fine-grained:    github_pat_ + ≥20 位 [A-Za-z0-9_]
      - 通用 AWS / Slack / Google / Stripe / OpenAI 等强前缀，降低"换厂商就失明"的风险。
  * 占位符/变量名不算泄露（这是把人工排除自动化，是本门禁不误报的关键）：
      - 字符被 < > 包裹（<TOKEN>）、含 * 或 . 省略号（ghp_xxxx…）、
      - 去掉前缀后正文几乎"全同一字符"或含大量非 base62（ghp_xxxxxxxxxxxx 这种示例）、
      - 出现在 gitignored 的 secrets 路径（.Nebula-secrets/、*.secret、.env）。
  真实 token 是 36 位混合 base62，长度+字符熵都远高于上述占位，二者可分。

退出码：0 = 干净；1 = 至少一处发现。CI 直接据此红/绿。
"""
import os
import re
import sys
import subprocess

# 强前缀的真实凭据（捕获组即候选 secret 本体）。刻意要求足够长度，宁漏勿误报——
# 漏报由 tests/test_secret_scan.py 的差分锁兜（它喂真 token 必须命中）。
CREDENTIAL_PATTERNS = [
    ("github-classic-pat", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("github-fine-grained", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("aws-access-key-id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("aws-secret", re.compile(r"(?i)\baws.{0,20}secret.{0,20}[=:]\s*['\"]?([A-Za-z0-9/+=]{30,})")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}\b")),
    ("stripe-key", re.compile(r"\b[rs]k_live_[A-Za-z0-9]{20,}\b")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("huggingface", re.compile(r"\bhf_[A-Za-z0-9]{30,}\b")),
    ("sendgrid", re.compile(r"\bSG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b")),
]

# 这些路径下的内容本就允许含真实凭据（它们已被 .gitignore 排除，不会进任何提交）。
IGNORED_PATH_RE = re.compile(
    r"(^|/)(\.Nebula-secrets/|\.env(\.|$)|[^/]+\.secret$|[^/]+\.secrets$|credentials(\.|$))",
    re.I,
)


def _is_placeholder(tok: str) -> bool:
    """区分真实凭据与"看起来像 token 的占位符/示例/变量名"（这是把人工排除自动化）。"""
    body = tok
    for pre in ("ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_",
                "sk-", "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-", "hf_", "AIza", "AKIA"):
        if body.lower().startswith(pre.lower()):
            body = body[len(pre):]
            break
    if not body:
        return True
    # 含 < > 尖括号、* 星号、. 点（<TOKEN> / ghp_xxxx... / …）→ 占位
    if any(c in tok for c in "<>*…"):
        return True
    # 正文里几乎只有一个不同字符（ghp_xxxxxxxxxxxx、ghp_0000…）→ 示例占位
    core = re.sub(r"[^A-Za-z0-9]", "", body)
    if core and len(set(core)) <= 2:
        return True
    # 正文含明显非凭据字符（下划线开头/结尾、连续下划线，典型是变量名而非值）
    if body.startswith(("_", "-")) or body.endswith(("_", "-")):
        return True
    return False


def classify(name: str, pattern, line_text: str):
    """对一行文本跑某条 pattern，返回真实发现（已剔除占位）的 token 列表。"""
    hits = []
    for m in pattern.finditer(line_text):
        tok = m.group(m.lastindex or 0) if m.lastindex else m.group(0)
        if not _is_placeholder(tok):
            hits.append(tok)
    return hits


def scan_text(path: str, text: str):
    """扫一份文件内容，返回 findings 列表 [(path, line_no, rule, token)]。
    命中 .gitignore 里 secrets 路径的文件整体跳过（那里允许真凭据）。"""
    if IGNORED_PATH_RE.search(path.replace("\\", "/")):
        return []
    findings = []
    for i, line in enumerate(text.splitlines(), start=1):
        for rule, pat in CREDENTIAL_PATTERNS:
            for tok in classify(rule, pat, line):
                findings.append((path, i, rule, tok))
    return findings


def git_toplevel(start: str):
    """git 仓库顶层（即"会被提交/推送"的内容全集所在）。失败回退到 start 的上级。"""
    try:
        out = subprocess.run(["git", "-C", start, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, encoding="utf-8")
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip().strip('"')
    except (OSError, ValueError):
        pass
    return os.path.dirname(os.path.abspath(start))


def tracked_files(root: str):
    """git 跟踪的文件清单（相对 root）。无 git 时回退到空列表。"""
    try:
        out = subprocess.run(["git", "-C", root, "ls-files", "-z"],
                             capture_output=True, text=True, encoding="utf-8")
        if out.returncode != 0:
            return []
        return [p for p in out.stdout.split("\0") if p]
    except (OSError, ValueError):
        return []


def scan_worktree(root: str):
    """扫描工作区中所有被 git 跟踪的文件（这正是"会被提交/推送"的内容）。"""
    all_findings = []
    for rel in tracked_files(root):
        full = os.path.join(root, rel)
        if not os.path.isfile(full):
            continue
        try:
            with open(full, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        # 跳过明显的二进制：含 NUL 即不当文本扫（避免误命中/性能问题）
        if b"\0" in raw[:8192]:
            continue
        text = raw.decode("utf-8", errors="replace")
        all_findings.extend(scan_text(rel, text))
    return all_findings


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # 默认扫"整个 git 仓库顶层"——这才是会被推到公开远端的内容全集；脚本本身放在
    # Nebula-agent/tools 下，故不能只扫脚本上级子目录（会漏掉仓库根的文件）。
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    root = git_toplevel(root)
    if argv:
        root = argv[0]
    findings = scan_worktree(root)
    if findings:
        print("SECRET-SCAN: RED — 发现 %d 处疑似真实凭据（会被提交/推送的内容里）:" % len(findings))
        for path, ln, rule, tok in findings:
            shown = tok[:6] + "…" + tok[-4:] if len(tok) > 16 else tok
            print("  %s:%d  [%s]  %s" % (path, ln, rule, shown))
        return 1
    print("SECRET-SCAN: ALL GREEN（被 git 跟踪的文件里没有任何真实凭据值）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
