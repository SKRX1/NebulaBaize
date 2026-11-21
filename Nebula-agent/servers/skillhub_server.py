"""Skillhub: discover, stage and probe MCP servers/skills — round 1 (no activation).

Round 1 of the "agent grows its own toolbox" plan: the four zero-persistence
steps a streaming conversation needs —

    search   a built-in catalog of known servers/skills
    stage    download/copy the candidate into the quarantine dir _incoming/<name>/
    probe    start it, list its tools, stop it (the same subprocess machinery
             the management UI's "test" button uses)
    incoming / discard   inspect and clean up the quarantine

Nothing here ever writes config/mcp_servers.json. Activation is round 2 and
goes through runtime/registry.py behind an approval, with its backups and
audit trail. Round 1 only *prepares* a decision for the human.

Safety model (read before extending):
  * every write is confined to <project>/_incoming/<safe-name>/ — names must
    match ^[A-Za-z0-9._-]+$ and the resolved path is re-checked to sit exactly
    one level under the quarantine root, so "../" tricks buy nothing;
  * staging downloads or copies code but never runs it;
  * probing DOES run the candidate — under executor.StdioServer, with the
    parent environment merged in, exactly like the management UI's probe. The
    candidate sees the machine as it would once activated; that is the point of
    probing. What round 1 withholds is *persistence*: no config write, no
    auto-start, nothing survives this conversation without a human yes;
  * the quarantine README states the contract for humans who find the folder.

Fetch kinds:
  template  copy the bundled skills/ skeleton (offline, stdlib-only, probes clean)
  local     copy a directory already on disk (an explicit `source` path)
  git       sparse-clone a repository, optionally one subdirectory of it
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mcp_base import McpServerBase, smart_decode  # noqa: E402

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_DIR = os.path.join(PROJECT_ROOT, "runtime")
CATALOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skillhub_catalog.json")
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
GIT_TIMEOUT_S = 180
_README = """skillhub 隔离区（quarantine）—— 里面都是"候选"，没有一个处于激活状态。

每个子目录是一次 stage 的结果：
  draft.json   将来若激活，将要写入 mcp_servers.json 的启动条目（含 _meta 备注）
  meta.json    来源、可信度、暂存时间
  probe.json   最近一次探活结果（ok / 工具清单 / 错误）
  src/         下载或拷贝来的代码（git/local 类）

激活不在本工具的职责内——需要用户确认后经 runtime/registry.py 写入配置
（带备份与审计）。确认无用就用 skillhub_discard 删掉对应子目录。
"""


def _incoming_root() -> str:
    return os.environ.get("SKILLHUB_INCOMING") or os.path.join(PROJECT_ROOT, "_incoming")


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


class SkillHubError(Exception):
    pass


class SkillHubServer(McpServerBase):
    name = "skillhub"
    tools = [
        {"name": "search",
         "description": "搜索技能目录：按关键词匹配内置目录里的 MCP 服务器/技能（名称、标题、描述、提供的工具）。"
                        "返回候选及其来源与可信度（builtin/official/community/unverified）。",
         "inputSchema": {"type": "object",
                         "properties": {"query": {"type": "string", "description": "关键词，留空列出全部"}}}},
        {"name": "stage",
         "description": "把候选暂存到隔离区 _incoming/<name>/：下载/拷贝代码、生成 draft.json 启动草稿。"
                        "不写入配置、不激活。支持：目录里的条目名；或显式 source（本地目录路径 / https git 地址，"
                        "此时可信度记为 unverified）。git 类可用 subdir 只取仓库子目录。",
         "inputSchema": {"type": "object",
                         "properties": {
                             "name": {"type": "string", "description": "候选名（字母数字._-）"},
                             "source": {"type": "string", "description": "可选：本地目录或 https git 地址，覆盖目录条目"},
                             "subdir": {"type": "string", "description": "可选：git 仓库内子目录"}},
                         "required": ["name"]}},
        {"name": "probe",
         "description": "探活隔离区里的候选：按 draft.json 启动它、列出工具、停止。只运行不激活，"
                        "结果写入 probe.json。缺依赖等失败会给出 hint。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"}}, "required": ["name"]}},
        {"name": "incoming",
         "description": "列出隔离区中已暂存的候选及状态（来源、可信度、文件数、草稿、最近探活结果）。",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "discard",
         "description": "删除隔离区中的一个暂存候选（仅限 _incoming 下一层目录，绝不触碰配置）。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    ]

    def __init__(self, incoming_dir: str = None):
        super().__init__()
        self.incoming = os.path.abspath(incoming_dir or _incoming_root())

    # ─── catalog ──────────────────────────────────────────────────────────────

    def _catalog(self) -> list:
        try:
            with open(CATALOG_PATH, "rb") as f:
                return json.loads(f.read().decode("utf-8")).get("entries", [])
        except Exception:
            return []

    def _entry(self, name: str) -> dict:
        for e in self._catalog():
            if e.get("name") == name:
                return e
        raise SkillHubError(f"目录中没有名为 {name!r} 的条目；先 skillhub_search 查一下，"
                            f"或用 source= 指定本地目录/https 地址")

    # ─── path guards ─────────────────────────────────────────────────────────

    def _check_name(self, name) -> str:
        name = str(name or "").strip()
        if not SAFE_NAME.match(name):
            raise SkillHubError(f"非法名称 {name!r}：只允许字母、数字、点、下划线、连字符")
        return name

    def _dest(self, name: str) -> str:
        """The one directory a staged candidate may ever touch."""
        d = os.path.abspath(os.path.join(self.incoming, name))
        root = os.path.abspath(self.incoming)
        if os.path.dirname(d) != root or os.path.basename(d) != name:
            raise SkillHubError(f"路径越界：{d}")
        return d

    # ─── staging ─────────────────────────────────────────────────────────────

    def _stage(self, name: str, source: str = None, subdir: str = None) -> dict:
        if source:
            src = os.path.abspath(str(source))
            if os.path.isdir(src):
                entry = {"name": name, "title": name, "description": "本地目录暂存",
                         "trust": "unverified", "provides": [],
                         "needs": None, "notes": "来源由对话指定，未经目录收录"}
                kind, fetch = "local", {"kind": "local", "path": src}
            elif re.match(r"^(https|file)://", str(source)):
                entry = {"name": name, "title": name, "description": "git 仓库暂存",
                         "trust": "unverified", "provides": [],
                         "needs": None, "notes": "来源由对话指定，未经目录收录"}
                kind, fetch = "git", {"kind": "git", "url": str(source)}
            else:
                raise SkillHubError(f"source 只能是已存在的本地目录或 https:// git 地址，收到：{source!r}")
        else:
            entry = self._entry(name)
            fetch = entry.get("fetch") or {}
            kind = fetch.get("kind")
        source_desc = fetch.get("path") or fetch.get("url") or fetch.get("from") or ""

        dest = self._dest(name)
        if os.path.exists(dest):
            shutil.rmtree(dest)                       # re-stage = refresh; still inside _incoming
        os.makedirs(dest, exist_ok=True)

        if kind == "template":
            files = self._stage_template(fetch, dest)
            server_file = os.path.join(dest, "server.py")
            run_cwd, run_env = dest, {"PYTHONPATH": dest}
        elif kind == "local":
            files = self._copy_tree(fetch.get("path"), os.path.join(dest, "src"))
            server_file = self._discover(os.path.join(dest, "src"))
            run_cwd, run_env = os.path.join(dest, "src"), {}
        elif kind == "git":
            files = self._clone(fetch.get("url"), subdir or fetch.get("subdir") or "", dest)
            server_file = self._discover(os.path.join(dest, "src"))
            run_cwd, run_env = os.path.join(dest, "src"), {}
        else:
            raise SkillHubError(f"未知 fetch kind：{kind!r}")

        draft = {
            "name": name,
            "command": sys.executable,
            "args": [server_file] if server_file else [],
            "cwd": run_cwd,
            "env": run_env,
            "_meta": {
                "staged_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "kind": kind,
                "source": source_desc,
                "trust": entry.get("trust", "unverified"),
                "needs": entry.get("needs"),
                "note": entry.get("notes", ""),
                "status": "staged — NOT active; activation is a separate approved step",
            },
        }
        warnings = self._validate_draft(draft)
        with open(os.path.join(dest, "draft.json"), "wb") as f:
            f.write(_j(draft).encode("utf-8"))
        with open(os.path.join(dest, "meta.json"), "wb") as f:
            f.write(_j({"entry": entry, "staged_at": draft["_meta"]["staged_at"],
                        "files": files}).encode("utf-8"))
        self._ensure_readme()
        return {"staged": name, "dir": dest, "kind": kind, "trust": entry.get("trust"),
                "files": files, "server_file": server_file, "warnings": warnings,
                "draft": draft, "needs": entry.get("needs"),
                "next": "候选已入隔离区（未激活）。要评估它就 skillhub_probe；要激活需用户确认后走 "
                        "runtime/registry.py（下一轮）；不用就 skillhub_discard。"}

    def _stage_template(self, fetch: dict, dest: str) -> list:
        src = os.path.join(PROJECT_ROOT, fetch.get("from", "skills"))
        copied = []
        for fname in ("example_server.py", "_mcp_base.py"):
            s = os.path.join(os.path.dirname(os.path.abspath(__file__)) if fname == "_mcp_base.py" else src, fname)
            if not os.path.isfile(s):
                raise SkillHubError(f"模板缺少文件：{s}")
            shutil.copy2(s, os.path.join(dest, "server.py" if fname == "example_server.py" else fname))
            copied.append(os.path.basename(s) if fname != "example_server.py" else "server.py")
        yaml_src = os.path.join(src, "example.yaml")
        if os.path.isfile(yaml_src):
            shutil.copy2(yaml_src, os.path.join(dest, "skill.yaml"))
            copied.append("skill.yaml")
        return copied

    def _copy_tree(self, src: str, dst: str) -> list:
        if not os.path.isdir(src):
            raise SkillHubError(f"本地目录不存在：{src}")
        shutil.copytree(src, dst,
                        ignore=shutil.ignore_patterns("__pycache__", ".git", "node_modules", ".venv"))
        out = []
        for root, _dirs, files in os.walk(dst):
            for f in files:
                out.append(os.path.relpath(os.path.join(root, f), dst))
        return sorted(out)[:200]

    def _clone(self, url: str, subdir: str, dest: str) -> list:
        if not url or not re.match(r"^(https|file)://", str(url)):
            raise SkillHubError(f"git 来源只接受 https:// 或 file:// 地址，收到：{url!r}")
        target = os.path.join(dest, "src")
        env = dict(os.environ, GIT_TERMINAL_PROMPT="0")   # fail fast instead of hanging on a credential prompt
        try:
            subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
                            "-c", "core.symlinks=false", url, target],
                           capture_output=True, timeout=GIT_TIMEOUT_S, env=env)
        except subprocess.TimeoutExpired:
            raise SkillHubError(f"git clone 超时（{GIT_TIMEOUT_S}s）：{url}")
        if not os.path.isdir(os.path.join(target, ".git")):
            raise SkillHubError(f"git clone 失败：{url}")
        if subdir:
            r = subprocess.run(["git", "-C", target, "sparse-checkout", "set", subdir],
                               capture_output=True, timeout=120, env=env)
            if r.returncode != 0:
                raise SkillHubError(f"sparse-checkout {subdir!r} 失败：{smart_decode(r.stderr)[:300]}")
        out = []
        for root, _dirs, files in os.walk(target):
            if ".git" in root.split(os.sep):
                continue
            for f in files:
                out.append(os.path.relpath(os.path.join(root, f), target))
        return sorted(out)[:200]

    def _discover(self, root: str):
        """Find the server entry file under a staged tree; None if we cannot tell."""
        if not os.path.isdir(root):
            return None
        cands = []
        for r, _d, files in os.walk(root):
            if ".git" in r.split(os.sep) or "__pycache__" in r.split(os.sep):
                continue
            for f in files:
                if f in ("server.py", "__main__.py") or (f.endswith("_server.py")):
                    cands.append(os.path.join(r, f))
        if not cands:
            return None
        cands.sort(key=lambda p: (p.count(os.sep), len(p), p))   # shallowest, shortest, stable
        return cands[0]

    def _validate_draft(self, draft: dict) -> list:
        warns = []
        cmd = str(draft.get("command") or "")
        if not cmd:
            warns.append("command 为空")
        elif os.path.isabs(cmd) and not os.path.exists(cmd):
            warns.append(f"command 不存在：{cmd}")
        args = draft.get("args") or []
        if not args:
            warns.append("args 为空：没能识别出服务器入口文件，激活前需人工指定")
        for a in args:
            if os.path.isabs(str(a)) and not os.path.isfile(str(a)):
                warns.append(f"入口文件不存在：{a}")
        return warns

    # ─── probe ───────────────────────────────────────────────────────────────

    def _probe(self, name: str) -> dict:
        dest = self._dest(name)
        draft_path = os.path.join(dest, "draft.json")
        if not os.path.isfile(draft_path):
            raise SkillHubError(f"{name!r} 尚未暂存（没有 draft.json）")
        with open(draft_path, "rb") as f:
            draft = json.loads(f.read().decode("utf-8"))
        if not draft.get("args"):
            res = {"ok": False, "tools": [], "error": "草稿没有入口文件（stage 时未能识别）",
                   "hint": "在 src/ 里找到服务器入口 .py 后手动补 draft.json 的 args，或换一个候选"}
        else:
            res = self._probe_spec(draft)
        with open(os.path.join(dest, "probe.json"), "wb") as f:
            f.write(_j({**res, "at": time.strftime("%Y-%m-%d %H:%M:%S")}).encode("utf-8"))
        return {**res, "name": name}

    def _probe_spec(self, spec: dict) -> dict:
        if RUNTIME_DIR not in sys.path:
            sys.path.insert(0, RUNTIME_DIR)
        try:
            from executor import StdioServer          # the management UI's own probe machinery
        except Exception as e:
            return {"ok": False, "tools": [], "error": f"executor 不可用：{e}",
                    "hint": "runtime/executor.py 应在本项目 runtime/ 下；检查安装完整性"}
        srv = None
        try:
            srv = StdioServer("skillhub-probe", str(spec.get("command") or ""),
                              list(spec.get("args") or []), spec.get("env") or None,
                              spec.get("cwd") or None)
            srv.start()
            tools = [{"name": t.get("name", ""), "description": t.get("description", "")}
                     for t in (srv.tools or [])]
            return {"ok": True, "tools": tools, "error": None, "hint": None}
        except Exception as e:
            return {"ok": False, "tools": [], "error": str(e), "hint": self._hint(str(e))}
        finally:
            if srv is not None:
                try:
                    srv.stop()
                    # stop() only terminates; reap the child and close its pipes so no
                    # handle/warning lingers (a probe runs on every stage/probe call).
                    proc = getattr(srv, "_proc", None)
                    if proc is not None:
                        try:
                            proc.wait(timeout=5)
                        except Exception:
                            pass
                        for pipe in (proc.stdin, proc.stdout, proc.stderr):
                            try:
                                if pipe is not None:
                                    pipe.close()
                            except Exception:
                                pass
                except Exception:
                    pass

    @staticmethod
    def _hint(err: str) -> str:
        low = err.lower()
        if "modulenotfounderror" in low or "no module named" in low:
            return ("缺少 Python 依赖：该候选需要先安装依赖才能运行（见 draft.json 的 _meta.needs）；"
                    "安装是激活前的准备工作，不在本工具职责内")
        if "filenotfound" in low or "not found" in low or "cannot find" in low:
            return "command 或入口文件找不到：检查 draft.json 的 command/args 是否指向真实路径"
        if "not alive" in low:
            return "候选进程启动后即退出：大概率是依赖缺失或入口文件报错，看 error 详情"
        return "探活失败：详见 error；可在 src/ 里检查该候选的 README 与依赖说明"

    # ─── incoming / discard ──────────────────────────────────────────────────

    def _list(self) -> list:
        out = []
        if not os.path.isdir(self.incoming):
            return out
        for name in sorted(os.listdir(self.incoming)):
            d = os.path.join(self.incoming, name)
            if not os.path.isdir(d):
                continue
            item = {"name": name}
            for key, fname in (("meta", "meta.json"), ("draft", "draft.json"), ("probe", "probe.json")):
                p = os.path.join(d, fname)
                if os.path.isfile(p):
                    try:
                        with open(p, "rb") as f:
                            item[key] = json.loads(f.read().decode("utf-8"))
                    except Exception:
                        item[key] = None
            out.append(item)
        return out

    def _discard(self, name: str) -> dict:
        dest = self._dest(name)                       # guards: safe name + exactly one level under root
        if not os.path.isdir(dest):
            raise SkillHubError(f"隔离区没有 {name!r} 这个候选")
        shutil.rmtree(dest)
        return {"discarded": name, "remaining": [i["name"] for i in self._list()]}

    def _ensure_readme(self):
        try:
            os.makedirs(self.incoming, exist_ok=True)
            p = os.path.join(self.incoming, "README.txt")
            if not os.path.isfile(p):
                with open(p, "wb") as f:
                    f.write(_README.encode("utf-8"))
        except OSError:
            pass

    # ─── tool routing ────────────────────────────────────────────────────────

    def call_tool(self, name, args):
        try:
            if name == "search":
                q = str((args or {}).get("query") or "").strip().lower()
                hits = []
                for e in self._catalog():
                    if not q or q in json.dumps(e, ensure_ascii=False).lower():
                        hits.append({"name": e.get("name"), "title": e.get("title"),
                                     "trust": e.get("trust"), "provides": e.get("provides"),
                                     "description": e.get("description"), "needs": e.get("needs")})
                return _j({"count": len(hits), "hits": hits})
            if name == "stage":
                return _j(self._stage((args or {}).get("name"), (args or {}).get("source"),
                                      (args or {}).get("subdir")))
            if name == "probe":
                return _j(self._probe(self._check_name((args or {}).get("name"))))
            if name == "incoming":
                return _j({"root": self.incoming, "candidates": self._list()})
            if name == "discard":
                return _j(self._discard(self._check_name((args or {}).get("name"))))
            raise SkillHubError(f"unknown tool: {name}")
        except SkillHubError as e:
            return _j({"error": str(e)})
        except Exception as e:                        # a probe must never 500 the server loop
            return _j({"error": f"{type(e).__name__}: {e}"})


def main() -> int:
    """入口：源码版由 __main__ 调它；闭源产物里由 `gateway --server <name>` 调它。

    闭源版把 servers/*.py 编成 <name>.pyd（Nuitka --mode=module），扩展模块里
    `__name__` 是模块名而非 "__main__"，故必须由编译后的 gateway 显式调用本函数。
    """
    return SkillHubServer().run()


if __name__ == "__main__":
    sys.exit(main())
