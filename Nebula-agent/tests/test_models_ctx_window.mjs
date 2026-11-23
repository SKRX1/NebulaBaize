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
   P3  the count of locked custom models is exactly 3 (a model added/removed is a conscious edit)

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
// Count is 4: the three 47831 custom entries plus inkling-2-mini-abliterated-fit
// (a llama.cpp local custom on base_url http://localhost:1234), which declares the
// same 128K context_window as its peers so P1 covers it too.
check("P3 exactly 4 custom models locked by this anchor", custom.length === 4,
      `got ${custom.length}`);

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
