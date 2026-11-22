// [测试锁 2026-11-23] 内置组名显示层映射契约：组名(如内置 "frontend")在用户可见的 UI 文本里
// 必须经 groupDisplayName() 渲染（中文显「前端」），而 value / 目录名 / group.txt / 自动探测仍是
// 真实英文 id。两处下拉(归组弹窗 group-groupsel + 新建工作区 ws-group)的 option 文本、"当前分组"行、
// group 卡摘要——凡把组名当展示文本输出，都得走映射；漏用就会回退成"界面里孤零零英文"(用户报告)。
// 纯静态锁：直读源文件断言关键调用在位；decoy 差分证明每条断言 load-bearing(去掉映射即红)。
import { readFileSync } from "node:fs";

const js = readFileSync("serve/web/app.js", "utf8");
const html = readFileSync("serve/web/index.html", "utf8");

let fail = 0;
const ok = (cond, name) => {
  console.log((cond ? "  OK   " : "  FAIL ") + name);
  if (!cond) fail++;
};

// 1) 映射器在位，且只对内置 "frontend" 走 i18n 显示名、其余组名(用户自建)原样返回。
ok(js.includes("function groupDisplayName(g)"), "mapper groupDisplayName() is defined");
ok(js.includes('if (g === "frontend") return t("group.name.frontend")'),
   "mapper: only the built-in frontend routes to i18n group.name.frontend");

// 2) 下拉 option：value 仍是真实组名 esc(g)，但可见文本必须经 groupDisplayName —— 数据层不动、只汉化显示。
ok(js.includes('value="${esc(g)}">${esc(groupDisplayName(g))}</option>'),
   "option value stays esc(g) (real id) while the DISPLAY text is groupDisplayName(g)");

// 3) "当前分组：X" 行、group 卡摘要：展示文本都经映射。
ok(js.includes('t("mem.auto.group.of", {g: groupDisplayName(eff)})'),
   "current-group label renders the group through groupDisplayName");
ok(js.includes('sum.textContent = groupDisplayName(currentGroup)'),
   "group card summary renders the group through groupDisplayName");

// 4) 负向锁：旧的"option 文本也直出真实名"形状必须不存在(那是本次修掉的漏用)。
ok(!js.includes('${esc(g)}">${esc(g)}</option>'),
   "no dropdown option still echoes the raw group name as its visible text");

// 5) 任务1 防回退：ws-modal 分组框必须是真正的 <select>(框内全程中文)，不得退回 text+datalist。
ok(/<select[^>]*id="ws-group"/.test(html), "ws-modal group field is a real <select>");
ok(!html.includes('<datalist id="ws-group-list">') && !html.includes('list="ws-group-list"'),
   "ws-modal no longer uses a datalist input (no English echo in the field)");

// --- decoy 差分：逐条剥掉映射包裹，对应锁必须翻红(证 load-bearing) ---
const stripOption = js.replace('esc(groupDisplayName(g))', "esc(g)");
ok(!stripOption.includes('value="${esc(g)}">${esc(groupDisplayName(g))}</option>'),
   "decoy: unwrapping the option display text flips lock #2 red");
const stripCur = js.replace("{g: groupDisplayName(eff)}", "{g: eff}");
ok(!stripCur.includes('t("mem.auto.group.of", {g: groupDisplayName(eff)})'),
   "decoy: unwrapping the current-group label flips lock #3 red");
const stripSum = js.replace("groupDisplayName(currentGroup)", "currentGroup");
ok(!stripSum.includes("sum.textContent = groupDisplayName(currentGroup)"),
   "decoy: unwrapping the group-card summary flips lock #4 red");

console.log(fail ? "\nGROUP NAME DISPLAY LOCK: FAIL (" + fail + ")" : "\nGROUP NAME DISPLAY LOCK: ALL GREEN");
process.exit(fail ? 1 : 0);
