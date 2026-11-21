"""Example skill server: echoes to show the plugin mechanism (pure std lib)."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "servers"))
from _mcp_base import McpServerBase  # noqa: E402


class ExampleServer(McpServerBase):
    name = "example-server"
    tools = [
        {"name": "hello", "description": "返回一句来自示例技能的问候",
         "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}}},
    ]

    def call_tool(self, name, args):
        if name == "hello":
            return f"hello, {args.get('name', 'world')} (from example skill)"
        raise Exception(f"unknown tool: {name}")


def main() -> int:
    """入口：源码版由 __main__ 调它；闭源产物里由 `gateway --server <name>` 调它。

    闭源版把 servers/*.py 编成 <name>.pyd（Nuitka --mode=module），扩展模块里
    `__name__` 是模块名而非 "__main__"，故必须由编译后的 gateway 显式调用本函数。
    """
    return ExampleServer().run()


if __name__ == "__main__":
    sys.exit(main())
