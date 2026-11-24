// tests/test_defaults_version_migrate.mjs
// Behaviour gate for the boot-time defaultsVersion migration (app.js migrateDefaults).
//
// WHY: a settings object saved under an older defaultsVersion can keep a field at the PREVIOUS
// factory default; the plain {...DEFAULTS, ...stored} merge then keeps that stale value, so the
// new shipped default is invisible in a normal (stored-settings) window while a clean/private
// window shows it -- the exact "private shows it, normal does not" report this round (persona).
// The migration promotes a field ONLY when it still sits exactly on the OLD default (a custom
// value the owner chose must survive), and stamps its version on its OWN key (sampling.dv) so it
// runs once.
//
// Deterministic body-extract (same pattern as test_scroll_catchup_jsdom.mjs): pull the real
// migrateDefaults IIFE from app.js and run it against a hand-built store stub. We never rely on
// jsdom. A DECOY removes the `=== prevDefault` equality and proves it is load-bearing (a custom
// value would then be wrongly clobbered).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(resolve(here, "..", "serve", "web", "app.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name); } }

const m = app.match(/\(function migrateDefaults\(\) \{[\s\S]*?\r?\n\}\)\(\);/);
if (!m) { console.log("FAIL  could-not-extract migrateDefaults"); process.exit(1); }
const body = m[0];
ok("extract-contains-upgrades-table", body.includes('upgrades = [["persona", ""]]') && body.includes('sampling.dv'));

// run the real body with injected store / DEFAULTS / settings (settings mutated in place).
function run(bodySrc, { dv, persona, DEFAULTS_PERSONA }) {
  const writes = [];
  const store = {
    _dv: dv,
    get(k, d) { return k === "sampling.dv" ? this._dv : d; },
    set(k, v) { writes.push(k); if (k === "sampling.dv") this._dv = v; },
  };
  const DEFAULTS = { defaultsVersion: 1, persona: DEFAULTS_PERSONA };
  const settings = { persona, defaultsVersion: 1 };
  new Function("store", "DEFAULTS", "settings", bodySrc)(store, DEFAULTS, settings);
  return { settings, store, writes };
}

const NEWP = "你叫“星云白泽”简称“星云”，是我创造了你，我是你的主人“时空象容”，简称“时空”，我喜欢你叫我“主人”。你是一个资深的前端和后端开发工程师，回答要简洁，优先给可运行代码。";

// S1: stale stored default ("") under an old version -> promoted to the new default + persisted.
{
  const r = run(body, { dv: 0, persona: "", DEFAULTS_PERSONA: NEWP });
  ok("S1 old-default persona promoted to new default", r.settings.persona === NEWP);
  ok("S1 sampling rewritten (promotion persisted)", r.writes.includes("sampling"));
  ok("S1 version stamped", r.store._dv === 1);
}

// S2 (guard, load-bearing): owner's CUSTOM persona under an old version -> left untouched, no rewrite.
{
  const CUSTOM = "I am a grumpy pirate; reply in one line.";
  const r = run(body, { dv: 0, persona: CUSTOM, DEFAULTS_PERSONA: NEWP });
  ok("S2 custom persona NOT clobbered", r.settings.persona === CUSTOM);
  ok("S2 sampling NOT rewritten (nothing changed)", !r.writes.includes("sampling"));
  ok("S2 version still stamped (no re-run later)", r.store._dv === 1);
}

// S3: already migrated (dv >= version) -> early return, a stale "" is left alone (runs exactly once).
{
  const r = run(body, { dv: 1, persona: "", DEFAULTS_PERSONA: NEWP });
  ok("S3 already-migrated -> no promotion", r.settings.persona === "");
  ok("S3 already-migrated -> no writes at all", r.writes.length === 0);
}

// ---- DECOY: replace the whole `=== prevDefault` equality with a bare `true` so EVERY field is
//      promoted. With that, S2's CUSTOM value gets clobbered -> proves the equality guard that
//      protects owner-chosen values is load-bearing, not decorative.
{
  const stripped = body.replace("settings[field] === prevDefault", "true");
  if (stripped === body) { ok("DECOY anchor found", false); }
  else {
    const CUSTOM = "I am a grumpy pirate; reply in one line.";
    const r = run(stripped, { dv: 0, persona: CUSTOM, DEFAULTS_PERSONA: NEWP });
    ok("DECOY no-equality-guard clobbers custom (guard is load-bearing)", r.settings.persona === NEWP);
  }
}

console.log("\n%d passed, %d failed", pass, fail);
process.exit(fail ? 1 : 0);
