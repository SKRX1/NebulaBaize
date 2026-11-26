/* modelDot 名字归一化 + "同一份权重"宽判 差分门禁（A+B：.strata 后缀归一化；C：前缀同源宽判）。

Anti-drift: EXTRACT the REAL modelCompareKey / modelSameWeights / modelOnline / modelDot from
app.js (the shipped source), wrap them with injected modelsDoc + endpointKey, and drive DIFFERENTIAL
scenarios that prove each decision is load-bearing:
  T1 LOAD-BEARING  entry model "...-abliterated" + engine serves the TRUNCATED "-abl" served name
       -> the longer name has the loaded name as a PREFIX -> GREEN. decoy: a verbatim compare WOULD
       mismatch -> proves the prefix tolerance (modelSameWeights) is load-bearing for the real bug.
  T2 honest-amber   engine holds a genuinely different, non-prefix weight (qwen) while the entry is
       Inkling -> still "mismatch" (amber). Prefix tolerance must NOT paper over a real wrong weight.
  T3 prefix-same    after C, a configured name that is a prefix of (or prefixed by) the loaded name is
       the SAME weights -> on. qwen3.8-flash matches loaded qwen3.8 (configured is the longer form).
       sibling guard: swift-1.5-iq3_s vs swift-1.5-iq3_xxs are NOT prefixes of each other -> mismatch.
       short-name guard: a <4-char stub that is a prefix must NOT match -> mismatch (no match-everything).
  T4 both-branches  the explicit base_url ON-the-same-port branch (modelDot's other name-compare) is
       tolerant too: "...strata" vs loaded without the suffix -> on.
  T5 diff-instance  an entry pointing at a DIFFERENT endpoint (endpointKey differs) is "on" regardless
       of name (it is a genuinely separate instance, the name is not comparable).
  T6 no-overstrip   a real model id legitimately CONTAINS dots (qwen3.8-flash-next-iq3_s); the key must
       keep it intact (NOT strip an arbitrary after-dot segment).

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
// extract the FOUR real fns from the shipped source (anti-drift anchors)
const keyM   = /function modelCompareKey\(s\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
const sameM  = /function modelSameWeights\(a, b\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
const onM    = /function modelOnline\(m\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
const dotM   = /function modelDot\(m\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
check("modelCompareKey extractable (anti-drift anchor)", !!keyM);
check("modelSameWeights extractable (anti-drift anchor)", !!sameM);
check("modelOnline extractable (anti-drift anchor)", !!onM);
check("modelDot extractable (anti-drift anchor)", !!dotM);
if (!keyM || !sameM || !onM || !dotM) { console.log("\nHALTED: dot fns not found"); process.exit(1); }

function runModelDot(modelsDoc) {
  const fn = new Function(
    "modelsDoc", "endpointKey",
    `"use strict"; ${keyM[0]} ${sameM[0]} ${onM[0]} ${dotM[0]} return modelDot;`
  );
  const endpointKey = (u) => String(u || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\/v1$/, "");
  return fn(modelsDoc, endpointKey);
}
const dotOf = (doc, id) => runModelDot(doc)(doc.models.find((x) => x.id === id));
const LOCAL = (model) => [{ id: "a", kind: "local", base_url: "", model }];
const ENG = (loaded, url = "http://127.0.0.1:8080/v1") => ({ url, ok: true, loaded });
const doc = (model, loaded, url) => ({
  models: LOCAL(model),
  probe: { a: { ok: true }, __engine__: ENG(loaded, url) }
});

// ---- T1 LOAD-BEARING (the real bug): full-word configured vs truncated served name ----
{
  const d = doc("Inkling-2-Mini-SQ-15-abliterated", "inkling-2-mini-sq-15-abl");
  const dot = dotOf(d, "a");
  check("T1 full word vs truncated served name -> GREEN (prefix match)", dot === "on", dot);
  const verbatim = "Inkling-2-Mini-SQ-15-abliterated".trim().toLowerCase() === "inkling-2-mini-sq-15-abl".trim().toLowerCase();
  check("T1-decoy verbatim compare WOULD mismatch (prefix tolerance is load-bearing)", !verbatim, String(verbatim));
}

// ---- T2 honest amber: a genuinely different, NON-prefix weight -> still mismatch ----
{
  const dot = dotOf(doc("Inkling-2-Mini-SQ-15-abliterated", "qwen3.8-flash-next-iq3_s"), "a");
  check("T2 wrong non-prefix weight actually loaded -> honest AMBER", dot === "mismatch", dot);
}

// ---- T3 prefix-same weights + sibling/short-name guards ----
{
  // configured is the LONGER form, loaded is the prefix -> same weights -> on
  const longer = dotOf(doc("qwen3.8-flash-next-iq3_s", "qwen3.8-flash"), "a");
  check("T3 configured longer, loaded a prefix -> on", longer === "on", longer);
  // sibling: neither is a prefix of the other -> honest amber
  const sib = dotOf(doc("swift-1.5-iq3_s", "swift-1.5-iq3_xxs"), "a");
  check("T3 sibling _s vs _xxs (not prefixes) -> mismatch", sib === "mismatch", sib);
  // short-name guard: "abc" is a prefix of "abcdef" but <4 chars must NOT match-everything
  const stub = dotOf(doc("abc", "abcdef"), "a");
  check("T3 short-name <4 stub that IS a prefix -> mismatch (guard)", stub === "mismatch", stub);
}

// ---- T4 the explicit base_url SAME-PORT branch is tolerant too ----
{
  const d = {
    models: [{ id: "b", kind: "local", base_url: "http://127.0.0.1:8080/v1", model: "Inkling-2-Mini-SQ-15.strata" }],
    probe: { b: { ok: true }, __engine__: { url: "http://127.0.0.1:8080", ok: true, loaded: "inkling-2-mini-sq-15" } }
  };
  check("T4 base_url same port + .strata name vs bare loaded -> on", dotOf(d, "b") === "on", dotOf(d, "b"));
}

// ---- T5 a genuinely different instance -> on regardless of name ----
{
  const d = {
    models: [{ id: "s", kind: "local", base_url: "http://127.0.0.1:9999/v1", model: "WhateverName" }],
    probe: { s: { ok: true }, __engine__: { url: "http://127.0.0.1:8080/v1", ok: true, loaded: "inkling-2-mini-sq-15" } }
  };
  check("T5 different endpoint (endpointKey differs) -> on, name not comparable", dotOf(d, "s") === "on", dotOf(d, "s"));
}

// ---- T6 no over-strip: legitimate dots inside a real id are preserved ----
{
  const d = doc("qwen3.8-flash-next-iq3_s", "qwen3.8-flash-next-iq3_s");
  check("T6 exact id with inner dots matches its loaded twin -> on", dotOf(d, "a") === "on", dotOf(d, "a"));
  // qwen3 must NOT be compared as a stripped "qwen": the .8 is preserved so it stays a prefix-match
  // on the longer qwen3.8 id (documented C behaviour), and never a strip of an arbitrary dot segment.
  const d2 = doc("qwen3.9x", "qwen3.8-flash");  // neither is a prefix of the other
  check("T6 qwen3.9x vs qwen3.8-flash (neither prefix) -> mismatch", dotOf(d2, "a") === "mismatch", dotOf(d2, "a"));
}

console.log(FAILURES.length ? "\n" + FAILURES.length + " FAILURE(S)" : "\nMODEL-DOT-NORM GATE: ALL GREEN");
process.exit(FAILURES.length ? 1 : 0);
