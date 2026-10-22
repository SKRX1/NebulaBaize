"""Web search MCP server: DuckDuckGo HTML (no API key, pure std lib)."""
from __future__ import annotations

import os
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mcp_base import McpServerBase


class WebSearchServer(McpServerBase):
    name = "websearch"
    tools = [
        {"name": "search", "description": "Web search a query, return top results",
         "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}},
                         "required": ["query"]}},
    ]

    def call_tool(self, name, args):
        if name != "search":
            raise Exception(f"unknown tool: {name}")
        q = urllib.parse.quote_plus(args.get("query", ""))
        req = urllib.request.Request(
            f"https://html.duckduckgo.com/html/?q={q}",
            headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode("utf-8", "replace")
        results = re.findall(r'result__a[^>]*>(.*?)</a>', html)
        snippets = re.findall(r'result__snippet[^>]*>(.*?)</a>', html)
        out = []
        for i, t in enumerate(results[:10]):
            s = re.sub("<.*?>", "", t)
            sn = re.sub("<.*?>", "", snippets[i]) if i < len(snippets) else ""
            out.append(f"- {s}  {sn}")
        return "\n".join(out) if out else "no results"


if __name__ == "__main__":
    sys.exit(WebSearchServer().run())
