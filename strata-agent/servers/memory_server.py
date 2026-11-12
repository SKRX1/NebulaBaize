"""Memory MCP server: expose episodic + semantic memory as tools (pure std lib)."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime"))
from _mcp_base import McpServerBase  # noqa: E402
from memory.episodic import EpisodicMemory  # noqa: E402
from memory.semantic import SemanticMemory  # noqa: E402

DATA = os.environ.get("AGENT_DATA", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))


class MemoryServer(McpServerBase):
    name = "memory"
    tools = [
        {"name": "recall", "description": "按关键词检索跨会话记忆",
         "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
        # NOTE: "remember" / "store" (the raw semantic/episodic WRITE tools) are intentionally
        # NOT exposed to the model. They let the model write facts straight into data/semantic.db,
        # bypassing the user-gated, scoped, audited three-library system (rules/knowledge/
        # experience via the ```propose-* fences) AND ignoring the autoMemory toggle. Autolearn
        # still feeds semantic.db through fsWrite + ingest; recall still reads it. Removing the
        # direct write tools is what makes the designed auto-deposition actually fire.
        {"name": "ingest", "description": "学习一份参考文档：解析、切块并按来源 id 存储，以便日后检索并作为整体删除",
         "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
        {"name": "forget", "description": "删除从某个来源学到的全部记忆（即 ingest 创建的那个单元），或按 id 删除单条",
         "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}, "id": {"type": "integer"}}}},
        {"name": "sources", "description": "列出已存储的各来源及其分块数量，便于用户决定删除哪些",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "read_source", "description": "返回在某个来源 id 下存储的全部分块，便于用户查看已学习文档的内容",
         "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}}, "required": ["source"]}},
    ]

    def __init__(self):
        super().__init__()
        self.episodic = EpisodicMemory(os.path.join(DATA, "episodic.jsonl"))
        self.semantic = SemanticMemory(os.path.join(DATA, "semantic.db"))

    def call_tool(self, name, args):
        if name == "recall":
            q = args.get("query", "")
            epi = self.episodic.search(q)
            sem = self.semantic.search(q, top_k=5)
            out = []
            for e in epi[:5]:
                out.append(f"[episodic] {e.get('event','')} {e.get('meta','')}")
            for s in sem[:5]:
                out.append(f"[semantic] {s.get('text','')}")
            return "\n".join(out) if out else "nothing found"
        if name == "ingest":
            from corpus import ingest_file
            res = ingest_file(self.semantic, args["path"], source=args.get("source"))
            if res.get("skipped"):
                return f"skipped: {res['skipped']}"
            return f"ingested {res['chunks_added']} chunks from {res['source']}"
        if name == "forget":
            if "id" in args and args["id"] is not None:
                return "deleted" if self.semantic.delete(int(args["id"])) else "nothing deleted"
            if args.get("source"):
                n = self.semantic.delete_source(args["source"])
                return f"deleted {n} items from {args['source']}"
            return "provide source or id"
        if name == "sources":
            lst = self.semantic.list_sources()
            return "\n".join(f"{s['source']}: {s['chunks']} chunks" for s in lst) or "no sources"
        if name == "read_source":
            src = args.get("source", "")
            items = self.semantic.get_by_source(src)
            if not items:
                return f"no chunks for {src}"
            return "\n\n".join(f"[chunk {i + 1}]\n{t['text']}" for i, t in enumerate(items))
        raise Exception(f"unknown tool: {name}")


if __name__ == "__main__":
    sys.exit(MemoryServer().run())
