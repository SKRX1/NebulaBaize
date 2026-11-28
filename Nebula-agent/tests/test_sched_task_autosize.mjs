/* [sched-task autosize 2026-11-30] the schedule modal "task" field used to be a
single-line <input type="text"> that could not hold a multi-line command (the user
could not even see/scroll what they typed). It is now a <textarea> that GROWS with
its content up to a 40vh ceiling then scrolls internally -- exactly the composer /
edit-modal autosize experience. Anti-drift, pure static (no jsdom/CSS needed):

  S1 index.html: #sched-task is a <textarea ... rows> (NOT an input[type=text]).
  S2 app.css:    #sched-task carries an internal scroll window (min-height +
                 max-height:40vh + overflow-y:auto + an overflow-x pin).
  S3 app.js:     #sched-task is bound to autosize() on "input" AND "compositionend"
                 (CJK IME-confirm does not always fire a plain "input" -- a known gap).
  S4 app.js:     openSchedModal calls autosize($("sched-task")) after filling e.task,
                 so a LONG pre-existing task grows to fit on OPEN, not only as you type.

  LOAD-BEARING decoys (proving each lock bites):
  D1 strip the compositionend binding -> S3 flips red (a CJK user's text would not autosize).
  D2 revert the textarea to an input[type=text] -> S1 flips red (single line, unscrollable).
  D3 strip overflow-y:auto from the #sched-task rule -> S2 flips red (overflow paints below card).

Run standalone: node tests/test_sched_task_autosize.mjs
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

// Normalize each file to LF so needles ending in \n never false-red on a CRLF file
// (app.css/index.html are CRLF; app.js is LF -- the readFileSync(...).replace guard
// is required by the codebase convention for these CRLF-vs-needle asserts).
const readLF = (n) => fs.readFileSync(path.join(WEB, n), "utf8").replace(/\r\n/g, "\n");
const html = readLF("index.html");
const css  = readLF("app.css");
const app  = readLF("app.js");

// ---- S1 index.html: #sched-task is a growing textarea, not a single-line input ----
const isTextarea = /<textarea[^>]*id="sched-task"/.test(html);
const notTextInput = !/<input[^>]*id="sched-task"[^>]*type="text"/.test(html);
check("S1 #sched-task is a <textarea>", isTextarea);
check("S1 #sched-task is NOT an input[type=text]", notTextInput);
check("S1 textarea carries the st-textarea class + rows",
  /<textarea class="st-input st-textarea" id="sched-task" rows="\d+"/.test(html));
// i18n placeholder wiring survives the tag swap (key unchanged -> i18n parity holds)
check("S1 textarea keeps data-i18n-attr placeholder:sched.task.ph",
  /id="sched-task"[\s\S]*?data-i18n-attr="placeholder:sched\.task\.ph"/.test(html));

// ---- S2 app.css: #sched-task has an internal scroll window ----
const cssBlock = css.match(/#sched-task \{[^}]*\}/);
check("S2 #sched-task css rule exists", !!cssBlock);
if (cssBlock) {
  check("S2 rule: min-height floor", /min-height:\s*72px/.test(cssBlock[0]));
  check("S2 rule: max-height 40vh ceiling (mirrors composer autosize cap)",
    /max-height:\s*40vh/.test(cssBlock[0]));
  check("S2 rule: overflow-y:auto scrolls internally", /overflow-y:\s*auto/.test(cssBlock[0]));
  check("S2 rule: overflow-x pinned (no stray horizontal bar)",
    /overflow-x:\s*hidden/.test(cssBlock[0]));
}

// ---- S3 app.js: autosize bound on input + compositionend ----
const bindInput = app.includes('_stSched.addEventListener("input", () => autosize(_stSched));');
const bindIME   = app.includes('_stSched.addEventListener("compositionend", () => autosize(_stSched));');
check('S3 #sched-task autosize on "input"', bindInput);
check('S3 #sched-task autosize on "compositionend" (CJK IME)', bindIME);

// ---- S4 app.js: openSchedModal pre-grows a long pre-existing task ----
check('S4 openSchedModal calls autosize($("sched-task")) after filling e.task',
  /value = e\.task \|\| "";\n\s*autosize\(\$\("sched-task"\)\);/.test(app));

// ---- LOAD-BEARING decoys (strip -> matching lock must flip red) ----
// D1: remove the compositionend binding from app.js text; S3's IME lock should now fail.
const appNoIME = app.replace(/_stSched\.addEventListener\("compositionend", \(\) => autosize\(_stSched\)\);\n/, "");
check("D1-decoy: strip compositionend -> IME lock would flip red (load-bearing)",
  appNoIME !== app && !_stSchedIME(appNoIME));
function _stSchedIME(s) { return s.includes('_stSched.addEventListener("compositionend", () => autosize(_stSched));'); }

// D2: revert textarea back to a single-line input; S1 textarea lock should flip red.
const htmlAsInput = html.replace(/<textarea([^>]*)id="sched-task"[^>]*data-i18n-attr="placeholder:sched\.task\.ph"><\/textarea>/,
  '<input$1id="sched-task" type="text" data-i18n-attr="placeholder:sched.task.ph">');
check("D2-decoy: revert to input[type=text] -> textarea lock would flip red (load-bearing)",
  htmlAsInput !== html && !/<textarea[^>]*id="sched-task"/.test(htmlAsInput));

// D3: strip overflow-y:auto from the css rule; S2 scroll lock should flip red.
const cssNoScroll = css.replace(/(#sched-task \{[^}]*?)overflow-y:\s*auto;[^}]*\}/, "$1}");
const cssNoScrollBlock = cssNoScroll.match(/#sched-task \{[^}]*\}/);
check("D3-decoy: strip overflow-y:auto -> scroll lock would flip red (load-bearing)",
  cssNoScroll !== css && cssNoScrollBlock && !/overflow-y:\s*auto/.test(cssNoScrollBlock[0]));

console.log(FAILURES.length ? "\n" + FAILURES.length + " FAILURE(S)" : "\nSCHED-TASK-AUTOSIZE GATE: ALL GREEN");
process.exit(FAILURES.length ? 1 : 0);
