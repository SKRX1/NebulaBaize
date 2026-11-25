// serve/web/app_utils.js - shared pure formatting helpers for app.js.
// Loaded BEFORE app.js (see index.html). Classic script: top-level function
// declarations land on the global scope, so app.js's call sites stay unchanged.
// Each function here touches only standard globals (Date/Number/String/RegExp)
// and no app.js state -- they are extracted as pure, dependency-free leaves.
"use strict";

// epoch ms / numeric time -> "HH:MM" (24h, zero-padded) for chat message meta lines.
function timeStr(t) { return new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }

// bytes -> "x.y KB" / "x.y MB" (binary units, 1 decimal).
function fmtBytesSel(n) { return n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

// markdown plan text -> [{done, label}] (a "- [x] do"/"* [ ] todo" checklist parser).
function parsePlanItems(raw) {
  return String(raw || "").split("\n").map((s) => s.trim()).filter(Boolean).map((s) => {
    const done = /^[-*]\s*\[[xX]\]/i.test(s);
    const label = s.replace(/^[-*]\s*\[[ xX]\]\s*/, "").trim();
    return {done, label};
  }).filter((it) => it.label);
}
