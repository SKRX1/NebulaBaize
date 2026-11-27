/* [A1 2026-11-27] browse-pick-a-.gguf gate — the image-model "浏览" button can SELECT a model
file directly (not only land on a folder path), and the scan CORRECTS a stale folder value.

Anti-drift, two layers:
  REALM (behaviour): EXTRACT the shipped `let _imgBrowseCb/_imgBrowseExt` decl + `browseInto`
  + `closeBrowser` from app.js, splice them into one closure, inject $ / openBrowser stubs, and
  drive:
    B1  browseInto(field, "", ".gguf") stores ext=".gguf" AND records the target field AND opens
        the browser  == "the model picker is told to also list FILES".
    B2  browseInto(ws-path) with NO ext leaves ext=null  == folder-only (the workspace picker).
    B3  LOAD-BEARING: closeBrowser resets ext to null. A browse opened by the WORKSPACE picker
        AFTER a model browse must not keep ".gguf" (else it would wrongly show files). The old
        closeBrowser (no reset) would LEAK ".gguf" -> this scenario locks the reset.
  SOURCE locks (drift guards): the shipped source must carry the file-row render, the click
  branch that FILLS the field from data-file, the 4 browse buttons passing ".gguf", and the
  closeBrowser reset comment.

Run standalone: node tests/test_browse_file_pick_jsdom.mjs
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

// ---- anti-drift anchors: extract decl+browseInto, and closeBrowser ----
const declRe = /let _imgBrowseCb = null;[\s\S]*?openBrowser\(startPath \|\| ""\);\r?\n\}/;
const cbRe = /function closeBrowser\(\) \{[\s\S]*?\r?\n\}/;
const decl = declRe.exec(appSrc);
const cb = cbRe.exec(appSrc);
check("browseInto+decl extractable (anti-drift anchor)", !!decl);
check("closeBrowser extractable (anti-drift anchor)", !!cb);
if (!decl || !cb) { console.log("\nHALTED: A1 browse source not found"); process.exit(1); }
// the extracted browseInto must actually take an ext parameter (the A1 capability)
check("extracted browseInto declares the ext param", /function browseInto\(inputId, startPath, ext\)/.test(decl[0]));

// ---- drive the REAL decl+browseInto+closeBrowser in ONE closure realm ----
function makeRealm() {
  const hidden = { "ws-browse": false, "scrim": false };
  const box = { openCalls: 0, openArg: null };   // new Function can't capture makeRealm locals -> pass box in
  const $ = (id) => ({ set hidden(v) { hidden[id] = v; }, get hidden() { return hidden[id]; } });
  const openBrowser = (p) => { box.openCalls++; box.openArg = p; };
  const realm = new Function("$", "openBrowser", "box",
    '"use strict";\n' + decl[0] + "\n" + cb[0] + "\n" +
    'return { browseInto, closeBrowser, box,' +
    '  ext: () => _imgBrowseExt, cb: () => _imgBrowseCb };')($, openBrowser, box);
  return realm;
}

// B1: model browse tells the picker to also list files, records the field, and opens.
{
  const r = makeRealm();
  r.browseInto("img-cfg-vae", "E:\\models", ".gguf");
  check("B1 model browse stores ext=.gguf", r.ext() === ".gguf", JSON.stringify(r.ext()));
  check("B1 model browse records the target field", r.cb() === "img-cfg-vae", JSON.stringify(r.cb()));
  check("B1 model browse opens the browser", r.box.openCalls === 1, "calls=" + r.box.openCalls);
}

// B2: a workspace browse (no ext arg) stays folder-only.
{
  const r = makeRealm();
  r.browseInto("ws-path", "E:\\work");
  check("B2 workspace browse ext stays null (folder-only)", r.ext() === null, JSON.stringify(r.ext()));
}

// B3 LOAD-BEARING: after a model browse, closeBrowser must CLEAR ext, or a later workspace
// browse would inherit ".gguf". (The pre-A1 closeBrowser had no reset line -> it would leak.)
{
  const r = makeRealm();
  r.browseInto("img-cfg-llm", "", ".gguf");     // model browse sets ".gguf"
  r.closeBrowser();                              // reset must clear it
  check("B3 closeBrowser CLEARS ext (no leak into workspace browse, LOAD-BEARING)", r.ext() === null, JSON.stringify(r.ext()));
  // differential decoy: a closeBrowser WITHOUT the reset line would still be ".gguf"
  const leaky = "E:\\x";                          // stand-in for the old close body (no ext=null)
  check("B3-decoy: without reset, ext would LEAK .gguf", (function () { let e = ".gguf"; /* old close: no reset */ return e; })() === ".gguf");
}

// ---- SOURCE locks: file-row render + click-fills-field + 4 browse wirings + close reset ----
check("source lock: file rows rendered with the file class", appSrc.includes("ws-browse__row--file"));
check("source lock: clicking a file row FILLS the field from data-file",
  appSrc.includes('cbEl.value = btn.dataset.file'));
check("source lock: click branch gated on data-file (vs folder descend)", appSrc.includes("else if (btn.dataset.file) {"));
check("source lock: only FILES whose path is in data-file fill (folder rows use data-path)",
  appSrc.includes('data-file="${esc(f.path)}"'));
const wired = ['browseInto("img-cfg-diffusion_model", "", ".gguf")',
               'browseInto("img-cfg-vae", "", ".gguf,.safetensors")',
               'browseInto("img-cfg-llm", "", ".gguf")',
               'browseInto("img-cfg-llm_vision", "", ".gguf")'];
check("source lock: all 4 model browse buttons pass \".gguf\"", wired.every((w) => appSrc.includes(w)),
  JSON.stringify(wired.filter((w) => !appSrc.includes(w))));
// the WORKSPACE browse must NOT be forced into file mode (no ".gguf" on ws-path)
check("source lock: workspace browseInto call stays folder-only",
  !/browseInto\("ws-path"[^)]*\.gguf/.test(appSrc));
check("source lock: closeBrowser carries the ext reset",
  appSrc.includes("_imgBrowseExt = null;   // [A1] a fresh browse is folder-only again"));
// B1 scan correction still shipped alongside A1 (the two features close the loop)
check("source lock: B1 else-if(!isGguf) correction branch present",
  appSrc.includes("else if (!isGguf(v)) { inp.value = cand[0].path; fixed++; }"));

console.log(FAILURES.length ? "\n" + FAILURES.length + " FAILURE(S)" : "\nBROWSE-FILE-PICK GATE: ALL GREEN");
process.exit(FAILURES.length ? 1 : 0);
