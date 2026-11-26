/* [确认框迁移 2026-11-26] 共享测试 helper：替代旧的 `win.confirm = () => true` 桩。
   迁移到 askConfirm 后，确认框不再由原生 confirm 提供，而是 askConfirm 往 body 追加一个
   .st-modal DOM 框；stub confirm 不会再被调用、也不会 resolve。于是各 jsdom 测试要改成：
   触发那个会弹框的动作 -> 等一帧 -> 点 .st-modal 里的确定/取消按钮 -> 再等一帧（让 await 续跑）。

   用法：
     import { clickConfirm, rejectConfirm, waitForConfirmBox, tick, stubTrue, stubFalse } from "./_ask_confirm_helper.mjs";
     triggerSomeDelete();            // 触发会弹确认框的动作（deleteMessage / deleteSpark / ...）
     await clickConfirm(win);        // 点最近一个可见确认框的「确定」(primary) -> await 续跑
     // 或 await rejectConfirm(win) // 点「取消」(ghost)
     // 或 const box = await waitForConfirmBox(win); box.querySelector('[data-testid=...]').checked=false; await clickConfirm(win);

   若某测试只是 boot 不触发删除（stub 仅为保险），可保留 `win.confirm = () => true`；
   也可用 stubTrue(win)/stubFalse(win) 显式声明意图（迁移过渡期原生 confirm 不再是确认主路，
   但个别测试仍在 await 链外调它，留着无害）。
*/
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

export function lastConfirmBox(win) {
  const all = [...win.document.querySelectorAll(".st-modal")];
  // askConfirm 的框调用时即时 append 且不 hidden；app 自带 modal 是预置带 hidden 的，跳过它们
  const visible = all.filter((m) => !m.hasAttribute("hidden"));
  return visible.length ? visible[visible.length - 1] : null;
}

export function buttonsOf(box) {
  return box ? [...box.querySelectorAll("button")] : [];
}

function press(box, cls) {
  const b = buttonsOf(box).find((x) => x.className.includes(cls));
  if (!b) throw new Error("no button with class " + cls + " in the confirm box");
  b.click();
}

export async function waitForConfirmBox(win, ms = 40) {
  await tick(ms);
  return lastConfirmBox(win);
}

// 点最近一个确认框的「确定」(primary)，返回被点的框（可继续断言）；无框返回 null
export async function clickConfirm(win, ms = 40) {
  const box = await waitForConfirmBox(win, ms);
  if (!box) return null;
  press(box, "st-btn--primary");   // OK
  await tick(ms);
  return box;
}

// 点「取消」(ghost)
export async function rejectConfirm(win, ms = 40) {
  const box = await waitForConfirmBox(win, ms);
  if (!box) return null;
  press(box, "st-btn--ghost");     // Cancel
  await tick(ms);
  return box;
}

// 过渡期语义声明：显式把原生 confirm 置 true/false（部分迁移测试仍会在 await 链外调它）
export function stubTrue(win) { win.confirm = () => true; }
export function stubFalse(win) { win.confirm = () => false; }

export { tick };
