/* 方案A differential gate — scan-folder auto-fill of empty model fields.

Anti-drift: EXTRACT the REAL window.scanImageModels body from app.js (the shipped source, not a
hand-typed copy), wrap it with injected stub globals (document/fetch/headers/t/toast), and drive
DIFFERENTIAL scenarios that prove the contract is load-bearing:
  T1  all four model fields empty -> scan fills each with that role's FIRST candidate (cand[0]),
      the exe field has no matching role so stays empty  == "scan auto-fills, you can still tweak".
  T2  a hand-set / already-configured field is NEVER clobbered; the still-empty siblings get filled.
      LOAD-BEARING: a naive blind-fill (no `if (inp.value.trim()) continue;`) would overwrite the
      preset, so this scenario is what locks "only fill blanks".
  T3  only diffusion-role files present -> only diffusion is filled, llm/vae/vision stay empty
      (role-exact match; a candidate is never mis-assigned to another field).
  T4  zero files -> the scan-empty early-return path: no field is touched, no throw.

Run standalone: node tests/test_scan_autofill.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");
const FAILURES = [];
const check = (label, cond, extra) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

// ---- extract the REAL scanImageModels fn from disk (anti-drift anchor) ----
const appSrc = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const fm = /window\.scanImageModels = (async function \(\) \{[\s\S]*?\r?\n  \};)/.exec(appSrc);
check("scanImageModels extractable from app.js (anti-drift anchor)", !!fm);
if (!fm) { console.log("\nHALTED: scanImageModels body not found"); process.exit(1); }
const FN_SRC = fm[1];
// the auto-fill block must be present in the shipped source (anti-drift: feature not silently reverted)
check("auto-fill block present in source (方案A marker)", /const fieldOf = \{ diffusion_model: "img-cfg-diffusion_model"/.test(FN_SRC));

// ---- fixture: replicates the real backend /api/image-scan-models payload (roles sorted by (role,name)) ----
// role rules mirrored from runtime/http_server.py: mmproj/vision->llm_vision, vae->vae, llm->llm, else diffusion_model.
function scanFiles(only) {
  const all = [
    { name: "diff-Q2_K.gguf",  path: "E:\\models\\生图模型\\diff-Q2_K.gguf",  role_guess: "diffusion_model" },
    { name: "diff-Q4_K.gguf",  path: "E:\\models\\生图模型\\diff-Q4_K.gguf",  role_guess: "diffusion_model" },
    { name: "vae-tile.gguf",   path: "E:\\models\\vae-tile.gguf",            role_guess: "vae" },
    { name: "llm-Q8.gguf",     path: "E:\\models\\编码器\\llm-Q8.gguf",        role_guess: "llm" },
    { name: "mmproj-bf16.gguf",path: "E:\\models\\编码器\\mmproj-bf16.gguf",   role_guess: "llm_vision" }
  ];
  all.sort((a, b) => (a.role_guess < b.role_guess ? -1 : a.role_guess > b.role_guess ? 1 : a.name < b.name ? -1 : 1));
  return only ? all.filter((f) => f.role_guess === only) : all;
}

// a faithful input stub with real value read/write + trim semantics
function makeDocument(initial) {
  const reg = {};
  const ids = ["img-cfg-model-dir", "img-cfg-diffusion_model", "img-cfg-vae", "img-cfg-llm", "img-cfg-llm_vision", "img-cfg-exe",
               "img-dl-diffusion_model", "img-dl-vae", "img-dl-llm", "img-dl-llm_vision"];
  for (const id of ids) reg[id] = { value: initial[id] != null ? initial[id] : "", options: [], appendChild(o){ this.options.push(o); } };
  return { _reg: reg, getElementById: (id) => (id in reg ? reg[id] : null), createElement: (tag) => ({ tag, value: "", label: "", className: "" }) };
}

// run the REAL fn in one realm; returns { doc, toasts, ran }
async function runScan(initial, files) {
  const doc = makeDocument(initial);
  const toasts = [];
  const payload = { dir: "E:\\models", files };
  const sandbox = {
    document: doc,
    fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    headers: () => ({}),
    t: (k, o) => k + (o && o.n != null ? ":" + o.n : ""),   // passthrough; we assert toast key, not translated text
    toast: (kind, key, extra) => { toasts.push({ kind, key }); }
  };
  const fn = new Function(
    "document", "fetch", "headers", "t", "toast", "window",
    `"use strict"; window.scanImageModels = ${FN_SRC} return window.scanImageModels;`
  )(doc, sandbox.fetch, sandbox.headers, sandbox.t, sandbox.toast, {});
  await fn();
  return { doc, toasts };
}

(async () => {
  const FIELD = { diffusion_model: "img-cfg-diffusion_model", vae: "img-cfg-vae", llm: "img-cfg-llm", llm_vision: "img-cfg-llm_vision" };

  // ---- T1: all-empty -> every model field filled with cand[0]; exe untouched (no matching role) ----
  {
    const { doc, toasts } = await runScan({ "img-cfg-model-dir": "E:\\models" }, scanFiles());
    const r = doc._reg;
    check("T1 diffusion filled = cand[0] Q2_K", r["img-cfg-diffusion_model"].value === "E:\\models\\生图模型\\diff-Q2_K.gguf", r["img-cfg-diffusion_model"].value);
    check("T1 vae filled", r["img-cfg-vae"].value === "E:\\models\\vae-tile.gguf", r["img-cfg-vae"].value);
    check("T1 llm filled", r["img-cfg-llm"].value === "E:\\models\\编码器\\llm-Q8.gguf", r["img-cfg-llm"].value);
    check("T1 llm_vision filled", r["img-cfg-llm_vision"].value === "E:\\models\\编码器\\mmproj-bf16.gguf", r["img-cfg-llm_vision"].value);
    check("T1 exe stays empty (no diffusion-only fallback to it)", r["img-cfg-exe"].value === "", JSON.stringify(r["img-cfg-exe"].value));
    check("T1 reports scan_autofill toast", toasts.some((x) => x.key.indexOf("scan_autofill") >= 0), JSON.stringify(toasts.map((x)=>x.key)));
  }

  // ---- T2 LOAD-BEARING: hand-set field NOT clobbered; empty siblings still filled ----
  {
    const preset = "E:\\keep\\my-hand-Q8.gguf";
    const { doc } = await runScan({ "img-cfg-model-dir": "E:\\models", "img-cfg-diffusion_model": preset }, scanFiles());
    const r = doc._reg;
    check("T2 preset diffusion preserved (only-fill-blank, LOAD-BEARING)", r["img-cfg-diffusion_model"].value === preset, r["img-cfg-diffusion_model"].value);
    check("T2 empty vae still filled", r["img-cfg-vae"].value === "E:\\models\\vae-tile.gguf", r["img-cfg-vae"].value);
  }
  // differential decoy: a blind-fill (drop the trim-guard) WOULD clobber -> prove the guard is load-bearing
  {
    const preset = "E:\\keep\\my-hand-Q8.gguf";
    const doc = makeDocument({ "img-cfg-model-dir": "E:\\models", "img-cfg-diffusion_model": preset });
    const files = scanFiles();
    // hand-rolled BLIND variant (no `if (inp.value.trim()) continue;`): overwrites every matched role field
    const cand = files.filter((f) => f.role_guess === "diffusion_model");
    if (cand.length) doc._reg["img-cfg-diffusion_model"].value = cand[0].path;
    check("T2-decoy blind-fill WOULD clobber preset (guard is load-bearing)", doc._reg["img-cfg-diffusion_model"].value !== preset, doc._reg["img-cfg-diffusion_model"].value);
  }

  // ---- T3: only diffusion-role files -> only diffusion filled; llm/vae/vision stay empty ----
  {
    const { doc } = await runScan({ "img-cfg-model-dir": "E:\\models" }, scanFiles("diffusion_model"));
    const r = doc._reg;
    check("T3 diffusion filled from role-matched files", r["img-cfg-diffusion_model"].value === "E:\\models\\生图模型\\diff-Q2_K.gguf", r["img-cfg-diffusion_model"].value);
    check("T3 llm NOT mis-assigned (stays empty)", r["img-cfg-llm"].value === "", JSON.stringify(r["img-cfg-llm"].value));
    check("T3 vae NOT mis-assigned (stays empty)", r["img-cfg-vae"].value === "", JSON.stringify(r["img-cfg-vae"].value));
    check("T3 llm_vision NOT mis-assigned (stays empty)", r["img-cfg-llm_vision"].value === "", JSON.stringify(r["img-cfg-llm_vision"].value));
  }

  // ---- T4: zero files -> scan-empty early return, no field touched, no throw ----
  {
    const { doc, toasts } = await runScan({ "img-cfg-model-dir": "E:\\models" }, []);
    const r = doc._reg;
    check("T4 no field filled on empty scan", r["img-cfg-diffusion_model"].value === "" && r["img-cfg-vae"].value === "", "ok");
    check("T4 scan_empty toast fired", toasts.some((x) => x.key.indexOf("scan_empty") >= 0), JSON.stringify(toasts.map((x)=>x.key)));
  }


  // ---- T5 [B1 2026-11-27] CORRECT a WRONG non-.gguf value (a folder path left by the old
  // folder-only browser): the field is REWRITTEN with the scan pick and scan_fixed fires.
  // LOAD-BEARING: the pre-B1 logic (`if (inp.value.trim()) continue;`) would KEEP the bogus
  // folder value; only the new `else if (!isGguf(v))` branch repairs it. ----
  {
    const folderBug = "E:\\models\\生图模型";   // a DIRECTORY, not a .gguf -> the exact bug B1 fixes
    const { doc, toasts } = await runScan({ "img-cfg-model-dir": "E:\\models", "img-cfg-diffusion_model": folderBug }, scanFiles());
    const r = doc._reg;
    check("T5 folder-bug diffusion CORRECTED to scan cand[0]", r["img-cfg-diffusion_model"].value === "E:\\models\\生图模型\\diff-Q2_K.gguf", r["img-cfg-diffusion_model"].value);
    check("T5 empty vae still auto-filled", r["img-cfg-vae"].value === "E:\\models\\vae-tile.gguf", r["img-cfg-vae"].value);
    check("T5 reports scan_fixed toast (fixed takes priority over autofill)", toasts.some((x) => x.key.indexOf("scan_fixed") >= 0), JSON.stringify(toasts.map((x)=>x.key)));
  }
  // differential decoy: under the OLD `if (value.trim()) continue` rule, the folder value SURVIVES
  // (never corrected) -> proves the new isGguf-correct branch is the thing that fixes it.
  {
    const folderBug = "E:\\models\\生图模型";
    let v = folderBug;            // simulate old logic: non-empty -> continue (kept as-is)
    if (v.trim()) { /* old: continue */ }
    else { v = scanFiles("diffusion_model")[0].path; }
    check("T5-decoy OLD logic KEEPS the folder bug (new branch is load-bearing)", v === folderBug, v);
  }
  // ---- anti-drift: the shipped source must carry the B1 correct branch + the isGguf guard ----
  check("B1 source lock: else-if (!isGguf) correction branch present", FN_SRC.includes("else if (!isGguf(v)) { inp.value = cand[0].path; fixed++; }"));
  check("B1 source lock: isGguf guard defined (a legit .gguf hand-path is left alone)", FN_SRC.includes("const isGguf = (v) =>"));  console.log(FAILURES.length ? "\n" + FAILURES.length + " FAILURE(S)" : "\nSCAN-AUTOFILL GATE: ALL GREEN");
  process.exit(FAILURES.length ? 1 : 0);
})();
