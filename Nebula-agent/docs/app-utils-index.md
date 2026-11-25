# app_utils.js 符号索引 · 42 符号 / 14 族

**简体中文** | [English](app-utils-index.en.md)

`serve/web/app_utils.js` 是从 `app.js` 续抽链摘出的**共享纯函数**集合（classic script，
在 `app.js` 之前加载，顶层函数声明落全局，故 app.js 调用点原名不改）。导出集的唯一真相源是
`tests/test_app_utils_contract.mjs` 的 `EXPORTS`。本文件按族登记每个符号的用途，便于日后定位复用。

> **复用前先确认它真能复用**：这里每个函数都只触碰标准全局（Date/Number/String/RegExp）或
> app_utils 内其它成员，不引用 app.js 的顶层可变 state（messages/settings/…）或 DOM。若你的
> 场景需要 DOM/state，应留在 app.js，不要硬搬进 app_utils。

| 族 | 用途（一句话） | 符号 |
|---|---|---|
| **F1 格式化** | 时间戳与字节数的可读化（binary 单位、1 位小数） | `timeStr`, `fmtBytesSel` |
| **F2 计划解析** | 把 markdown 计划文本（`- [x]`/`* [ ]` 清单）解析成 `{done,label}` 列表 | `parsePlanItems` |
| **F3 建议/下一步抽取** | 从回复正文抽取 next-steps 块、proposal 决策卡，并检测回复主体语言 | `extractNextSteps`, `extractProposalsFromText`, `detectLang` |
| **F4 路径/范围** | 取工具参数首个路径、按段拆绝对路径前缀、范围上/下钻，及深拷贝 | `firstPath`, `splitPath`, `nextScopeUp`, `nextScopeDown`, `clone` |
| **F5 工具分类** | 把一次工具结果归类为文件写/测试等（供徽标与审计着色） | `classifyTool` |
| **F6 问题箱聚合** | 问题箱条目的签名键、统计与分组 | `bugBoxSigKey`, `bugBoxStats`, `bugBoxGroups` |
| **F7 思考预处理** | 抽思考一行预览（跳过代码围栏）与去重思考片段 | `thinkPeek`, `dedupeThink` |
| **F8 杂项助手** | 配置值读取、安全截断、任务排序、随机种子挑选 | `configValue`, `safeCut`, `taskOrder`, `pickSeed` |
| **F9 流式记账** | 快照已发、工具序号、流式阶段标注 | `snapSent`, `toolSeq`, `noteStreamPhase` |
| **F10 流式气泡装配** | 把流式记录装配成气泡、计算耗时瀑布 | `assembleStreamBubbles`, `computeWaterfall` |
| **F11 在飞工具/任务** | 由工具推导 Nebula 任务、取当前在飞工具名 | `nebTaskFromTool`, `inflightToolName` |
| **F12 markdown 渲染** | 按 URL 判媒体类型、生成图片标签、渲染 proposal（配套 `MD_EXT_*` 扩展名集合） | `mdKindOf`, `mdImageTag`, `proposalMarkdown` |
| **F13 标识符归一** | 设计文件名/安全组名/端点键/标签归一、工具结果转文本 | `designFileName`, `safeGroup`, `endpointKey`, `normalizeTags`, `toolResultText` |
| **F14 记忆文本度量** | 估算 token 数与条目数（记忆卡摘要/阈值判定用） | `_memEstTokens`, `_memEntryCount` |
| **压缩（未编族）** | 组装待发上下文数组、渲染单条用于压缩 | `buildCtxArr`, `renderMsgForCompact` |
| **spark（未编族）** | 判断 spark 是否已执行、按时间比较排序 | `sparkIsExecuted`, `sparkTimeCompare` |

## 抽离纪律（为什么这些能安全外置）

- **AST out-deps = 0**：续抽前用扫描器核实每个函数引用的「模块全局名」全是 stdlib / app_utils 内成员 /
  自身参数，**不引用任何 app.js 顶层可变 state 或 DOM**——引用 DOM 全局即判非纯，不得外抽。
- **byte-for-byte 等价迁移**：从 app.js 逐字节搬出、不改写函数体。
- **每个族配契约锁**：`tests/test_app_utils_contract.mjs` 锁导出集；`tests/test_app_utils_jsdom.mjs` 喂真实输入做运行时实测。
- **异族不成族**：纯但异主题的函数不硬凑一族（如 RAM 告警 vs 采样校验）。

## 现状

续抽链已收官：加严扫描 app.js 全部 435 个顶层函数，剩余「纯」候选全是 1–24 行零碎单函数、无一成族，
候选池已枯竭。**42 符号 / 14 族**是当前稳定天花板，回滚点 `v-baseline-2026-11-26-c`。新增纯函数时若
确无 DOM/state 依赖、且与某族主题一致，可续入并同步更新本索引与 `EXPORTS` 契约锁。
