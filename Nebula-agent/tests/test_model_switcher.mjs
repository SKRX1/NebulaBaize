/* Regression test for the model switcher (composer, left of Send).
 *
 * The list is the SERVER's (models.json). The chip must:
 *   T1  stay hidden until the list arrives, then show the selected entry's name
 *   T2  open a popover that groups local / custom and marks the current one
 *   T3  switch: clicking an entry POSTs the new `selected` and the chip follows
 *   T4  name the model on every request (requestModel() is what the body carries)
 *   T5  manage: the modal lists entries, and adding one POSTs the whole list
 *   T6  never put an api_key in the page: the form leaves it empty and the entry says a key is stored
 *
 * Run: node tests/test_model_switcher.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(path.resolve(HERE, ".."), "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
                      {url: "http://127.0.0.1:8765/", runScripts: "outside-only"});
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; }});
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.confirm = () => true;
win.localStorage.setItem("strata.lang", "en");

let DOC = {
  selected: "self",
  models: [
    {id: "self", name: "swift-1.5-iq3_s", kind: "local", base_url: "", model: "swift-1.5-iq3_s", api_key_set: false},
    {id: "xxs", name: "swift-1.5-iq3_xxs", kind: "local", base_url: "http://127.0.0.1:8081",
     model: "swift-1.5-iq3_xxs", api_key_set: false},
    {id: "hy4", name: "Hy4 preview", kind: "custom", base_url: "https://api.example.com/v1",
     model: "gpt-4o", api_key_set: true, tools: true, vision: false,
     think_modes: ["low", "medium"], think_default: "medium"},
  ],
};
const posted = [];
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("models/config")) {
    if ((opts.method || "GET").toUpperCase() === "POST") {
      const body = JSON.parse(opts.body || "{}");
      posted.push(body);
      DOC = {selected: body.selected || DOC.selected,
             models: (body.models || DOC.models).map((m) => {
               const old = DOC.models.find((o) => o.id === m.id);
               return {...m, api_key_set: !!(m.api_key || (old && old.api_key_set))};
             })};
    }
    return {ok: true, status: 200, json: async () => DOC};
  }
  if (u.endsWith("health")) return {ok: true, status: 200, json: async () => ({model: "swift-1.5-iq3_s", max_context: 32768})};
  if (u.includes("metrics")) return {ok: true, status: 200, json: async () => ({engine: {max_context: 32768}})};
  return {ok: true, status: 200, json: async () => ({})};
};

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let code = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
code += `
;window.__api = {
  loadModels, currentModel, requestModel, paintModelChip, openModelPop, closeModelPop, renderModelPop,
  selectModel, openModelModal, openModelForm, submitModelForm, renderModelList,
  modelThinking, modelAcceptsImages, modelAllowsTools, getDoc: () => modelsDoc,
  setSessionThinking: (v) => { settings.thinking = v; },
};`;
win.eval(code);
const api = win.__api;
const $ = (id) => doc.getElementById(id);

console.log("\n=== T1: the chip waits for the list, then names the selection ===");
check("hidden before the list arrives", $("model-btn").hidden);
await api.loadModels();
check("shown once it arrives", !$("model-btn").hidden);
check("it names the selected entry  " + JSON.stringify($("model-name").textContent),
      $("model-name").textContent === "swift-1.5-iq3_s");
check("a local self entry is marked live", $("model-btn").dataset.local === "1");

console.log("\n=== T2: the popover groups them and marks the current one ===");
api.openModelPop();
const pop = $("model-pop");
check("the popover opened", !pop.hidden);
const groups = [...pop.querySelectorAll(".model-pop__group")].map((n) => n.textContent);
check("two groups: local and custom  " + JSON.stringify(groups), groups.length === 2);
const items = [...pop.querySelectorAll("[data-model]")].map((n) => n.dataset.model);
check("every entry is listed  " + JSON.stringify(items), JSON.stringify(items) === JSON.stringify(["self", "xxs", "hy4"]));
check("exactly one is marked on", pop.querySelectorAll(".model-pop__item.is-on").length === 1);
check("the marked one is the selected one", pop.querySelector(".model-pop__item.is-on").dataset.model === "self");
check("it offers to add and to manage",
      !!pop.querySelector('[data-act="add"]') && !!pop.querySelector('[data-act="manage"]'));

console.log("\n=== T3: switching posts the id and the chip follows ===");
await api.selectModel("hy4");
check("a save was posted", posted.length === 1);
check("it carried the new selection  " + JSON.stringify(posted[0] && posted[0].selected),
      posted[0].selected === "hy4");
check("the whole list went with it (nothing is dropped)", (posted[0].models || []).length === 3);
check("the chip now names it  " + JSON.stringify($("model-name").textContent),
      $("model-name").textContent === "Hy4 preview");
check("and it is no longer marked live", $("model-btn").dataset.local === "0");

console.log("\n=== T4: the request carries the selected id ===");
check("requestModel() is the id  " + JSON.stringify(api.requestModel()), api.requestModel() === "hy4");
await api.selectModel("xxs");
check("switching again follows", api.requestModel() === "xxs");

console.log("\n=== T5: the manager lists entries and adding one saves the list ===");
api.openModelModal("list");
check("the modal is open", !$("model-modal").hidden);
check("the list shows every entry", $("model-list").querySelectorAll("[data-id]").length === 3);
api.openModelForm(null);
check("the form replaced the list", $("model-form").hidden === false && $("model-list").hidden === true);
$("mf-name").value = "Local Ollama";
$("mf-url").value = "http://127.0.0.1:11434/v1";
$("mf-model").value = "qwen2.5:14b";
$("mf-tools").checked = true;
$("mf-vision").checked = false;
$("mf-think").value = "auto";
await api.submitModelForm();
const last = posted[posted.length - 1];
check("the new entry was posted  " + JSON.stringify((last.models || []).map((m) => m.id)),
      (last.models || []).some((m) => m.name === "Local Ollama"));
const added = (last.models || []).find((m) => m.name === "Local Ollama");
check("with its endpoint and capabilities",
      added && added.base_url === "http://127.0.0.1:11434/v1" && added.model === "qwen2.5:14b" && added.tools === true);

console.log("\n=== T6: no key ever lands in the page ===");
check("the public list carries no api_key", DOC.models.every((m) => !("api_key" in m)));
check("but the stored one is advertised", DOC.models.find((m) => m.id === "hy4").api_key_set === true);
api.openModelForm("hy4");
check("editing leaves the key field empty", $("mf-key").value === "");
check("and says a key is already stored", /stored|已保存/i.test($("mf-key").placeholder || ""), $("mf-key").placeholder);

console.log("\n=== T7: editing THIS instance needs no address (it is on this PC) ===");
api.openModelForm("self");
check("the form opened it as a local instance  " + JSON.stringify($("mf-kind").value), $("mf-kind").value === "local");
check("the address field is empty", $("mf-url").value === "");
check("no API Key is asked for", $("mf-key-field").hidden === true);
check("the tool-calls switch IS shown for a local instance (a real per-model MCP switch)",
      $("mf-tools-field").hidden === false);
$("mf-name").value = "swift-1.5-iq3_s (本机)";
const before = posted.length;
await api.submitModelForm();
check("it saved without demanding an http address", posted.length === before + 1);
const edited = (posted[posted.length - 1].models || []).find((m) => m.id === "self");
check("and it is still a local entry  " + JSON.stringify(edited && edited.kind), edited && edited.kind === "local");
check("with the edited name", edited && edited.name === "swift-1.5-iq3_s (本机)");

console.log("\n=== T8: an external endpoint still must have a real address ===");
api.openModelForm(null);
check("adding defaults to a custom endpoint", $("mf-kind").value === "custom");
check("the key field is back", $("mf-key-field").hidden === false);
$("mf-name").value = "Bad endpoint";
$("mf-url").value = "ftp://x.example";
const before2 = posted.length;
await api.submitModelForm();
check("a non-http address is refused  " + `${posted.length} vs ${before2}`, posted.length === before2);

console.log("\n=== T9: thinking level and images come from the entry, not the label ===");
await api.selectModel("hy4");
api.setSessionThinking("auto");   // baseline for T9: session is auto so the pinned think_default wins
check("a pinned default level is used  " + JSON.stringify(api.modelThinking()), api.modelThinking() === "medium");
check("an entry that takes no images says so", api.modelAcceptsImages() === false);
api.setSessionThinking("high");
check("a pinned level beats the session setting", api.modelThinking() === "medium");
// a level it does not support is clamped instead of sent
DOC.models.find((m) => m.id === "hy4").think_default = "high";
check("an unsupported level is clamped to one it does support  " + JSON.stringify(api.modelThinking()),
      api.modelThinking() === "medium");
DOC.models.find((m) => m.id === "hy4").think_default = "medium";

await api.selectModel("self");
check("a local entry follows the session setting  " + JSON.stringify(api.modelThinking()),
      api.modelThinking() === "high");

console.log("\n=== T10: the form shows the supported levels, and rejects a default outside them ===");
api.openModelForm("hy4");
const checks = [...doc.querySelectorAll(".mf-mode")].filter((c) => c.checked).map((c) => c.value);
check("only its supported levels are ticked  " + JSON.stringify(checks), JSON.stringify(checks) === JSON.stringify(["low", "medium"]));
check("the default is preselected  " + JSON.stringify($("mf-think").value), $("mf-think").value === "medium");
$("mf-think").value = "high";
const before3 = posted.length;
await api.submitModelForm();
check("a default outside the ticked levels is refused  " + `${posted.length} vs ${before3}`, posted.length === before3);

console.log("\n=== T11: the send gate follows the ACTIVE entry's tools flag (real switch) ===");
await api.selectModel("self");
check("a local entry WITHOUT a tools flag allows tools (default keep-old-behaviour)", api.modelAllowsTools() === true);
api.getDoc().models.find((m) => m.id === "self").tools = false;   // the checkbox saved as OFF
check("the same entry with tools:false turns tools OFF  (load-bearing)", api.modelAllowsTools() === false);
api.getDoc().models.find((m) => m.id === "self").tools = true;
check("tools:true allows them again", api.modelAllowsTools() === true);
api.getDoc().models.find((m) => m.id === "self").tools = undefined;  // restore: drop the key

console.log("");
if (FAILURES.length) {
  console.log(`MODEL SWITCHER: ${FAILURES.length} FAILED`);
  FAILURES.forEach((f) => console.log("  - " + f));
} else {
  console.log("MODEL SWITCHER: ALL PASSED");
}
process.exit(FAILURES.length ? 1 : 0);
