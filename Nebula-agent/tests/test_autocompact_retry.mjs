// Auto-compact cooldown re-check + short-chat exemption (behaviour pinned in isolation,
// real timers, no jsdom). Guards the 2026-10 fix: a threshold crossed inside the cooldown
// must arm exactly one re-check; below the threshold or while disabled must arm nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const src = readFileSync(join(WEB, "app.js"), "utf8");

// Pull the functions this test owns, verbatim from app.js.
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "OK  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  cond ? pass++ : fail++;
};
const t = (k, a) => k.replace(/\{\w+\}/g, () => (a && Object.values(a)[0] != null ? String(Object.values(a)[0]) : ""));

// One shared scope so cross-call state (cooldown, timer, compacted) persists like in app.js.
const S = new Function("t", `
  let settings = { autocompact: true, compactPct: 0 };
  let maxCtx = 0, lastPromptTokens = 0, messages = [], busy = null, pendingCompact = false;
  let autoCompactCooldown = 0, autoCompactRetryTimer = null;
  let compacted = 0;
  const nativeWindow = () => 128000;
  function compactConversation(auto){ compacted++; pendingCompact = auto ? "auto" : "manual"; autoCompactCooldown = Date.now() + 120000; }
  ${grab("autoCompactThreshold")}
  ${grab("autoCompactBlockReason")}
  ${grab("maybeAutoCompact")}
  return { setSettings:(o)=>{settings=Object.assign({},settings,o)}, setMaxCtx:(v)=>{maxCtx=v},
    setLPT:(v)=>{lastPromptTokens=v}, setMessages:(v)=>{messages=v}, setBusy:(v)=>{busy=v},
    setPending:(v)=>{pendingCompact=v}, setCooldown:(v)=>{autoCompactCooldown=v},
    getTimer:()=>autoCompactRetryTimer, clearTimer:()=>{clearTimeout(autoCompactRetryTimer); autoCompactRetryTimer=null;},
    threshold:()=>autoCompactThreshold(), blockReason:()=>autoCompactBlockReason(),
    getCompacted:()=>compacted, getPendingCompact:()=>pendingCompact, run:()=>maybeAutoCompact(), t };
`)(t);

console.log("=== auto-compact cooldown re-check (behaviour) ===");

// Baseline contract (unchanged): 32K window, 128K native fallback -> adaptive threshold 75%.
S.setMaxCtx(32768);
check("adaptive threshold stays 75% on a 32K window", S.threshold() === 75);

// Baseline trigger still works: idle, enabled, big chat, threshold crossed -> compact now.
S.setLPT(30000); S.setMessages(Array(8).fill({ role: "user" })); S.setBusy(null); S.setPending(false); S.setCooldown(0);
S.run();
check("plain threshold crossing still triggers at once", S.getCompacted() === 1 && S.getPendingCompact() === "auto");

// Cooldown armed by that trigger: a NEW crossing while cooldown runs must arm a re-check, not compact.
S.setPending(false);
check("block reason names the cooldown (checked before arming)", /block\.cooldown/.test(S.blockReason() || ""));
S.run();
check("cooldown + threshold crossed arms a one-shot re-check", S.getTimer() != null);
check("arming does NOT compact immediately", S.getCompacted() === 1);

// Cooldown active + below threshold -> arm nothing.
S.clearTimer(); S.setLPT(5000); S.run();
check("cooldown + below threshold arms nothing", S.getTimer() == null);

// Disabled -> arm nothing even past threshold.
S.clearTimer(); S.setLPT(30000); S.setCooldown(Date.now() + 60000); S.setSettings({ autocompact: false }); S.run();
check("disabled arms nothing", S.getTimer() == null);
S.setSettings({ autocompact: true });

// The armed re-check FIRES when the cooldown expires (short cooldown, real timers).
S.clearTimer(); S.setPending(false); S.setLPT(30000); S.setCooldown(Date.now() + 30);
const beforeFire = S.getCompacted();
S.run();
check("re-arm armed a timer for the firing test", S.getTimer() != null);
await new Promise((r) => setTimeout(r, 150));
check("re-check fires after the cooldown and compacts", S.getCompacted() === beforeFire + 1);
check("the fired path records pendingCompact=auto", S.getPendingCompact() === "auto");

// Short-chat exemption: 4 messages at >= 95% occupancy -> fires (new); 88% -> stays whole (old contract kept).
S.clearTimer(); S.setPending(false); S.setCooldown(0); S.setMessages(Array(4).fill({ role: "user" }));
S.setLPT(31500);   // 96.5% of 32768
S.run();
check("short chat + genuinely full window fires (exemption)", S.getCompacted() === beforeFire + 2);
const beforeQuiet = S.getCompacted();
S.setPending(false); S.setLPT(28800);   // 87.9%: above the 75% threshold, below the 95% exemption line
S.run();
check("short chat above threshold but below exemption stays whole", S.getCompacted() === beforeQuiet);

// Idempotence: second crossed-threshold call while a re-check is armed adds no second timer.
S.clearTimer(); S.setCooldown(Date.now() + 120000); S.setLPT(30000); S.setMessages(Array(8).fill({ role: "user" }));
S.run();
const first = S.getTimer();
S.run();
check("re-arm is idempotent (same single timer)", first != null && S.getTimer() === first);
S.clearTimer();

// Busy guard unchanged: even past threshold, while busy arm nothing.
S.clearTimer(); S.setBusy({ controller: null, msg: {} }); S.setCooldown(Date.now() + 120000); S.setLPT(30000);
S.run();
check("busy never arms (old contract kept)", S.getTimer() == null);
S.setBusy(null);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
