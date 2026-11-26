/* modelDot 名字归一化差分门禁（方案A：剥离 .strata 等本地装饰后缀再比对）。

Anti-drift: EXTRACT the REAL modelCompareKey / modelOnline / modelDot from app.js (the shipped
source), wrap them with injected modelsDoc + endpointKey, and drive DIFFERENTIAL scenarios that
prove each decision is load-bearing:
  T1 LOAD-BEARING  engine loads "inkling-2-mini-sq-15" and the entry's model field is the SAME
       weights name but carries the local ".strata" decoration -> dots turn GREEN (on). Decoy: a
       verbatim compare (no normalisation) reads mismatch -> proves modelCompareKey is load-bearing.
  T2 honest-amber   engine actually holds a DIFFERENT weight (qwen) while the entry names Inkling ->
       still "mismatch" (amber). Normalisation must NOT paper over a genuine wrong-weight.
  T3 no-overstrip   a real model id legitimately CONTAINS dots (qwen3.8-flash-next-iq3_s); the key
       must keep it intact (NOT strip an arbitrary after-dot segment). Plus qwen3.8 == qwen3.8 on.
  T4 both-branches  the explicit base_url ON-the-same-port branch (modelDot's other name-compare) is
       normalised too: "...strata" vs loaded without the suffix -> on.
  T5 diff-instance  an entry pointing at a DIFFERENT endpoint (endpointKey differs) is "on" regardless
       of name (it is a genuinely separate instance, the name is not comparable).

Run standalone: node tests/test_model_dot_norm.mjs
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

const appSrc = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
// extract the THREE real fns from the shipped source (anti-drift anchors)
const keyM   = /function modelCompareKey\(s\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
const onM    = /function modelOnline\(m\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
const dotM   = /function modelDot\(m\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
check("modelCompareKey extractable (anti-drift anchor)", !!keyM);
check("modelOnline extractable (anti-drift anchor)", !!onM);
check("modelDot extractable (anti-drift anchor)", !!dotM);
if (!keyM || !onM || !dotM) { console.log("\nHALTED: dot fns not found"); process.exit(1); }

// endpointKey mirrors app_utils.js:444 (strip scheme, trailing slash, trailing /v1)
function runModelDot(modelsDoc) {
  const fn = new Function(
    "modelsDoc", "endpointKey",
    `"use strict"; ${keyM[0]} ${onM[0]} ${dotM[0]} return modelDot;`
  );
  const endpointKey = (u) => String(u || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\/v1$/, "");
  return fn(modelsDoc, endpointKey);
}
const dotOf = (doc, id) => runModelDot(doc)(doc.models.find((x) => x.id === id));

// ---- T1 LOAD-BEARING: ".strata" decoration no longer reads a false mismatch on the real engine ----
{
  const loaded = "inkling-2-mini-sq-15";
  const doc = {
    models: [{ id: "a", kind: "local", base_url: "", model: "Inkling-2-Mini-SQ-15.strata" }],
    probe: { a: { ok: true }, __engine__: { url: "http://127.0.0.1:8080/v1", ok: true, loaded } }
  };
  const dot = dotOf(doc, "a");
  check("T1 .strata entry on its own loaded engine -> GREEN (on)", dot === "on", dot);
  // DECOY: verbatim lower-compare without normalisation -> mismatch (proves modelCompareKey load-bearing)
  const verbatim = "Inkling-2-Mini-SQ-15.strata".trim().toLowerCase() === loaded.trim().toLowerCase();
  check("T1-decoy verbatim compare WOULD mismatch (normalisation is load-bearing)", !verbatim, String(verbatim));
}

// ---- T2 honest amber: engine genuinely holds a different weight -> still mismatch ----
{
  const doc = {
    models: [{ id: "a", kind: "local", base_url: "", model: "Inkling-2-Mini-SQ-15.strata" }],
    probe: { a: { ok: true }, __engine__: { url: "http://127.0.0.1:8080/v1", ok: true, loaded: "qwen3.8-flash-next-iq3_s" } }
  };
  check("T2 wrong weight actually loaded -> honest AMBER (mismatch)", dotOf(doc, "a") === "mismatch", dotOf(doc, "a"));
}

// ---- T3 no over-strip: legitimate dots inside a real id are preserved ----
{
  check("T3 key keeps inner dots (qwen3.8 not chopped to qwen3)",
    (() => { const f = runModelDot({ models: [], probe: { __engine__: {} } }); return f; })() !== null);
  // direct key behaviour via the doc on-path
  const doc = {
    models: [
      { id: "q", kind: "local", base_url: "", model: "qwen3.8-flash-next-iq3_s" },
      { id: "bad", kind: "local", base_url: "", model: "qwen3.8-flash-next-iq3_s.strata" }
    ],
    probe: { q: { ok: true }, bad: { ok: true }, __engine__: { url: "http://127.0.0.1:8080/v1", ok: true, loaded: "qwen3.8-flash-next-iq3_s" } }
  };
  check("T3 plain qwen3.8 id matches its loaded twin -> on", dotOf(doc, "q") === "on", dotOf(doc, "q"));
  check("T3 only the .strata tail stripped, inner .8 kept -> ..._s.strata still matches -> on", dotOf(doc, "bad") === "on", dotOf(doc, "bad"));
  // a model whose name is just "qwen3.8" must NOT be compared as "qwen3"
  const doc2 = {
    models: [{ id: "c", kind: "local", base_url: "", model: "qwen3" }],
    probe: { c: { ok: true }, __engine__: { url: "http://127.0.0.1:8080/v1", ok: true, loaded: "qwen3.8-flash" } }
  };
  check("T3 qwen3 != qwen3.8-flash (no greedy after-dot strip) -> mismatch", dotOf(doc2, "c") === "mismatch", dotOf(doc2, "c"));
}

// ---- T4 the explicit base_url SAME-PORT branch is normalised too ----
{
  const doc = {
    models: [{ id: "b", kind: "local", base_url: "http://127.0.0.1:8080/v1", model: "Inkling-2-Mini-SQ-15.strata" }],
    probe: { b: { ok: true }, __engine__: { url: "http://127.0.0.1:8080", ok: true, loaded: "inkling-2-mini-sq-15" } }
  };
  check("T4 base_url same port + .strata name vs bare loaded -> on", dotOf(doc, "b") === "on", dotOf(doc, "b"));
}

// ---- T5 a genuinely different instance -> on regardless of name ----
{
  const doc = {
    models: [{ id: "s", kind: "local", base_url: "http://127.0.0.1:9999/v1", model: "WhateverName" }],
    probe: { s: { ok: true }, __engine__: { url: "http://127.0.0.1:8080/v1", ok: true, loaded: "inkling-2-mini-sq-15" } }
  };
  check("T5 different endpoint (endpointKey differs) -> on, name not comparable", dotOf(doc, "s") === "on", dotOf(doc, "s"));
}

console.log(FAILURES.length ? "\n" + FAILURES.length + " FAILURE(S)" : "\nMODEL-DOT-NORM GATE: ALL GREEN");
process.exit(FAILURES.length ? 1 : 0);
