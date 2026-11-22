# -*- coding: utf-8 -*-
"""secret_scan 判据差分锁（gitleaks 风格，纯 stdlib，无外部二进制）。

把"token 是否泄露进会被公开的内容"这道手工审计的判据本身锁成 load-bearing：
  S1 真 GitHub classic PAT / fine-grained PAT -> 必命中（真凭值不能漏）
  S2 真实形态、但被 < >、* 、省略号、单一字符填充包裹的占位符 -> 必放过（人工排除自动化）
  S3 变量名（GITHUB_TOKEN、gh_token、x-access-token、Bearer、--token-file、tokens/new 链接）
      -> 必放过（这正是上次手工逐行核对的那两个文件里全部出现的写法）
  S4 .Nebula-secrets/、.env 这类已被 .gitignore 排除的路径 -> 整文件跳过（那里允许真凭据）
  S5 其它厂商真凭据形态（AWS/Slack/OpenAI/HF）-> 必命中（避免换厂商就失明）
  S6 scan_worktree 的根解析 = git 仓库顶层（不是脚本所在子目录），且对真实仓库自举=0发现

差分方法：同一行文本只翻转"真 token vs 占位/变量名"这一维，断言结果随之翻转 —— 这才证明
判据在起作用，而不是碰巧空跑。

⚠ 本测试里的"真实形态样例"一律用字符串拼接构造（prefix + 余下 base62）。原因：本仓的
secret-scan 门禁会扫描所有被 git 跟踪的文件——若源码里写成连续的 `ghp_xxx…` 字面量，夹具本身
就会被门禁扫成 RED（gitleaks 也用同样的 allowlist 思路规避测试夹具自触发）。拼接后源码里不存在
连续的 token 字面量，自扫不命中，而运行时仍能拼出完整真实形态喂分类器，差分照样成立。

Run: python -X utf8 tests/test_secret_scan.py
"""
import os
import sys
import io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # Nebula-agent
sys.path.insert(0, os.path.join(ROOT, "tools"))
import secret_scan as SS  # noqa: E402

FAILURES = []


def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (" " + extra if extra else ""))
    if not cond:
        FAILURES.append(label)


def scan_line(line, path="docs/example.md"):
    """返回该行里的真实发现 token 列表（path 可指定以测 ignored 路径跳过）。"""
    return SS.scan_text(path, line)


# —— 构造的真实形态样例：运行时拼出，源码里不存成连续字面量（见模块 docstring）。 ——
REAL_PAT = "ghp_" + "mF7xQ2vB9kLtR4sZ0nHdYp6WuJ8cAe3gT1iO"   # 36 位混合 base62（真实 classic PAT 长度）
REAL_FG = "github_pat_11" + "A0bC9dEf0xYzQ2mNpKtR7sUv3HwL8jSg5BcDeFgHiJkL"   # fine-grained 形态
REAL_AWS = "AKIA" + "0B7C1D2E3F4A5G6H"          # AWS access key id（16 位大写）
REAL_OPENAI = "sk-" + "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV"
REAL_HF = "hf_" + "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uVwX"

print("=== S1: real credential forms MUST be caught ===")
check("real github PAT caught", len(scan_line("set GITHUB_TOKEN=" + REAL_PAT)) >= 1,
      "hits=%s" % (scan_line("x=" + REAL_PAT),))
check("real fine-grained PAT caught", len(scan_line("tok = '" + REAL_FG + "'")) >= 1)
check("real PAT inside prose caught", len(scan_line("token is " + REAL_PAT + " for push")) >= 1)

print("=== S2: placeholders that LOOK like tokens MUST be ignored (manual-exclusion automated) ===")
# 这几行都含 "ghp_"，但都是占位/示例/变量，必须放过——与 S1 真值形成单变量差分。
for ph in [
    "set GITHUB_TOKEN=ghp_xxxxxxxxxxxx",                       # 文档示例：单一字符填充
    "remote add origin https://x-access-token:<TOKEN>@github.com/o/r.git",  # 尖括号占位
    "token: ghp_****redacted****",                            # 星号脱敏
    'url = "https://x-access-token:%s@github.com/.../" % (token or "<TOKEN>")',  # 运行期拼接占位
]:
    res = scan_line(ph)
    check("placeholder ignored: %.40r" % ph, len(res) == 0, "hits=%s" % (res,))

print("=== S3: variable names / docs references MUST be ignored ===")
for var in [
    "需要一次性凭据：环境变量 GITHUB_TOKEN（classic PAT，scope 需 repo + workflow）",
    "def api(token, method, path, body=None):",
    'req.add_header("Authorization", "Bearer " + token)',
    'ap.add_argument("--token-file", help="含 PAT 的文件路径；默认读 env GITHUB_TOKEN")',
    "直达：<https://github.com/settings/tokens/new?scopes=repo,workflow>",
]:
    res = scan_line(var)
    check("varname/doc ref ignored: %.40r" % var, len(res) == 0, "hits=%s" % (res,))

print("=== S4: gitignored secrets paths are skipped entirely (credentials allowed there) ===")
line_with_real = "secret=" + REAL_PAT
check("real PAT is caught in a normal tracked path", len(scan_line(line_with_real, "config/x.json")) >= 1)
check("real PAT ignored under .Nebula-secrets/gh_token.txt",
      len(scan_line(line_with_real, ".Nebula-secrets/gh_token.txt")) == 0)
check("real PAT ignored under .env", len(scan_line(line_with_real, ".env")) == 0)

print("=== S5: other-vendor real credential forms are caught (no blind spot) ===")
check("AWS access key caught", len(scan_line("AWS_ACCESS_KEY_ID=" + REAL_AWS)) >= 1,
      "hits=%s" % scan_line("AWS_ACCESS_KEY_ID=" + REAL_AWS))
check("OpenAI-style key caught", len(scan_line("openai = \"%s\"" % REAL_OPENAI)) >= 1)
check("HuggingFace token caught", len(scan_line("HF_TOKEN=" + REAL_HF)) >= 1)

print("=== S6: scan_worktree roots at the git top-level, and self-boot is clean ===")
top = SS.git_toplevel(ROOT)
check("git_toplevel resolves to the repo root (NOT the Nebula-agent subdir)",
      os.path.basename(top).lower() != "nebula-agent",
      "top=%s" % top)
# 真实仓库自举：被跟踪文件里没有任何真实凭据（这正是本次手工审计的结论）。
findings = SS.scan_worktree(top)
check("self-boot over the real repo finds ZERO real credentials", findings == [],
      "findings=%s" % (findings[:3],))

# 负向差分 load-bearing：同样的 token 形态，写成"字面量"会红、写成"环境变量引用"会绿。
red = SS.scan_text("tmp/leak.py", "API_TOKEN = \"%s\"" % REAL_PAT)
green = SS.scan_text("tmp/leak.py", "API_TOKEN = os.environ[\"GITHUB_TOKEN\"]")
check("differential: real value -> RED, env reference -> GREEN",
      len(red) >= 1 and len(green) == 0, "red=%s green=%s" % (red, green))

print("\n%s" % ("SECRET-SCAN: ALL GREEN" if not FAILURES else "FAILURES: %s" % FAILURES))
sys.exit(1 if FAILURES else 0)
