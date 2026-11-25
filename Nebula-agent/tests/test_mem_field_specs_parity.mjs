// Static contract lock: the two 自主维护记忆 timing fields (min / max / default)
// must agree between the app.js MEM_FIELD_SPECS single source of truth and the
// index.html input fallback attributes. If a future edit changes a range/default
// in ONE place only, this gate goes RED -- it is the drift guard the owner asked
// for. It also pins the factory defaults (idle=12, grace=6) so the new debounce
// default cannot silently regress. A decoy (flip the html value) proves the
// comparison is load-bearing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const APP = readFileSync(join(dir, "app.js"), "utf8");
const IDX = readFileSync(join(dir, "index.html"), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
const ok = (c, m) => { if (c) console.log("OK   " + m); else { console.log("FAIL " + m); fails++; } };

// --- parse MEM_FIELD_SPECS out of app.js (collapse CRLF so the object body is contiguous) ---
const specsSrc = APP.replace(/\r\n/g, "\n");
const block = specsSrc.match(/const MEM_FIELD_SPECS = \{([\s\S]*?)\r?\n\};/);
ok(!!block, "app.js defines MEM_FIELD_SPECS block");
if (!block) process.exit(1);

function parseSpec(key) {
  const m = block[1].match(new RegExp(key + ":\\s*\\{([^}]*)\\}"));
  if (!m) return null;
  const body = m[1];
  const g = (k) => { const r = body.match(new RegExp(k + ":\\s*\"?([0-9A-Za-z._-]+)\"?")); return r ? r[1] : null; };
  return { inputId: g("inputId"), warnId: g("warnId"), min: +g("min"), max: +g("max"), def: +g("def") };
}
const specIdle = parseSpec("memCompactIdleSec");
const specGrace = parseSpec("memActivityGraceSec");
ok(specIdle && specGrace, "both field specs parsed from app.js");
if (!specIdle || !specGrace) process.exit(1);

function htmlAttrs(inputId, src) {
  const m = src.match(new RegExp('id="' + inputId + '"[^>]*'));
  if (!m) return null;
  const tag = m[0];
  const a = (k) => { const r = tag.match(new RegExp(k + '="([^"]*)"')); return r ? r[1] : null; };
  return { min: a("min"), max: a("max"), value: a("value") };
}

// --- SPECS vs index.html fallback attrs must match (the drift guard) ---
function parity(spec, label, src) {
  const at = htmlAttrs(spec.inputId, src);
  ok(!!at, label + ": input #" + spec.inputId + " exists in index.html");
  if (!at) return;
  ok(at.min === String(spec.min), label + ": html min(" + at.min + ") === SPECS min(" + spec.min + ")");
  ok(at.max === String(spec.max), label + ": html max(" + at.max + ") === SPECS max(" + spec.max + ")");
  ok(at.value === String(spec.def), label + ": html value(" + at.value + ") === SPECS def(" + spec.def + ")");
}
parity(specIdle, "idle", IDX);
parity(specGrace, "grace", IDX);

// --- factory defaults pinned (idle=12 wait, grace=6 debounce) ---
ok(specGrace.def === 6, "grace factory default == 6 (the requested new default)");
ok(specIdle.def === 12, "idle factory default == 12");
ok(specGrace.min === 1, "grace min == 1 (>= waitIdle 1s poll step)");

// --- decoy: a mismatched html value must break the grace parity (load-bearing proof) ---
const tampered = IDX.replace(new RegExp('id="' + specGrace.inputId + '"[^>]*value="' + specGrace.def + '"'),
  (s) => s.replace('value="' + specGrace.def + '"', 'value="999"'));
const tamAt = htmlAttrs(specGrace.inputId, tampered);
ok(tamAt && tamAt.value !== String(specGrace.def), "DECOY: tampered html value 999 != SPECS def (parity guard is load-bearing)");

if (fails) { console.log("\n" + fails + " FAIL"); process.exit(1); }
console.log("\nMEM FIELD PARITY OK");
