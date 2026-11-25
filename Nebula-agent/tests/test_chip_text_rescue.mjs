/* Differential gate for the "delete-image-keeps-text" fix (A3).
 * THE FIX: when a real-browser caret drops text INSIDE the atomic chip, that text used to be lost
 * because removeThumb removed the whole chip subtree. The fix rescues any direct text node out to
 * the parent BEFORE the node is removed, so deleting the image keeps the user's words.
 *
 * The chip shape mirrors the production DOM after the box-wrapper change: span.ce-thumb[data-pid]
 * > span.ce-thumb__box > (img + button.ce-thumb__x). The rescued text is a text node placed as a
 * DIRECT child of the chip (the caret-dropped position).
 *
 * Run standalone: node tests/test_chip_text_rescue.mjs
 */
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { createRequire } from "module";
const require = createRequire("E:/Nebula/NebulaBaize/");
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
appCode += `\n;globalThis.__api={removeThumb,ceText,getAttachments:()=>attachments,setAttachments:(v)=>{attachments=v},nextPid:()=>attachNextPid()};`;
win.eval(fs.readFileSync(path.join(WEB,"i18n.js"),"utf8"));
win.eval(appCode);
const api=win.__api;
const results=[]; let fails=0;
const ok=(l,c,extra)=>{results.push((c?"OK  ":"FAIL")+" "+l+(extra?("  ["+extra+"]"):"")); if(!c) fails++;};

// static lock: the rescue loop is present in the production source
const src=fs.readFileSync(path.join(WEB,"app.js"),"utf8");
ok("removeThumb rescues caret-dropped text before removing the node", src.includes("rescue caret-dropped text so deleting the image keeps the text"));
ok("chip wraps img+button in a position:relative box (delete pins to the fixed image)", src.includes('box.className = "ce-thumb__box"'));

const inp=doc.getElementById("input");
function makeChipWithText(pid, insideText){
  const span=doc.createElement("span");
  span.className="ce-thumb"; span.setAttribute("contenteditable","false");
  span.setAttribute("data-pid",String(pid)); span.setAttribute("tabindex","0");
  const box=doc.createElement("span"); box.className="ce-thumb__box";
  const img=doc.createElement("img"); img.className="inline-ce-img"; img.src="data:image/png;base64,AAA";
  const btn=doc.createElement("button"); btn.className="ce-thumb__x"; btn.setAttribute("data-delpid",String(pid));
  box.appendChild(img); box.appendChild(btn); span.appendChild(box);
  // caret dropped this text INTO the chip (direct text child of the chip node)
  span.appendChild(doc.createTextNode(insideText));
  return span;
}
function reset(){ inp.innerHTML=""; api.setAttachments([]); }

// CORE differential: chip has caret-dropped text inside; removeThumb deletes the IMAGE (chip node)
// but must RESCUE the text to the parent so it survives in ceText.
{
  reset();
  const pid=api.nextPid();
  const chip=makeChipWithText(pid," my words");
  inp.appendChild(chip);
  api.getAttachments().push({kind:"image",name:"x",pid,url:"data:image/png;base64,AAA"});
  api.removeThumb(pid, inp);
  ok("chip node removed from DOM", inp.querySelectorAll("[data-pid]").length===0);
  ok("array spliced (array is source of truth)", api.getAttachments().length===0);
  ok("rescued text SURVIVES in the parent after the image is deleted", inp.textContent.includes("my words"));
  ok("ceText still contains the rescued words", api.ceText(inp).includes("my words"));
  ok("deleted chip left NO anchor in ceText", !api.ceText(inp).includes("[img:"+pid+"]"));
}

// control: a chip with NO inside text -- delete removes only the image, surrounding normal text intact
{
  reset();
  const pid=api.nextPid();
  inp.appendChild(doc.createTextNode("before "));
  const chip=makeChipWithText(pid,"");   // no caret-dropped text
  inp.appendChild(chip);
  inp.appendChild(doc.createTextNode(" after"));
  api.getAttachments().push({kind:"image",name:"y",pid,url:"data:image/png;base64,BBB"});
  api.removeThumb(pid, inp);
  const ex=api.ceText(inp);
  ok("control: leading text intact", ex.includes("before"));
  ok("control: trailing text intact", ex.includes("after"));
  ok("control: deleted chip has no anchor", !ex.includes("[img:"+pid+"]"));
}

console.log("\n"+results.join("\n"));
console.log("CHIP-TEXT-RESCUE: "+(fails? "RED - "+fails+" failures" : "ALL GREEN"));
process.exit(fails?1:0);
