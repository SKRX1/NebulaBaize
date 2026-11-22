// [测试锁 2026-11-22] 表单弹窗关闭约定根修：模型管理/新建/编辑三类都复用 #model-modal，
// 它的 .st-modal 是 fixed inset:0 的全视口遮罩，卡片外任意一点都属于 modal 本身，于是旧的
// `onclick = e => if (e.target === modal) close()`「遮罩即关」会让一次误点丢掉正在填的整张表单。
// 约定（以后新建表单弹窗照此）：表单弹窗不用遮罩即关，关闭走显式路径（× / 完成 / 取消）+ Esc，
// 与其它弹窗键盘约定一致。纯查看器（img-modal）/选择器仍可遮罩即关——它们没有"丢数据"风险。
// 纯静态锁：直读 app.js 断言 model-modal 已无遮罩即关、且有 Esc 关闭；decoy 差分证明每条都 load-bearing。
import { readFileSync } from "node:fs";

const js = readFileSync("serve/web/app.js", "utf8");

// 旧 bug 形态（整行）与新的 Esc 关闭（整行）—— 用字面串锁，避免脆弱正则。
const OLD_BACKDROP = 'if (e.target === $("model-modal")) closeModelModal();';
const ESC_CLOSE    = 'if ($("model-modal") && !$("model-modal").hidden && e.key === "Escape") closeModelModal();';

let fail = 0;
const ok = (cond, name) => {
  console.log((cond ? "  OK   " : "  FAIL ") + name);
  if (!cond) fail++;
};

// 1) 旧的「遮罩即关」必须不再存在。
ok(!js.includes(OLD_BACKDROP), "model-modal: no backdrop-click-to-close (e.target === modal) close");

// 2) 必须保留 Esc 关闭（删掉遮罩即关后，键盘党仍能关）。
ok(js.includes(ESC_CLOSE), "model-modal: Esc still closes it (parity with edit-modal/img-modal/sched-modal)");

// --- decoy 差分：证明两条都 load-bearing ---
//  decoy A：把 Esc 改成无关键 -> 第 2 条应转红。
const decoyEsc = js.replace(ESC_CLOSE, ESC_CLOSE.replace('e.key === "Escape"', 'e.key === "Q"'));
ok(decoyEsc !== js, "decoy A: the Escape->Q mutation is visible in the source (lock has something to bite)");
ok(!decoyEsc.includes(ESC_CLOSE), "decoy A control: mutating the Escape key flips lock #2 red");

//  decoy B：把旧遮罩形态塞回去 -> 第 1 条应转红。
const decoyBack = js.replace(ESC_CLOSE, OLD_BACKDROP + "\n  " + ESC_CLOSE);
ok(decoyBack !== js, "decoy B: re-injecting the old backdrop-close is visible in the source");
ok(decoyBack.includes(OLD_BACKDROP), "decoy B control: a re-added backdrop-close flips lock #1 red");

// 3) 范式锚点（不改行为）：img-modal 查看器仍允许遮罩即关——证明本锁只针对「表单弹窗」，
//    不是一刀切禁止所有遮罩关闭（纯查看器丢不了数据）。
ok(js.includes('if (e.target.id === "img-modal") closeImageView();'),
   "viewer parity: img-modal (pure viewer) keeps backdrop-close — the lock targets FORM modals, not all");

console.log(fail ? "\nFORM-MODAL-CLOSE: FAIL (" + fail + ")" : "\nFORM-MODAL-CLOSE: ALL GREEN");
process.exit(fail ? 1 : 0);
