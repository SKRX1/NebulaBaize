# 编辑弹窗增强 · 三件一起（design 文档，待审阅）

> 状态：**仅供审阅，未动代码**。审阅通过后再按下方改动清单逐锚点落地 + 差分测试 + 部署。
> 原则：全部复用现有 composer 通道（paste / addFiles / insertPlaceholder / mixedSegments / autosize / undoStack），新增仅限「作用域参数化 + 弹窗内一份独立编辑期附件」，不另造第二套机制。

---

## 0. 现状事实（已逐行核实）

| 能力 | 现状 | 出处（app.js） |
|---|---|---|
| 编辑弹窗 `#edit-modal` | 卡片 `max-width:620px`；textarea `#edit-area` 固定 `min-height:96px; resize:vertical`，**无 autosize** | 6788 / 6814 |
| autosize | 仅绑底部 `#input`（随内容长到 ~40% 屏高） | 6746-6747 |
| 粘贴图片 | paste handler **硬绑 `$("input")`** → `addFiles(files,{cursor:true})` | 7208 |
| addFiles | 图片走 FileReader→dataURL，push 全局 `attachments`，`opts.cursor` 时 `insertPlaceholder(pid)` | 7094-7123 |
| insertPlaceholder / removePlaceholder | **硬写 `$("input")`**，在光标插/删 ` [img:pid] ` | 7052 / 7064 |
| 图文混排 | `mixedSegments(m)` 按 `[img:N]` 拆 text/image 段，发送与渲染共用 | 7073，调用点 2008/2019/4005 |
| 附件状态 | 全局 `attachments` 数组（底部输入框专用） | 1074 |
| 编辑落库 | `editResend` 仅 `{...messages[i], text:newText}`，**不带 images** | 6891 |
| undo | 仅 **软删除** 写 `undoStack`；hard 置 null；branch 天然可逆（切换器切回） | 6885-6889 / 6898 |

**根因**：编辑弹窗和底部 composer 是两套 textarea；底部那套「粘贴图＋图文混排＋自适应高度」全绑死在 `$("input")`/全局 `attachments` 上，所以弹窗又小又不能贴图。

---

## 维度 1 · 弹窗放大 + 编辑区 autosize

| # | 改动点 | 方式 |
|---|---|---|
| 1.1 | `#edit-modal .st-modal__card{max-width:620px}` → 约 `880px`（与底部 composer 观感对齐；窄屏 media query 回落 100%） | CSS 字符串（6788）锚点改 |
| 1.2 | `#edit-area` 的 `min-height:96px` → `160px`；给它接 autosize（随内容长高，封顶同底部 ~40% 屏高） | 新增 `autosizeEdit()`（复用 autosize 逻辑，目标改 `#edit-area`），在 `#edit-area` 上 `addEventListener("input", autosizeEdit)` |

> 1.2 不复用同名 autosize 直绑，是因为它写死 `$("input")`；抽成「autosize(el)」或新建弹窗专用版，二选一，落地时按最小改动定。

## 维度 2 · 弹窗内粘贴图片 + 文字间插入（核心）

| # | 改动点 | 方式 |
|---|---|---|
| 2.1 | 新增弹窗期独立附件数组 `editAttachments`（**不与底部全局 `attachments` 混用**，防互相污染） | 新增 let（紧邻 1074 区） |
| 2.2 | 把 7208 的 paste handler **抽成可复用函数** `handlePasteImage(e, targetTextarea, onAdd)`；底部 `#input` 与弹窗 `#edit-area` 各自绑定，分别传自己的附件容器 | 抽函数 |
| 2.3 | `addFiles` 增 `target` 参数（默认 `#input`+全局 `attachments`）；`insertPlaceholder`/`removePlaceholder` 增 `target` 参数（默认 `$("input")`）。弹窗调用时传 `#edit-area`+`editAttachments` | 作用域参数化（向后兼容：默认值保持旧行为，不破现有测试） |
| 2.4 | 弹窗 body 内 textarea 下加一个**编辑期缩略图区**（复用 `renderAttachments` 样式/CSS，渲染 `editAttachments`）；`openEditModal` 时若消息已有 `images` 回填进 `editAttachments` 并保留文本里的 `[img:N]` | 新增渲染 + 回填 |
| 2.5 | `confirmEdit`/`editResend`：`newText` 若含 `[img:N]`，落库消息带上 `editAttachments`（`{...messages[i], text:newText, images:editAttachments}`）；发送渲染自动走现成 `mixedSegments` | 改 6891 落库行 |

> 复用边界：`mixedSegments` 已是「读 message.images + 文本占位符」的通用通道，**无需改**；只要 2.5 把 images 落到 message 上，渲染端免费获得图文混排。

## 维度 3 · 策略可视化 + 选错可反悔

| # | 改动点 | 方式 |
|---|---|---|
| 3.1 | 发送按钮区加一行**实时回显当前所选策略**（点三卡时 helper 文本跟随「将执行：软删除/真删除/分支保留」），消除「按了才发现选错」 | 新增 helper 文本，复用现有 i18n 键 |
| 3.2 | 把 **真删除** 也接入 undo：6888 的 `undoStack = null` 改为与软删除一样写 undoStack（hard 也能撤销） | 改 6888 |
| 3.3 | **分支保留** 保持现状（天然可逆：旧历史进切换器），仅靠 3.1 回显说明「可切回」，不重复加 undo | 不改逻辑 |

> 3.2 让「选错能撤销/重加」对三种策略一致成立；undo 文案与颜色沿用现有 `toast.undo`/undoStack 语义，不新建机制。

---

## 测试计划（落地后跑，本文档先约定）

- **维度1**：静态锁 `max-width` 实际值 + autosizeEdit 绑定点存在（CSS/接线，jsdom 读 computed 不易，用静态锚点 + 运行时存在性双锁）。
- **维度2（核心）**：jsdom 差分——在 `#edit-area` 粘贴图片 → 断言①占位符出现在 textarea ②`editAttachments` 非空 ③发送后 `message.images` 带上、`mixedSegments(message)` 能拆出 image 段；对照组：底部 `#input` 旧行为不破（默认参数路径回归）。
- **维度3（反悔）**：差分双探针——hard 策略下「发送→undo 可恢复」与现状 null 对比必须从「不可撤销」翻成「可撤销」；软删除既有 undo 不破。
- 新增 i18n 键须中英成对（键数对账测试自动覆盖）。

## 落地流程（审阅通过后）

1. 锚点编辑 app.js（含中文锚点从磁盘读真实字节，命中数≠1 即报错；写回 CRLF，先 `git ls-files --eol` 查行尾）。
2. i18n 新键中英成对补齐。
3. `node --check` 语法 + jsdom 运行时验证（**不只看语法绿**——本项目踩过「调用未定义函数语法合法」的坑）。
4. 跑全套 run_tests.py 全绿。
5. cp+逐文件 MD5 部署到 Strata-main 寄生副本（中文路径禁用 robocopy 直调）。

## 诚实标注

- 维度1 端到端像素、维度2/3 的「模型看图/真实撤销」端到端属算力不经济，靠 jsdom 契约测试 + 静态锁坐实机制；像素观感落地后另截图佐证。
- 2.3 的「参数化默认值保持旧行为」必须带回归用例，否则底部 composer 现有粘贴/drop 链路是未测盲区。
