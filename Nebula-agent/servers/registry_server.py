"""Registry: the MCP-tool face of runtime/registry.py — manage servers and skills.

Round 2 of the "agent grows its own toolbox" plan: skillhub stages and probes
candidates; THIS server is the one that actually changes what tools exist —
add/update/delete of MCP servers and skills, with the backups and audit trail
runtime/registry.py provides.

Why a separate MCP server instead of calling registry.py in-process:

  * the web app's Tools tab needs the same operations in BOTH modes. In parasitic
    mode the page is served by the Strata host, whose only management surface is
    /mcp/call (there is no /api/* there); in standalone mode the gateway proxies
    /mcp/call to its upstream. One MCP server, one channel, both modes.
  * the model itself can manage the toolbox mid-conversation ("install the fetch
    server you just probed"), which is the point of round 2.

Safety model (read before extending):
  * registry.py is remote code execution by design — a spec's `command`/`args`
    is a program started on the user's machine. Every mutation is name-validated,
    backed up (timestamped, rotating) and audited there; this server adds no
    shortcuts around that.
  * the six mutation tools are SENSITIVE: the host's approval gate treats the
    `registry__` prefix as change-of-toolbox and pauses even the `auto` tier
    (see serve/server.py `_auto_deny` and runtime/policy/sandbox.py). Read-only
    tools (list/get) and the probe (test_server, which starts a candidate and
    lists its tools without persisting anything) are not gated — the same trust
    level as skillhub's probe.
  * a config edit reaches a running system only at its next start: the Strata
    host reads mcp_servers.json once at startup, the gateway's executor likewise.
    Every mutation result therefore carries the backup path, and the UI says so.

Granularity: `list_*` returns summaries (what a picker needs), `get_*` returns
the full spec (what an editor needs). One call must not return the whole config
when one entry was asked for — hub results are capped at max_result_chars.

Test isolation: STRATA_REGISTRY_CONFIG / _SKILLS / _BACKUPS / _AUDIT override the
paths, so tests run against a temp config and never touch the real one.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mcp_base import McpServerBase  # noqa: E402

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_DIR = os.path.join(PROJECT_ROOT, "runtime")


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def _default_config() -> str:
    return os.environ.get("STRATA_REGISTRY_CONFIG") or os.path.join(
        PROJECT_ROOT, "config", "mcp_servers.json")


def _default_skills() -> str:
    return os.environ.get("STRATA_REGISTRY_SKILLS") or os.path.join(PROJECT_ROOT, "skills")


def _default_backups() -> str:
    return os.environ.get("STRATA_REGISTRY_BACKUPS") or os.path.join(
        os.path.dirname(_default_config()), ".backups")


def _default_audit():
    """The same audit log the gateway writes to (data/audit.jsonl), unless overridden."""
    path = os.environ.get("STRATA_REGISTRY_AUDIT") or os.path.join(
        PROJECT_ROOT, "data", "audit.jsonl")
    if RUNTIME_DIR not in sys.path:
        sys.path.insert(0, RUNTIME_DIR)
    try:
        from audit import AuditLog
        return AuditLog(path)
    except Exception:
        return None                      # audit is best-effort; never block a mutation


class RegistryServer(McpServerBase):
    name = "registry"
    tools = [
        # ─── reads (not gated) ───────────────────────────────────────────────
        {"name": "list_servers",
         "description": "列出 mcp_servers.json 里的全部 MCP 服务器（摘要：名称/命令/来源/是否技能生成）。"
                        "管理工具面的第一步；详情用 get_server。",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "get_server",
         "description": "查看一个服务器的完整启动条目（command/args/cwd/env/来源/所属技能）。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"}}, "required": ["name"]}},
        {"name": "list_skills",
         "description": "列出 skills/ 里的全部技能（摘要：名称/描述/生成的服务器/触发词）。",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "get_skill",
         "description": "查看一个技能的完整定义（工具列表/权限/触发词/依赖环境变量）。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"}}, "required": ["name"]}},
        # ─── probe (not gated: starts a candidate, persists nothing) ─────────
        {"name": "test_server",
         "description": "按给定启动条目试连一个服务器：启动它、列出工具、停止。不写入配置。"
                        "spec 与 add_server 的 spec 同形（command/args/cwd/env）。",
         "inputSchema": {"type": "object",
                         "properties": {"spec": {"type": "object",
                                                 "description": "启动条目：command 必填，args/cwd/env 可选"},
                                        "name": {"type": "string", "description": "探活用的临时名（可选）"}},
                         "required": ["spec"]}},
        # ─── mutations (SENSITIVE: gated by the approval layer, auto tier included) ──
        {"name": "add_server",
         "description": "新增一个 MCP 服务器并写入 mcp_servers.json（带备份与审计）。"
                        "敏感操作：需要审批。改动在宿主下次启动时生效。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string", "description": "服务器名（字母数字._-）"},
                                        "spec": {"type": "object", "description": "command 必填，args/cwd/env 可选"}},
                         "required": ["name", "spec"]}},
        {"name": "update_server",
         "description": "修改一个已存在的 MCP 服务器启动条目（带备份与审计）。敏感操作：需要审批。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"},
                                        "spec": {"type": "object", "description": "完整的新条目（非补丁）"}},
                         "required": ["name", "spec"]}},
        {"name": "delete_server",
         "description": "删除一个 MCP 服务器（带备份与审计）。技能生成的条目不能直接删——删对应技能。"
                        "敏感操作：需要审批。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"}}, "required": ["name"]}},
        {"name": "add_skill",
         "description": "新增一个技能（skills/<name>.yaml），并把它展开成 mcpServers 条目供宿主启动。"
                        "敏感操作：需要审批。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"},
                                        "spec": {"type": "object",
                                                 "description": "description/tools(mcp,command,args,cwd)/"
                                                                "triggers/permissions/requires_env"}},
                         "required": ["name", "spec"]}},
        {"name": "update_skill",
         "description": "修改一个已存在的技能及其展开条目（带备份与审计）。敏感操作：需要审批。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"},
                                        "spec": {"type": "object"}},
                         "required": ["name", "spec"]}},
        {"name": "delete_skill",
         "description": "删除一个技能及其生成的全部 mcpServers 条目（带备份与审计）。敏感操作：需要审批。",
         "inputSchema": {"type": "object",
                         "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    ]

    def __init__(self, config_path: str = None, skills_dir: str = None,
                 backup_dir: str = None, audit=None):
        super().__init__()
        self.config_path = os.path.abspath(config_path or _default_config())
        self.skills_dir = os.path.abspath(skills_dir or _default_skills())
        self.backup_dir = backup_dir or _default_backups()
        self.audit = audit if audit is not None else _default_audit()
        self._registry = None

    # ─── registry lifecycle ───────────────────────────────────────────────────

    @property
    def registry(self):
        """Built lazily: a bad/absent config must not kill tools/list."""
        if self._registry is None:
            if RUNTIME_DIR not in sys.path:
                sys.path.insert(0, RUNTIME_DIR)
            from registry import Registry
            self._registry = Registry(self.config_path, self.skills_dir,
                                      backup_dir=self.backup_dir, audit=self.audit)
        return self._registry

    # ─── summaries (list_*) ───────────────────────────────────────────────────

    @staticmethod
    def _server_summary(s: dict) -> dict:
        return {"name": s.get("name", ""),
                "command": s.get("command", "") or "",
                "origin": s.get("origin", ""),
                "skill": s.get("skill"),
                "n_args": len(s.get("args") or [])}

    @staticmethod
    def _skill_summary(s: dict) -> dict:
        return {"name": s.get("name", ""),
                "file": s.get("file", ""),
                "description": s.get("description", "") or "",
                "servers": s.get("servers") or [],
                "triggers": s.get("triggers") or []}

    # ─── tool routing ─────────────────────────────────────────────────────────

    def call_tool(self, name, args):
        args = args or {}
        try:
            if name == "list_servers":
                return _j({"servers": [self._server_summary(s)
                                        for s in self.registry.list_servers()]})
            if name == "get_server":
                return _j({"server": self.registry.get_server(str(args.get("name") or ""))})
            if name == "list_skills":
                return _j({"skills": [self._skill_summary(s)
                                       for s in self.registry.list_skills()]})
            if name == "get_skill":
                skills = self.registry.list_skills()
                want = str(args.get("name") or "")
                hit = next((s for s in skills if s["name"] == want), None)
                if hit is None:
                    raise KeyError(f"skill '{want}' not found")
                return _j({"skill": hit})
            if name == "test_server":
                return _j(self.registry.test_server(args.get("spec") or {},
                                                    str(args.get("name") or "probe")))
            if name == "add_server":
                return _j(self.registry.add_server(str(args.get("name") or ""),
                                                   args.get("spec") or {}))
            if name == "update_server":
                return _j(self.registry.update_server(str(args.get("name") or ""),
                                                      args.get("spec") or {}))
            if name == "delete_server":
                return _j(self.registry.delete_server(str(args.get("name") or "")))
            if name == "add_skill":
                return _j(self.registry.add_skill(str(args.get("name") or ""),
                                                  args.get("spec") or {}))
            if name == "update_skill":
                return _j(self.registry.update_skill(str(args.get("name") or ""),
                                                     args.get("spec") or {}))
            if name == "delete_skill":
                return _j(self.registry.delete_skill(str(args.get("name") or "")))
            raise KeyError(f"unknown tool: {name}")
        except Exception as e:
            # RegistryError (bad name / duplicate / not found) and KeyError land here
            # as a normal tool result with an "error" field: the host's hub.call
            # reports isError=False either way, so the message must be in the text.
            return _j({"error": str(e) or type(e).__name__})


def main() -> int:
    """入口：源码版由 __main__ 调它；闭源产物里由 `gateway --server <name>` 调它。

    闭源版把 servers/*.py 编成 <name>.pyd（Nuitka --mode=module），扩展模块里
    `__name__` 是模块名而非 "__main__"，故必须由编译后的 gateway 显式调用本函数。
    """
    return RegistryServer().run()


if __name__ == "__main__":
    sys.exit(main())
