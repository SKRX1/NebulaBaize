/* Bug-faithful differential gate: "Backspace-delete an inline chip then send".
 * THE FIX: the array is the source of truth for sending. The browser's own native Backspace can
 * delete a contenteditable=false atomic chip straight from the DOM -- that path never routes
 * through our handler and never splices the array. So before any send we RECONCILE: drop every
 * array entry whose pid is no longer present in the DOM (方案1). A MutationObserver on each box
 * does the same the instant a chip disappears (方案2, double safety). The hover-button / focused-
 * chip handler paths are untouched (方案3).
 *
 * jsdom CANNOT reproduce the real-browser keyboard-focus behaviour, so the authoritative lock here
 * is the reconcile differential itself: "DOM removed a chip, array not touched -> reconcileArray
 * drops it". Plus static locks that the wiring exists. Real-browser pixel/interaction layer (the
 * keyboard focus landing on the chip vs the container) is for the user to accept at 8099.
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
appCode += `\n;globalThis.__api={reconcileArray,attachChipObserver,removeThumb,chipForBackspace,onThumbBackspace,ceText,getAttachments:()=>attachments,setAttachments:(v)=>{attachments=v},nextPid:()=>attachNextPid()};`;
win.eval(fs.readFileSync(path.join(WEB,"i18n.js"),"utf8"));
win.eval(appCode);
const api=win.__api;
const results=[]; let fails=0;
const ok=(l,c,extra)=>{results.push((c?"OK  ":"FAIL")+" "+l+(extra?("  ["+extra+"]"):"")); if(!c) fails++;};

// ---------- static locks (the wiring must exist; jsdom runtime can't prove wiring cheaply) ----------
const src=fs.readFileSync(path.join(WEB,"app.js"),"utf8");
ok("app.js defines reconcileArray", src.includes("function reconcileArray(box)"));
ok("app.js defines attachChipObserver", src.includes("function attachChipObserver(box)"));
ok("send() reconciles the composer array before reading it", src.includes('reconcileArray($("input"));'));
ok("confirmEdit() reconciles the modal array", src.includes('reconcileArray(m.querySelector("#edit-area"));'));
ok("bind wires observer on the composer", src.includes("attachChipObserver(inp)"));
ok("bind wires observer on the modal", src.includes("attachChipObserver(ea)"));
ok("reconcile drops via a present-set membership test", src.includes("present.has(String(list[k].pid))"));

// ---------- runtime: the authoritative reconcile differential ----------
const inp=doc.getElementById("input");
function makeChip(pid){
  const span=doc.createElement("span");
  span.className="ce-thumb"; span.setAttribute("contenteditable","false");
  span.setAttribute("data-pid",String(pid)); span.setAttribute("tabindex","0");
  span.appendChild(doc.createTextNode(""));
  return span;
}
function reset(){ inp.innerHTML=""; api.setAttachments([]); }

// CORE differential: array HAS the image, DOM has the chip; simulate the browser NATIVELY removing
// the chip from the DOM (array NOT touched -- that is exactly the bug path). reconcile must drop it.
{
  reset();
  const pid=api.nextPid();
  const chip=makeChip(pid);
  inp.appendChild(chip);
  inp.appendChild(doc.createTextNode("hello"));
  api.getAttachments().push({kind:"image",name:"x",pid,url:"data:image/png;base64,AAA"});
  // native browser delete of the atomic chip: node removed, array untouched
  chip.remove();
  ok("pre-reconcile: array still carries the orphan", api.getAttachments().length===1, "len="+api.getAttachments().length);
  api.reconcileArray(inp);
  ok("CORE: reconcileArray drops the orphan (DOM is the visual truth)", api.getAttachments().length===0, "len="+api.getAttachments().length);
}

// reconcile must NOT drop a chip that is still present (no over-delete)
{
  reset();
  const pid=api.nextPid();
  inp.appendChild(makeChip(pid));
  inp.appendChild(doc.createTextNode("keepme"));
  api.getAttachments().push({kind:"image",name:"y",pid,url:"data:image/png;base64,BBB"});
  api.reconcileArray(inp);
  ok("reconcile keeps the present chip's array entry", api.getAttachments().length===1);
  ok("ceText still rebuilds the [img:] anchor for a kept chip", api.ceText(inp).includes("[img:"+pid+"]"));
}

// handler path (方案3 untouched): removeThumb splices BOTH array and DOM in one shot
{
  reset();
  const pid=api.nextPid();
  inp.appendChild(makeChip(pid));
  inp.appendChild(doc.createTextNode("after"));
  api.getAttachments().push({kind:"image",name:"z",pid,url:"data:image/png;base64,CCC"});
  api.removeThumb(pid, inp);
  ok("removeThumb removed DOM", inp.querySelectorAll("[data-pid]").length===0);
  ok("removeThumb spliced array (array is source of truth)", api.getAttachments().length===0);
}

// multi-chip: drop the FIRST chip natively (image-first, text-after scenario), text must survive
{
  reset();
  const pidA=api.nextPid(); const pidB=api.nextPid();
  const cA=makeChip(pidA); inp.appendChild(cA);
  const tail=doc.createTextNode(" trailing words"); inp.appendChild(tail);
  api.getAttachments().push({kind:"image",name:"a",pid:pidA,url:"data:image/png;base64,AAA"});
  api.getAttachments().push({kind:"image",name:"b",pid:pidB,url:"data:image/png;base64,BBB"});
  inp.appendChild(makeChip(pidB));   // pidB must be IN the DOM so it survives the leading-chip delete
  cA.remove();            // native delete of the LEADING chip only
  api.reconcileArray(inp);
  ok("leading chip removed, trailing chip KEPT in DOM", inp.querySelectorAll("[data-pid]").length===1);
  ok("array kept only the surviving chip", api.getAttachments().length===1 && String(api.getAttachments()[0].pid)===String(pidB));
  const ex=api.ceText(inp);
  ok("trailing text SURVIVES extraction", ex.includes("trailing words"));
  ok("kept chip still has its anchor", ex.includes("[img:"+pidB+"]"));
  ok("deleted chip has NO anchor in extraction", !ex.includes("[img:"+pidA+"]"));
}

console.log("\n"+results.join("\n"));
console.log("RECONCILE: "+(fails? "RED - "+fails+" failures" : "ALL GREEN"));
process.exit(fails?1:0);
