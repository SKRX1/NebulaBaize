/* Static anchor for the custom-model context_window declaration (2026-11).

 WHY THIS EXISTS: the gateway's proactive context guard and the dynamic output ceiling both take
 their denominator from the model's declared `context_window`. For the 47831 custom models the
 AUTHORITATIVE value is 128K = 131072 tokens (confirmed from the 47831 UI's "对话上下文 = 128K"
 selector on 2026-11). A prior turn briefly wrote 32768 — the runtime monitor's DEFAULT when the
 engine shows "stopped" — which is NOT the engine's real n_ctx. This static lock pins the three
 custom models back at 131072 so a stray monitor-default write cannot silently lower the guard
 denominator again (the exact bug test_ctx_denominator.py documents for the OLD hardcoded 128K).

 Differential design (per the test rule, pure-ASCII assertions; Chinese is display-only):
   P1  every custom model behind the 47831 base_url declares context_window === 131072
   P2  NONE of them drifted to the monitor default 32768 (the negative lock against the bug)
   P3  structural sentinel: at least one custom model is covered (never written to a hardcoded
       count -- the model line adds/removes custom entries freely, so an exact-count assertion
       turned red on every such edit and proved brittle, not load-bearing)
   P4  EVERY entry that reaches a non-default endpoint via its own base_url (kind=custom, and
       kind=local with a base_url like a local LM Studio) declares a context_window -- such an
       endpoint never reports max_context on /health, so ctx_window() has only the declaration
       to fall back on; an undeclared one silently borrows the gateway's own 8080 n_ctx.

 Run: node tests/test_models_ctx_window.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CFG = path.join(ROOT, "config", "models.json");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const j = JSON.parse(fs.readFileSync(CFG, "utf8"));
const custom = (j.models || []).filter((m) => m.kind === "custom");

console.log("MODELS CONTEXT_WINDOW (static anchor, custom/47831):");

// P3 first so a structural change is reported before value assertions.
// DYNAMIC sentinel, not a hardcoded count: the model line adds/removes custom entries
// freely, so "== 4" turned red on every such edit (and was already stale: inkling-2 is
// now kind=local, not custom). What actually matters is that the anchor still covers at
// least one custom model -- a non-empty set -- so a blanket clear can not silently
// disarm the whole lock. The per-model value invariant is held by P1/P2, not a count.
check("P3 anchor covers >=1 custom model (dynamic, never a hardcoded count)",
      custom.length >= 1, `got ${custom.length}`);

// P4: every entry that reaches a NON-default endpoint through its own base_url must
// declare context_window. Such an endpoint (a 47831 front-instance returning HTML, a
// local LM Studio) does not answer /health with max_context, so GatewayState.ctx_window()
// has only the declaration as its denominator; an undeclared one borrows the gateway's own
// 8080 n_ctx -- a different machine's window -- and the occupancy bar is measured against
// the wrong max. Covers kind=local-with-base_url too (e.g. inkling-2 -> LM Studio 1234),
// which the custom-only P1 would miss. Dynamic, so adding/removing such an entry stays
// honest as long as its declaration travels with it.
const external = (j.models || []).filter((m) => String(m.base_url || "").trim());
const undeclared = external.filter((m) => !(Number(m.context_window) > 0));
check("P4 every external-base_url entry declares context_window",
      undeclared.length === 0,
      undeclared.map((m) => m.id).join(","));

// P1: each must declare 131072.
for (const m of custom) {
  check(`P1 ${m.id} context_window === 131072`, m.context_window === 131072,
        `got ${m.context_window}`);
}

// P2: no custom model drifted to the monitor default 32768 (the bug this locks against).
const drifted = custom.filter((m) => m.context_window === 32768);
check("P2 no custom model on the monitor default 32768", drifted.length === 0,
      drifted.map((m) => `${m.id}=32768`).join(","));

console.log("\nMODELS-CTX-WINDOW: " + (FAILURES.length ? "FAILURES: " + FAILURES.join(", ") : "ALL PASSED"));
process.exit(FAILURES.length ? 1 : 0);
