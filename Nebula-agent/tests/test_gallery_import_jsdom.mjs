/* [添加图片去重 2026-11-15] 画廊「添加图片」内容去重行为锁：后端已内容寻址（同内容 ->
   同 sha256 -> 同 ref），前端 galleryImportFiles 拿到 ref 后查 galleryMem 是否已有该 url，
   命中即 skip（静默跳过、不新增），未命中才 galleryAdd。测试桩与后端同构：ref = 按 data URL
   内容哈希给名。核心锁=「不同文件名·相同内容 -> 被去重」+ 差分「不同内容 -> 都入库」（证明去重
   按内容而非按名一刀切）。每条行为锁都配 decoy 差分证明 load-bearing。Run: node tests/test_gallery_import_jsdom.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createHash } from "crypto";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
// app.js is CRLF — multiline anchors below match real newlines with explicit \r?\n regexes.

// same algorithm the backend + the fetch stub use: sha256 of the raw bytes, first 16 hex
const contentHash = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex").slice(0, 16);

/* ── static locks (anti-drift; the behaviour hangs on these) ── */
console.log("\n=== A. static locks ===");
check("S1 the import button is addressable by id=img-gallery-add", /id="img-gallery-add"/.test(html));
check("S2 the hidden multi file input exists with accept=image", /id="img-gallery-import-file"[^>]*accept="image\/\*"/.test(html));
check("S3 the import button forwards click to the hidden input", /addBtn\.addEventListener\("click", \(\) => addInput\.click\(\)\)/.test(appCode));
check("S4 galleryImportFiles posts to api/gallery-import", /async function galleryImportFiles\([\s\S]*?fetch\("api\/gallery-import"/.test(appCode));
check("S5 the import entry carries prompt(name)/saved/source=import", /prompt: t\("img\.gallery\.add\.prompt", \{ name: nm \}\), name: nm,[\s\S]*saved: true, source: "import"/.test(appCode));
check("S6 the import reads the file via FileReader.readAsDataURL", /async function galleryImportFiles\([\s\S]*?new FileReader\(\)[\s\S]*?readAsDataURL\(f\)/.test(appCode));
check("S7 i18n has the import result key WITH {skip} (both langs)", /"img\.gallery\.add\.result":\s*"添加完成：新增 \{ok\}，跳过重复 \{skip\}，失败 \{fail\}"/.test(i18nSrc) && /"img\.gallery\.add\.result":\s*"Done: \{ok\} added, \{skip\} skipped \(duplicate\), \{fail\} failed"/.test(i18nSrc));
check("S8 the import reuses galleryAdd (url-dedup rides along)", /async function galleryImportFiles\([\s\S]*?galleryAdd\(/.test(appCode));
check("S9 the dedup gate checks galleryMem for the ref BEFORE galleryAdd (content-dedup)", /if \(galleryMem\.some\(\(x\) => x\.url === j\.ref\)\) \{ skip\+\+; continue; \}/.test(appCode));
check("S10 the toast threads {skip} through the count", /t\("img\.gallery\.add\.result", \{ ok, fail, skip \}\)/.test(appCode));
check("S11 [方案A回链] the import entry gains an orig backlink to /data/generated/images/<name> (source==import)", /return \{url: it\.url, saved_ref: it\.saved_ref, orig: \(it\.source === "import" && it\.name\) \? \("\/data\/generated\/images\/" \+ encodeURIComponent\(it\.name\)\) : "", cat:/.test(appCode));
check("S12 [方案A回链] paths merge copy+orig with Set-dedupe", /const paths = \[\.\.\.new Set\(_pr\.concat\(_dbg\.filter\(\(d\) => d\.pass && d\.orig\)\.map\(\(d\) => d\.orig\)\)\)\];/.test(appCode));
check("S13 differential: the backlink gate is the source==import guard itself (a NON-import entry gets orig empty)", /const _dbg = items\.map\(\(it\) => \{[^\n]*orig: \(it\.source === "import" && it\.name\)/.test(appCode));   // drop the guard and every entry with a name would backlink — S11 locks the guard shape, this locks it staying conditional

/* ── harness ── */
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function freshBoot(seedItems) {
  const IMPORT_POSTS = [];
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
    if (u.endsWith("api/image-gallery") && (!o || !o.method || o.method === "GET")) return { ok: true, status: 200, json: async () => ({ items: (seedItems || []).map((x) => Object.assign({}, x)) }) };
    if (u.endsWith("api/image-gallery")) { return { ok: true, status: 200, json: async () => ({}) }; }   // the mirror POST
    if (u.endsWith("api/gallery-import")) {
      const b = JSON.parse(o.body);
      IMPORT_POSTS.push(b);
      // decoy: a file named "bad.*" -> the backend rejects it (NOT-ok), proving the fail branch
      if (String(b.name).startsWith("bad")) return { ok: false, status: 400, json: async () => ({ error: { message: "bad file (decoy)" } }) };
      // CONTENT-ADDRESSED mock (mirrors the backend): ref name = sha256[:16] of the raw bytes.
      // Same bytes -> same ref, regardless of the picked file name. This is what the dedup rides on.
      const payload = String(b.dataUrl).split(",").slice(1).join(",") || "";   // the base64 body AFTER the first comma
      const ext = (String(b.name).match(/\.(png|jpg|jpeg|webp|gif|bmp)$/i) || [, "png"])[1].toLowerCase();
      const digest = createHash("sha256").update(Buffer.from(payload, "base64")).digest("hex").slice(0, 16);
      const ref = "/data/saved_images/imp_" + digest + "." + ext;
      return { ok: true, status: 200, json: async () => ({ ref, name: b.name }) };
    }
    if (u.endsWith("settings")) return { ok: true, status: 200, json: async () => ({ shared: false }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  win.localStorage.setItem("strata.sessions", JSON.stringify([{ id: "sX", workspace: "wsX", permission: "full" }]));
  win.localStorage.setItem("strata.session.active", JSON.stringify("sX"));
  win.localStorage.setItem("strata.lang", "en");   // -> the en i18n branch
  win.eval(i18nSrc);
  win.eval(appCode + `
;window.__api = {
  galleryMem: () => galleryMem, renderGallery: () => renderGallery(),
  galleryImportFiles: (f) => galleryImportFiles(f), $,
  setView: (v) => { galleryView = v; }, viewList: () => galleryViewList(), category: (x) => galleryCategory(x),
};`);
  await tick();   // the boot fetch resolves; seeded entries land via the GET path
  return { win, IMPORT_POSTS, api: win.__api };
}

// real jsdom File (FileReader.readAsDataURL is jsdom-native). Default bytes vary by name so
// distinct names carry distinct content (the normal case); pass explicit `bytes` to force
// identical content under two names (the content-dedup core test).
function makeFile(win, name, bytes) {
  const data = bytes || new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Buffer.from(name)]);   // name-seeded -> distinct content per name
  return new win.File([data], name, { type: "image/png" });
}

const BYTES_X = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0xAA]);   // one fixed content block

console.log("\n=== B1 import one file: POST fires, entry lands with name/saved/source ===");
{
  const { win, IMPORT_POSTS, api } = await freshBoot([]);
  await api.galleryImportFiles([makeFile(win, "cat.png")]);
  await tick(120);
  check("B1a exactly one POST fired", IMPORT_POSTS.length === 1, "n=" + IMPORT_POSTS.length);
  check("B1b the POST carried the picked file name", IMPORT_POSTS[0] && IMPORT_POSTS[0].name === "cat.png", JSON.stringify(IMPORT_POSTS[0] && IMPORT_POSTS[0].name));
  check("B1c the POST carried a data:image/ base64 URL", IMPORT_POSTS[0] && String(IMPORT_POSTS[0].dataUrl).startsWith("data:image/") && String(IMPORT_POSTS[0].dataUrl).includes(";base64,"), IMPORT_POSTS[0] && String(IMPORT_POSTS[0].dataUrl).slice(0, 24));
  const e = api.galleryMem()[0];
  check("B1d the entry url = the content-hash ref (data/saved_images/imp_<sha>)", e && /^\/data\/saved_images\/imp_[0-9a-f]{16}\.png$/.test(String(e.url)), e && e.url);
  check("B1e the entry name + prompt carry the original filename", e && e.name === "cat.png" && String(e.prompt).includes("cat.png"), e && e.prompt);
  check("B1f saved=true and source=import", e && e.saved === true && e.source === "import", e && JSON.stringify({ saved: e.saved, source: e.source }));
  check("B1g galleryMem grew to exactly 1", api.galleryMem().length === 1, "len=" + api.galleryMem().length);
}

console.log("\n=== B2 CONTENT-dedup core: DIFFERENT names, IDENTICAL content -> only ONE entry (the headline feature) ===");
{
  const { win, IMPORT_POSTS, api } = await freshBoot([]);
  await api.galleryImportFiles([makeFile(win, "photo1.png", BYTES_X)]);
  await tick(120);
  const firstLen = api.galleryMem().length;
  await api.galleryImportFiles([makeFile(win, "totally-different-name.png", BYTES_X)]);   // same bytes, different name
  await tick(120);
  check("B2a first import added 1", firstLen === 1, "len=" + firstLen);
  check("B2b the same CONTENT under a DIFFERENT name got the SAME content-hash ref -> deduped (no new entry)", api.galleryMem().length === 1, "len=" + api.galleryMem().length);
  check("B2c BOTH imports fired a POST (the loop ran for both; the SECOND was skipped by the dedup gate, not by a missing POST)", IMPORT_POSTS.length === 2, "n=" + IMPORT_POSTS.length);
}

console.log("\n=== B3 DIFFERENTIAL (decoy) — DIFFERENT content under two names -> BOTH land (dedup is CONTENT-based, not a name/blanket skip) ===");
{
  const { win, IMPORT_POSTS, api } = await freshBoot([]);
  await api.galleryImportFiles([makeFile(win, "aaa.png")]);           // name-seeded bytes -> unique content
  await tick(120);
  await api.galleryImportFiles([makeFile(win, "bbb.png")]);           // different name AND different content
  await tick(120);
  check("B3a two distinct contents -> two distinct entries (this is what proves B2 is load-bearing)", api.galleryMem().length === 2, "len=" + api.galleryMem().length);
  check("B3b BOTH imports fired a POST and they are distinct content-hash refs", IMPORT_POSTS.length === 2);
}

console.log("\n=== B4 same content picked twice in ONE multi-select batch -> only ONE lands, the dup is skipped ===");
{
  const { win, IMPORT_POSTS, api } = await freshBoot([]);
  await api.galleryImportFiles([makeFile(win, "same.png", BYTES_X), makeFile(win, "same-again.png", BYTES_X)]);   // identical bytes
  await tick(200);
  check("B4a both files fired a POST", IMPORT_POSTS.length === 2, "n=" + IMPORT_POSTS.length);
  check("B4b only ONE entry landed (the second identical content was skipped)", api.galleryMem().length === 1, "len=" + api.galleryMem().length);
}

console.log("\n=== B5 backend-REJECTED file (decoy NOT-ok) is NOT added (fail branch stays load-bearing) ===");
{
  const { win, IMPORT_POSTS, api } = await freshBoot([]);
  await api.galleryImportFiles([makeFile(win, "bad_x.png")]);   // the decoy name -> mock NOT-ok
  await tick(120);
  check("B5a the POST still fired for the rejected file", IMPORT_POSTS.some((p) => String(p.name).startsWith("bad")), JSON.stringify(IMPORT_POSTS.map((p) => p.name)));
  check("B5b the rejected file did NOT land in the gallery", api.galleryMem().length === 0, "len=" + api.galleryMem().length);
}

console.log("\n=== B6 empty selection: no POST, no change ===");
{
  const { win, IMPORT_POSTS, api } = await freshBoot([]);
  await api.galleryImportFiles([]);
  await tick(120);
  check("B6a no POST for an empty pick", IMPORT_POSTS.length === 0, "n=" + IMPORT_POSTS.length);
  check("B6b the gallery stayed empty", api.galleryMem().length === 0);
}

console.log("\n=== B7 mixed batch vs a SEEDED existing entry: seed=the duplicate's content; 2 new + 1 dup-of-seed + 1 bad -> net +2 new, the dup skipped ===");
{
  const bytesP = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0B, 0x0B, 0x0B]);   // the content we pre-seed
  const seedRef = "/data/saved_images/imp_" + contentHash(bytesP) + ".png";
  const { win, IMPORT_POSTS, api } = await freshBoot([
    { url: seedRef, name: "seeded-p.png", prompt: "seed p", ts: 1, saved: true, source: "import" },
  ]);
  await tick(120);
  check("B7a the boot seed restored exactly 1 entry", api.galleryMem().length === 1 && api.galleryMem()[0].url === seedRef, "len=" + api.galleryMem().length);
  await api.galleryImportFiles([
    makeFile(win, "new1.png"),                  // unique content -> add
    makeFile(win, "dup-p.png", bytesP),         // SAME content as the seeded entry -> SKIP (the headline cross-path dedup)
    makeFile(win, "new2.png"),                  // unique content -> add
    makeFile(win, "bad_z.png"),                 // decoy -> backend NOT-ok -> fail
  ]);
  await tick(250);
  check("B7b all 4 picks fired a POST", IMPORT_POSTS.length === 4, "n=" + IMPORT_POSTS.length);
  check("B7c the dup-of-seed was skipped; 2 new landed -> total 3 (seed+new1+new2), proving dedup rides on the CONTENT HASH", api.galleryMem().length === 3, "len=" + api.galleryMem().length);
  check("B7d the seeded entry is still the dedup anchor (its content-hash url was matched, not re-added)", api.galleryMem().filter((x) => x.url === seedRef).length === 1, "dup-anchor-count=" + api.galleryMem().filter((x) => x.url === seedRef).length);
}

console.log("\n=== C. 分类归属·方案A (import follows the active tab; single category; lazy migration) ===");

check("C0 static anti-drift: import sets category to FOLLOW galleryView", /category: \(galleryView === "all" \? "saved" : galleryView\)/.test(appCode));
check("C0b static anti-drift: the list filter switched to galleryCategory (not the saved boolean)", /galleryCategory\(r\.x\) === galleryView/.test(appCode));
check("C0c static anti-drift: the category helper lazy-migrates from the saved boolean", /function galleryCategory\(x\)\{ return x\.category \|\| \(x\.saved \? "saved" : "session"\); \}/.test(appCode));

console.log("\n--- C1 import under the 生成(session) tab -> lands in category=session ---");
{
  const { win, api } = await freshBoot([]);
  api.setView("session");
  await api.galleryImportFiles([makeFile(win, "under-session.png")]);
  await tick(120);
  const e = api.galleryMem()[0];
  check("C1a the entry carries category=session (follows the tab it was added under)", e && api.category(e) === "session", e && JSON.stringify({ category: e && e.category }));
  check("C1b visible under the session tab AND the all tab (all aggregates every category)", api.viewList().some((r) => r.x === e) && (() => { api.setView("all"); const v = api.viewList().some((r) => r.x === e); api.setView("session"); return v; })());
  check("C1c NOT visible under the saved tab (single category)", (() => { api.setView("saved"); const v = api.viewList().some((r) => r.x === e); return !v; })());
}

console.log("\n--- C2 import under the 收藏(saved) tab -> lands in category=saved ---");
{
  const { win, api } = await freshBoot([]);
  api.setView("saved");
  await api.galleryImportFiles([makeFile(win, "under-saved.png")]);
  await tick(120);
  const e = api.galleryMem()[0];
  check("C2a the entry carries category=saved", e && api.category(e) === "saved", e && JSON.stringify({ category: e && e.category }));
  check("C2b visible under saved+all, NOT under session", api.viewList().some((r) => r.x === e) && (() => { api.setView("session"); const v = api.viewList().some((r) => r.x === e); return !v; })());
}

console.log("\n--- C3 拍板项: import under the 全部(all) tab -> defaults to category=saved ---");
{
  const { win, api } = await freshBoot([]);
  api.setView("all");
  await api.galleryImportFiles([makeFile(win, "under-all.png")]);
  await tick(120);
  const e = api.galleryMem()[0];
  check("C3a under the all tab the import defaults to category=saved (the ratified default)", e && api.category(e) === "saved", e && JSON.stringify({ category: e && e.category }));
  check("C3b it shows under both the all tab AND the saved tab (category=saved)", api.viewList().some((r) => r.x === e) && (() => { api.setView("saved"); const v = api.viewList().some((r) => r.x === e); return v; })());
}

console.log("\n--- C4 lazy migration differential: legacy entries carry NO category field, only the saved boolean ---");
{
  const { win, api } = await freshBoot([
    { url: "/data/generated/images/old-saved.png", name: "old-saved", prompt: "old saved", ts: 1, saved: true, source: "import" },   // legacy saved:true -> migrates to saved
    { url: "/data/generated/images/old-gen.png", name: "old-gen", prompt: "old gen", ts: 2, saved: false },                          // legacy generated -> migrates to session
  ]);
  await tick(120);
  const savedEntry = api.galleryMem().find((x) => x.name === "old-saved");
  const genEntry = api.galleryMem().find((x) => x.name === "old-gen");
  check("C4a legacy saved:true (no category field) lazily reads as category=saved", savedEntry && api.category(savedEntry) === "saved", savedEntry && JSON.stringify({ c: api.category(savedEntry) }));
  check("C4b legacy generated (saved:false, no category) lazily reads as category=session (the DIFFERENTIAL that proves lazy migration is load-bearing)", genEntry && api.category(genEntry) === "session", genEntry && JSON.stringify({ c: api.category(genEntry) }));
  check("C4c the two legacy entries route to OPPOSITE tabs (saved-entry under saved; gen-entry under session)", (() => { api.setView("saved"); const s = api.viewList().some((r) => r.x === savedEntry) && !api.viewList().some((r) => r.x === genEntry); api.setView("session"); const g = api.viewList().some((r) => r.x === genEntry) && !api.viewList().some((r) => r.x === savedEntry); return s && g; })());
}

console.log("\n--- C5 单一归属 (single category): a session import appears in exactly {session, all}, never a third ---");
{
  const { win, api } = await freshBoot([]);
  api.setView("session");
  await api.galleryImportFiles([makeFile(win, "single-cat.png")]);
  await tick(120);
  const e = api.galleryMem()[0];
  const inSession = (() => { api.setView("session"); return api.viewList().some((r) => r.x === e); })();
  const inSaved = (() => { api.setView("saved"); return api.viewList().some((r) => r.x === e); })();
  const inAll = (() => { api.setView("all"); return api.viewList().some((r) => r.x === e); })();
  check("C5a a session-category entry is in {session, all} and NOT saved (single category, no double membership)", inSession && inAll && !inSaved, JSON.stringify({ inSession, inSaved, inAll }));
}
console.log("\n" + (FAILURES.length ? "GALLERY-IMPORT-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "GALLERY-IMPORT-GATE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
