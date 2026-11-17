// 最小可测单元：原样搬入 app.js 真实 mountArchiveCard + 依赖桩，跑探针钉死「卡片是否插到气泡顶部」。
window.__esc = function(s){ return String(s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); };
function esc(s){ return window.__esc(s); }
function icon(){ return "<svg></svg>"; }
const t = (k)=>"["+k+"]";
function activeSession(){ return { workspace: "E:/Nebula/NebulaBaize" }; }
window.__lastPath="none";
async function fsRead(p){ window.__lastPath=p; return "READBACK_BODY_OK"; }
function _arcIO(){ return null; }
function autoExpandCard(card){ var body=card&&card.querySelector(".arc-hist__body"); if(!body)return; body.hidden=false; }
async function loadArchiveSeg(card){ var body=card&&card.querySelector(".arc-hist__body"); if(!body)return; if(body.dataset.loaded)return; body.dataset.loaded="loading"; body.hidden=false; body.textContent=t("drawer.archive.loading"); var ws=activeSession()?activeSession().workspace.replace(/\/$/,""):""; var path=(ws?ws+"/":"")+".Nebula-archive/"+card.dataset.aid+".md"; var res=await fsRead(path); body.textContent=res||t("drawer.archive.unloaded"); body.dataset.loaded="1"; }

function mountArchiveCard(el, m) {
  if (!el.classList.contains("st-msg--system")) return;
  var hay = (m && (m.text || m.content)) || "";
  var mm = hay.match(/\.Nebula-archive\/([A-Za-z0-9_]+)\.md/);
  if (!mm) return;
  var bubble = el.querySelector(".st-bubble"); if (!bubble) return;
  if (bubble.querySelector(".arc-hist")) return;
  var card = document.createElement("div");
  card.className = "arc-hist"; card.dataset.aid = mm[1];
  card.innerHTML = `<button class="arc-hist__head"><span>x</span></button><div class="arc-hist__note">n</div><pre class="arc-hist__body" hidden></pre>`;
  var firstKid = bubble.firstChild;
  if (firstKid) bubble.insertBefore(card, firstKid);
  else bubble.appendChild(card);
  var io = _arcIO(); if (io) io.observe(card);
  loadArchiveSeg(card);
}

var el = document.createElement("div"); el.className="st-msg st-msg--system";
var bubble = document.createElement("div"); bubble.className="st-bubble";
bubble.innerHTML="<p>正文</p>";
el.appendChild(bubble); document.body.appendChild(el);
var m = { role:"system", content:"前文已压缩\n\n[archived verbatim: in .Nebula-archive/ar_testcard01.md]" };
mountArchiveCard(el, m);
window.__done = true;
