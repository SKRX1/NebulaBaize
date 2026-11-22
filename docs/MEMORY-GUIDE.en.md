# Memory & Experience — How Nebula Baize Gets Smarter With Use

> English | [简体中文](MEMORY-GUIDE.md)

This guide explains the *actual mechanism* behind "the more you use it, the better it fits you" —
no marketing, just what the code does and how you stay in control.

---

## 1. The big idea: memory you own, not memory baked in

A normal model "learns" only by being retrained, and that learning is hidden inside its weights.
Nebula Baize does the opposite: it keeps its learned knowledge in **plain files and a local database
that you can read, edit, and delete.** The agent gets smarter about *your* work not by changing its
model, but by accumulating a personal, auditable memory that is injected into future conversations.

Three properties are designed in:

- **User-gated.** The agent proposes memories; you approve them. Nothing is silently baked in.
- **Scoped.** Memories live in separate libraries with different lifetimes and purposes (see §3).
- **Reversible.** Every deposited entry is a new entry you can undo in one click.

---

## 2. How memory is stored and retrieved

The memory subsystem is a small MCP server (`servers/memory_server.py`) built on the **Python
standard library only** — no vector database, no external service.

It runs two stores:

| Store | File | What it holds |
|-------|------|---------------|
| **Episodic** | `data/episodic.jsonl` | Records of past tasks/decisions ("what happened, what was decided") |
| **Semantic** | `data/semantic.db` | Learned facts, conventions, and document chunks (keyed by source) |

### Tools exposed to the agent

The agent can **read and manage** memory, but deliberately cannot write arbitrary facts straight
into the database. The exposed tools are:

- **`recall(query)`** — retrieve cross-session memory by keyword. At the start of relevant turns,
  matching items from both stores (top matches) are returned and injected into the agent's context,
  so it can apply what it learned before. Retrieval is keyword-based (embeddings are not used by
  default), so it stays fully inspectable.
- **`ingest(path)`** — learn a reference document: parse it, split it into chunks, and store them
  under a source id so they can later be retrieved *or removed as one unit*.
- **`sources()`** — list every learned source and how many chunks it holds (so you can see what the
  agent has absorbed and decide what to drop).
- **`read_source(source)`** — print all chunks stored under a source (full inspection).
- **`forget(source|id)`** — delete one item by id, or delete an entire source as a unit.

> The raw write tools (`remember` / `store`) are intentionally **not** exposed. If the model could
> write facts directly, it would bypass the user-gated, scoped, audited pipeline below — and the
> "gets smarter, stays under your control" property would quietly break.

---

## 3. The three libraries (where durable memory goes)

Durable, reusable memory is organized into three scoped libraries. Each is injected into future
turns as whole-file context, with different lifetimes and purposes:

| Library | What belongs here | Lifetime |
|---------|-------------------|----------|
| **Rules (工作规则)** | Stable operating conventions you have confirmed — directory layout, build/deploy commands, encoding/naming rules, the approval model, recurring gotchas | Long; applies to every task |
| **Knowledge (知识库)** | Confirmed facts and environment conclusions — API quirks, toolchain behavior, dependency versions, "X actually does Y" | Medium; factual reference |
| **Experience (经验库)** | One-line post-task retrospectives: *context → decision → outcome → lesson* | Medium; decision precedent |

### The write path: `propose-*` fences

When the agent finishes a task and has learned something genuinely reusable, it emits one or more
`propose-rules` / `propose-knowledge` / `propose-experience` blocks. Each line is one candidate
entry. What happens next is up to you:

- With autonomous memory maintenance **on**, confirmed entries are written straight into the right
  library file and take effect from the next conversation — each write is recorded and **one-click
  reversible**.
- The agent is instructed to write only *verified* facts — not guesses, not one-off workarounds,
  not duplicates of what's already there.

Because writes go through this single gated path, the memory stays scoped (the right entries land in
the right library) and auditable (you can always read the files and undo a change).

### Auto-distillation

Beyond explicit proposals, an optional auto-distillation step can summarize a completed task into
the episodic/semantic store (these appear as dated `auto-*.md` records under `.Nebula-memory/`).
This respects the auto-memory toggle and remains fully recallable and reviewable — auto-learned
memory is never hidden from you.

---

## 4. The loop, end to end

```
conversation / task
        │
        ├─ at relevant turns: recall() → matched Rules/Knowledge/Experience are injected
        │                                (the agent applies what it learned before)
        │
        └─ at task end: the agent emits propose-* blocks for anything reusable
                        │
                        └─ you approve/undo ─→ confirmed entries land in a library file
                                              │
                                              └─ next conversations load them  ─→ (loop)
```

That cycle is the whole of "getting smarter": each confirmed lesson makes the *next* task start a
little closer to how you actually work — while every step stays a file you can read or a change you
can undo.

---

## 5. Using it well (curation)

The agent will propose; the quality of the memory depends on what you accept. A few habits that keep
it high-signal:

- **Prefer verified over speculative.** Accept a memory only after you've seen it work. The rules
  that help most are concrete and operational ("build with command X", "file Y must use encoding Z").
- **Keep entries atomic and non-duplicative.** One fact per line. Before writing, the agent checks
  existing entries; if you spot a duplicate, edit or remove it rather than adding another.
- **Prune deliberately.** Use `sources()` / `read_source()` to review what was ingested, and
  `forget(source)` to drop a whole learned document when it goes stale.
- **Keep the three libraries honest.** Don't mix a one-off fact into Rules, or a hard fact into
  Experience. Correct scoping is what keeps retrieval relevant.
- **Undo freely.** A wrong turn is cheap: every entry is one click from removal, so there's no
  downside to trying a memory and retracting it.

---

## 6. Where everything lives on disk

| Path | Contents |
|------|----------|
| `servers/memory_server.py` | The memory MCP server (tools above) |
| `runtime/memory/` | `episodic.py`, `semantic.py`, `session.py`, `tokenize.py` |
| `data/episodic.jsonl` | Episodic store |
| `data/semantic.db` | Semantic store (default keyword retrieval, embeddings off) |
| `.Nebula-memory/` | Library files (Rules / Knowledge / Experience) + auto-distillation records |

All of it is local and plain enough to inspect with any text editor — which is exactly the point.
