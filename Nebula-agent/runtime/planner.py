"""Planner: split a task into next actions, LLM-driven, pure standard library.

It is the Plan step of the loop. Given the conversation so far plus available tools,
it asks the model to choose the next action(s). When the model returns a normal answer
with no tool call, the planner marks the task done.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from llm_client import StrataClient


@dataclass
class NextAction:
    """The model's decision for one step."""
    thinking: str
    actions: list[dict]      # normalized tool calls; empty => done
    final_answer: str | None
    usage: dict = None       # token accounting from the model call (None when absent)


class Planner:
    def __init__(self, client: StrataClient, tools: list[dict]):
        self.client = client
        self.tools = tools

    def plan(self, messages: list[dict], effort: str | None = None,
               on_delta=None) -> NextAction:
        turn = self.client.chat(messages, tools=self.tools, effort=effort,
                                on_delta=on_delta)
        actions = [{"id": c["id"], "name": c["name"], "arguments": _parse_args(c["arguments"])}
                   for c in turn.tool_calls if c.get("name")]
        return NextAction(thinking=turn.reasoning, actions=actions,
                          final_answer=(turn.content or None) if not actions else None,
                          usage=(turn.usage or None))


def _parse_args(args):
    if isinstance(args, str):
        try:
            return json.loads(args)
        except Exception:
            return args
    return args

