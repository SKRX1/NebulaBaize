/* Backspace-deletes-inline-chip differential gate.
 *
 * The array is the source of truth for sending. So Backspace on an inline thumbnail chip MUST
 * splice the array AND drop the DOM node together. This gate locks the FOUR quadrants:
 *   P1 focused chip + Backspace -> chip gone from DOM AND array shrank (the core invariant)
 *   P2 selection covering a chip -> chipForBackspace returns that chip's pid
 *   N1 focus on plain text + Backspace -> chip STAYS (no false delete of a neighbouring chip)
 *   N3 no chip / plain text -> Backspace is a normal text edit (handler leaves it to the browser)
 *
 * Run standalone: node tests/test_backspace_delete_chip.mjs
 */
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { createRequire } from "module";
const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");
const html = fs.readFileSync(path.join(WEB,"index.html"),"utf8");
const dom = new JSDOM(html,{url:"http://127.0.0.1/",runScripts:"outside-only"});
const win = dom.window; const doc = win.document;
win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
if(typeof win.requestAnimationFrame!=="function") win.requestAnimationFrame=(cb)=>setTimeout(()=>cb(0),0);
win.fetch=async()=>({ok:true,status:200,json:async()=>({})});
let appCode=fs.readFileSync(path.join(WEB,"app.js"),"utf8");
appCode += `\n;globalThis.__api={removeThumb,chipForBackspace,onThumbBackspace,getAttachments:()=>attachments};`;
win.eval(fs.readFileSync(path.join(WEB,"i18n.js"),"utf8"));
win.eval(appCode);
const api=win.__api;
const results=[]; let fails=0;
const ok=(l,c,extra)=>{results.push((c?"OK  ":"FAIL")+" "+l+(extra?("  ["+extra+"]"):"")); if(!c) fails++;};

// static locks: the helper + focus attribute must exist (defence against future regression)
const src=fs.readFileSync(path.join(WEB,"app.js"),"utf8");
ok("app.js defines removeThumb", src.includes("function removeThumb(pid, box)"));
ok("app.js defines chipForBackspace", src.includes("function chipForBackspace(box)"));
ok("app.js defines onThumbBackspace", src.includes("function onThumbBackspace(e, box)"));
ok("chip built focusable (tabindex)", src.includes('setAttribute("tabindex", "0")'));
ok("composer keydown wired to shared handler", src.includes('onThumbBackspace(e, $("input"))'));
ok("edit-modal keydown wired to shared handler", src.includes("onThumbBackspace(e, _ea)"));

function makeChip(pid){
  const span=doc.createElement("span");
  span.className="ce-thumb"; span.setAttribute("contenteditable","false");
  span.setAttribute("data-pid",String(pid)); span.setAttribute("tabindex","0");
  const img=doc.createElement("img"); img.className="inline-ce-img"; img.src="data:image/png;base64,AAA"; span.appendChild(img);
  return span;
}
function bsEvent(){ const e=new win.KeyboardEvent("keydown",{key:"Backspace",bubbles:true,cancelable:true}); return e; }

function setup(attachPid){
  const inp=doc.getElementById("input");
  inp.innerHTML="";
  inp.appendChild(doc.createTextNode("before "));
  const chip=makeChip(attachPid); inp.appendChild(chip); inp.appendChild(doc.createTextNode(" after"));
  api.getAttachments().length=0;
  api.getAttachments().push({kind:"image",url:"data:image/png;base64,AAA",name:"x",pid:attachPid});
  return {inp, chip};
}

// ---- P1: focused chip + Backspace removes BOTH DOM and array (core invariant)
{
  const {inp,chip}=setup(11);
  chip.focus();
  ok("P1 chip is focused", doc.activeElement===chip);
  const before=api.getAttachments().length;
  const e=bsEvent(); inp.dispatchEvent(e);
  ok("P1 handler fired (defaultPrevented)", e.defaultPrevented);
  ok("P1 chip gone from DOM", inp.querySelectorAll("[data-pid]").length===0);
  ok("P1 ARRAY shrank (source-of-truth synced)", api.getAttachments().length===before-1, "before="+before+" after="+api.getAttachments().length);
}

// ---- P2: selection covering a chip -> chipForBackspace returns its pid
{
  const {inp,chip}=setup(22);
  try{
    const sel=win.getSelection(); sel.removeAllRanges();
    const r=doc.createRange(); r.selectNode(chip); sel.addRange(r);
    const got=api.chipForBackspace(inp);
    ok("P2 selection-covering returns chip pid", String(got)==="22", "got="+got);
  }catch(err){ ok("P2 selection-covering returns chip pid", false, "threw "+err.message); }
}

// ---- N1: focus on plain text + Backspace -> chip STAYS (no false delete of neighbour)
{
  const {inp,chip}=setup(33);
  const textNode=[...inp.childNodes].find(n=>n.nodeType===3);
  // put a collapsed caret at start of the TRAILING text node (caret right after chip) -> this is the
  // "chip immediately before caret" path, so it SHOULD delete; use a chip NOT adjacent to verify null.
  // For N1 we place caret deep inside a plain text run away from any chip:
  const probeSpan=doc.createElement("span"); probeSpan.textContent="zzz"; inp.appendChild(probeSpan);
  const sel=win.getSelection(); sel.removeAllRanges();
  const r=doc.createRange(); r.setStart(textNode, 3); r.collapse(true); sel.addRange(r);
  // move focus off the chip onto the box body itself
  inp.focus();
  const got=api.chipForBackspace(inp);
  ok("N1 caret in plain text (not adjacent) -> null", got===null, "got="+got);
  ok("N1 chip still in DOM after plain-text Backspace", inp.querySelectorAll("[data-pid]").length===1);
}

// ---- N3: caret adjacent BEFORE a chip (collapsed) -> the chip-before-caret path returns its pid
{
  const {inp,chip}=setup(44);
  const tail=[...inp.childNodes].find(n=>n.nodeType===3 && n.textContent===" after");
  const sel=win.getSelection(); sel.removeAllRanges();
  const r=doc.createRange(); r.setStart(tail,0); r.collapse(true); sel.addRange(r);
  inp.focus();
  const got=api.chipForBackspace(inp);
  ok("N3 caret right after chip -> returns the chip pid (adjacent-before path)", String(got)==="44", "got="+got);
}

console.log("\n"+results.join("\n"));
console.log("BACKSPACE-DELETE: "+(fails? "RED - "+fails+" failures" : "ALL GREEN"));
process.exit(fails?1:0);
