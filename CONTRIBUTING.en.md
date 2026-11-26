# Contribution Guide / CONTRIBUTING

> [简体中文](CONTRIBUTING.md) | **English**

Thank you for your interest in Nebula Baize (星云白泽)! This guide explains the contribution
workflow, the licensing prerequisite, and the code/doc conventions.

---

## 1. Licensing prerequisite (READ FIRST)

Nebula Baize uses **AGPL-3.0 open source + commercial dual licensing**:

- **Public track**: `LICENSE` (AGPL-3.0-only) grants rights to the public and to self-hosting
  individual users.
- **Enterprise track**: `COMMERCIAL-LICENSE.md` grants enterprises a paid commercial license that
  removes the AGPL copyleft obligations.

For the copyright holder (Shikong Xiangrong) to keep granting commercial licenses to buyers and to
sustain the project, **every contribution must be accompanied by a signed CLA**. This is the only
hard prerequisite for dual licensing to work.

→ Please read and accept [`CLA.md`](CLA.md) (a permissive CLA template).

Contributors retain the copyright of their contributions; the copyright holder receives a
**non-exclusive** right to sublicense (including commercially). No copyright assignment is required —
friction is minimal for individuals, matching industry practice (Kernel / jQuery / Angular use the same
permissive CLA model).

---

## 2. Contribution workflow

1. **Open an issue first**: for new features, bug fixes, or doc improvements, open an issue briefly
   describing the motivation and align scope with the author before doing work, to avoid wasted effort.
2. **Branch & commit**: branch off `main`; before committing, run the full regression locally (see §5).
   Write commit messages in English (subject + body); Chinese is allowed in the body for context.
3. **CLA sign-off**: in your first PR description confirm "I have read and agree to the CLA" (one-time,
   covering all your subsequent contributions; re-sign if code ownership changes).
4. **PR review**: the author responds within 48h; squash-merge into main on approval.
5. **Rollback points**: baseline tags are named `v-baseline-YYYY-MM-DD-<letter>` (current repo convention).

---

## 3. Code & frontend conventions

### 3.1 Backend (Python)
- Prefer the standard library; hard dependencies are only pillow / psutil / PySocks (see `requirements.txt`).
- Any Windows-specific call must be wrapped in a `sys.platform == "win32"` guard, with a degradation path on POSIX.
- An `except` body must **not** be only `pass`/`continue` (counted as a silent-swallow by the
  `tests/test_code_hygiene.py` ratchet).
- When adding a route with a test, isolate data files via `STRATA_*` environment variables
  (following the `STRATA_INTERRUPT_LOG` convention).

### 3.2 Frontend `serve/web/`
- **Single source of truth**: `serve/web/` is authoritative; do not touch the Strata-main mirror copy.
- Edit `app.js` / `i18n.js` with an **anchor-edit script** (it errors out if the match count ≠ 1).
- `app.js` is CRLF; normalize back to CRLF after editing; validate syntax with `node --check`.
- New `data-i18n` keys must be **added in pairs, zh + en** (`tests/test_i18n.mjs` enforces equal key counts).
- Use only `var(--st-*)` tokens in CSS; no hardcoded colors (so dark/light themes are maintenance-free).
- Zero inline handlers project-wide (`onerror=`/`onclick=`); degradation paths go through pure CSS.
- A FORM modal (one holding in-progress inputs) must **never** close on a backdrop click: `.st-modal` is a `fixed inset:0` full-viewport scrim, so any point outside the card is still the modal itself, and one stray click drops the whole form being filled. Close only through explicit paths (Save / Cancel / ×) **plus Esc**; a new form modal that has no Esc handler must add one (after removing backdrop-close there would be no keyboard way out). A pure viewer (e.g. the `#img-modal` lightbox) may keep backdrop-close - it has no data to lose. This convention is locked by the static gate `tests/test_form_modal_close.mjs` (with decoys).
- Every modal must have a **visible close button** (top-right ×, `id="<modal>-close"`, with `aria-label`). Its `<use href>` icon **must reference a symbol that actually exists in `sprite.svg`** - referencing a missing id (e.g. `i-xmark`) makes `<use>` resolve to nothing and the button renders blank, i.e. "there is no close button". Use the project's existing `i-chevron` for the close icon (`.st-modal__head .st-icon` is already rotated into an ×); never invent an icon name that is not in the sprite. Modals must also implement a **focus trap** (while open, Tab stays inside the dialog; do not filter by `offsetParent` - it is always true under jsdom, use `!closest('[hidden]')` instead) and **return focus to the button that opened them** on close (record `document.activeElement` before opening, and `.focus()` it on close if it is still in the document), so keyboard and screen-reader users are not dumped at the top of the page.

### 3.3 i18n
- Copy must be kept in sync in three places: the Chinese side + the English side + the static HTML fallback text.
- The `data-i18n-attr` multi-attribute separator is a comma (`"placeholder:key,title:key"`), not a pipe.

### 3.4 Tests
- Full regression: `python tools\run_tests.py`, ~190 items, ALL GREEN before any commit.
- New tests: register them in the `SUITES` list of `Nebula-agent/tools/run_tests.py`, stating what they lock.

---

### 3.5 How changes take effect

Whether a change lands without a restart depends on which process it runs in and whether it is resident:

- **Frontend** `serve/web/*`: static files are re-read on every request, so a **hard browser refresh is enough**, no restart.
- **MCP subprocesses** `servers/*.py` or the env/args in `mcp_servers.json`: click the MCP panel's **reload children** (= `_reload_executor` re-reads the json + re-spawns all children) to apply **without a restart**; a child's env is injected once at spawn.
- **Gateway process** `runtime/*.py`, `serve/*.py` new routes/new logic: already compiled into the gateway's memory at import, so they **require restarting 8099**; "reload children" cannot save them.

**Contribution stance (ratified, plan A)**: put volatile business logic first as an **MCP server tool** under `servers/` (lives in `servers/`, reloads hot, never touches the gateway); only code that genuinely has to live in the gateway process (the routing skeleton / auth / streaming-forward skeleton) accepts an 8099 restart.

The fact "reload children swaps the children, not the gateway process" is locked by the frontend gate `tests/test_mcp_reload_jsdom.mjs` (reload POSTs only the child endpoint `api/servers/reload`; on success it does not navigate the page).

---

## 4. What to include in a commit

Only add code/docs/tests related to the current task; do **not** bundle the following:

- Runtime drift: `config/image_gallery.json`, `fs_allowed_roots.txt`, etc.
- Other work-streams' output: for shared files like RULES.md, split hunks with `git add -p`.
- Scratch scripts: recycle them (Windows recycle bin) when done — never physically delete.
- `.gitignore`-ignored items (`data/`, `.venv/`, `node_modules/`, etc.) are left alone.

---

## 5. Running tests

```bat
:: Full regression (~190 items, ALL GREEN before commit)
python Nebula-agent\tools\run_tests.py

:: Run a single test
python Nebula-agent\tools\run_tests.py --only test_xxx.py
node Nebula-agent\tests\test_xxx.mjs
```

---

## 6. Contact

- Issues / PRs live in this repository; for commercial-licensing partnerships go through `COMMERCIAL-LICENSE.md`.
- Code of conduct: Contributor Covenant v2.1 (in brief: be respectful, constructive, no personal attacks).
- sk0327@qq.com

---

*Original application layer © 2026 时空象容 · AGPL-3.0 (dual-licensed). Powered by Strata.*
