"""Example skill server: echoes to show the plugin mechanism (pure std lib)."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "servers"))
from _mcp_base import McpServerBase  # noqa: E402


class ExampleServer(McpServerBase):
    name = "example-server"
    tools = [
        {"name": "hello", "description": "Return a greeting from the example skill",
         "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}}},
    ]

    def call_tool(self, name, args):
        if name == "hello":
            return f"hello, {args.get('name', 'world')} (from example skill)"
        raise Exception(f"unknown tool: {name}")


if __name__ == "__main__":
    sys.exit(ExampleServer().run())
