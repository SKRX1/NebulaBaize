#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""_gh_publish.py — 一键把本仓库发布到 GitHub 并触发闭源三平台 CI。

需要一次性凭据：环境变量 GITHUB_TOKEN（classic PAT，scope 需 repo + workflow），
或 --token-file 指向一个只含 token 的文本文件。

做什么（幂等）：
  1) 经 REST API 在 <owner> 名下创建【空】仓库 NebulaBaize（auto_init=false：
     README/.gitignore/license 都不生成——LICENSE 由仓库自带，生成反而 push 冲突）；
     已存在则跳过（按 owner/NebulaBaize 的存在性判断，不重复创建）。
  2) git remote add origin https://x-access-token:<token>@github.com/<owner>/NebulaBaize.git
     （已存在则 set-url）
  3) git push -u origin master，再推所有 v* tag（含本轮 v-tag 若已打）
  4) 打印 Actions 观察地址；若给了 --tag vX.Y.Z 则先打该 tag 再推（tag 推送即触发
     build-release.yml，因 workflow 触发器是 push tags v*）。

用法：
  set GITHUB_TOKEN=...            # 或 --token-file path
  python tools/_gh_publish.py --owner YOUR_LOGIN [--private] [--tag v0.1.0] [--dry-run]

--dry-run 只打印将要执行的每个动作（API 请求/remote/push），不联网写、不改 git 配置。
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "NebulaBaize"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Nebula-agent
WT = os.path.dirname(ROOT)                                          # 仓库根


def run_git(args, dry, echo=True):
    cmd = ["git", "-C", WT] + args
    if dry:
        print("DRY git", " ".join(args))
        return 0, ""
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", stdin=subprocess.DEVNULL, timeout=600)
    out = ((p.stdout or "") + (p.stderr or "")).strip()
    if echo:
        # 绝不回显 token 本体（远端 URL 含 token，输出行按长度截断即可）
        print("git %s -> rc=%s" % (" ".join(args), p.returncode))
        for line in out.splitlines()[:12]:
            print("   ", line[:160])
    return p.returncode, out


def api(token, method, path, body=None):
    url = "https://api.github.com" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "nebula-baize-publish")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", required=True, help="GitHub 登录名（仓库归属）")
    ap.add_argument("--private", action="store_true", help="建私有仓库（闭源默认更稳）")
    ap.add_argument("--token-file", help="含 PAT 的文件路径；默认读 env GITHUB_TOKEN")
    ap.add_argument("--tag", help="要打的版本 tag（如 v0.1.0）；推 tag 即触发 CI")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    token = ""
    if a.token_file:
        token = open(a.token_file, encoding="utf-8").read().strip()
    else:
        token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token and not a.dry_run:
        print("NO TOKEN: set GITHUB_TOKEN or pass --token-file; 或先 --dry-run 预览")
        return 2

    print("target = %s/%s  private=%s  dry=%s" % (a.owner, REPO, a.private, a.dry_run))

    # 1) 建仓（幂等）
    st, body = api(token, "GET", "/repos/%s/%s" % (a.owner, REPO)) if token else (None, "")
    if st == 200:
        print("repo exists -> skip create")
    elif a.dry_run:
        print("DRY API POST /user/repos {name:%s, private:%s, auto_init:false}" % (REPO, a.private))
    else:
        st2, b2 = api(token, "POST", "/user/repos", {
            "name": REPO,
            "description": "Nebula Baize (星云白泽) — closed-source free-use application layer for the Strata engine",
            "private": bool(a.private),
            "auto_init": False,     # 关键：不生成 README/.gitignore/LICENSE，避免 push 冲突
            "has_issues": False,
            "has_wiki": False,
        })
        print("create repo -> HTTP %s" % st2)
        if st2 not in (201, 422):
            print("   ", b2[:400])
            return 1
        if st2 == 422:
            print("   422=多半已存在，按已存在继续")

    # 2) remote（含 token 的 https）
    url = "https://x-access-token:%s@github.com/%s/%s.git" % (token or "<TOKEN>", a.owner, REPO)
    rc, out = run_git(["remote", "get-url", "origin"], a.dry_run, echo=False)
    if a.dry_run:
        print("DRY git remote %s origin <url-with-token>" % ("set-url" if rc == 0 else "add"))
    elif rc == 0:
        run_git(["remote", "set-url", "origin", url], False)
    else:
        run_git(["remote", "add", "origin", url], False)

    # 3) tag（可选）+ push 分支与 tags
    if a.tag:
        rc, out = run_git(["rev-parse", "-q", "--verify", "refs/tags/" + a.tag], a.dry_run, echo=False)
        if rc != 0:
            run_git(["tag", a.tag], a.dry_run)
    rc, _ = run_git(["push", "-u", "origin", "master"], a.dry_run)
    if rc != 0:
        print("push master FAILED -> 检查 token scope 是否为 repo")
        return 1
    run_git(["push", "origin", "--tags"], a.dry_run)

    print("DONE. 观察 CI：https://github.com/%s/%s/actions" % (a.owner, REPO))
    print("若 Actions 报 Nuitka 缺模块/资源：按 stderr 往 .github/workflows/build-release.yml")
    print("追加 --include-package=<name> 或修 --include-data-dir，再 git push 更新即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
