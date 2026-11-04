# Strata 设计记录（DESIGN.md）

> 本文件固化关键架构决策。每条含：背景 / 决策 / 实测依据 / 代价 / 锁（防退化的常驻门禁）。
> 所有数字均为工具实测得出，非估算。
>
> **章节映射**：代码注释引用的「§5（缓存字节稳定前缀）」即本文
> **§1 上下文压缩：「省空间 vs 保质量」靠可恢复归档调和** 中
> 「append-only 冻结区保缓存热」那段——session.py 的两处 `DESIGN.md §5` 引用指向 §1。

---

## §1 上下文压缩：「省空间 vs 保质量」靠可恢复归档调和

**日期**：2026-10-22　**状态**：已落地（默认开）

### 背景
长对话的占用里，约 79% 是冻结区历史（append-only），其中大量是早已失效的
中间步骤、被推翻的决策、纯过程叙述（"死水"）。旧压缩算法是
**「摘要 + 销毁原文」**——原文销毁后不可逆，省了窗口但永久丢了内容。

实测钉死的硬矛盾：
- 冻结区平时 append-only 才能保缓存热（实测缓存命中 99.7% ≈ 0.2s/轮）；
- 一旦删改冻结区内容 → 字节前缀变 → 破缓存 → 慢 77 倍（实测 0.2s → 15s）。

即：**省空间 与 保缓存热，在「销毁式压缩」下数学互斥。**

### 决策
把压缩从「摘要 + 销毁」改为「摘要 + **可恢复归档**」：
1. 被折叠的旧历史**不销毁**，写入工作区 `.strata-archive/<id>.md`（零损失）；
2. 窗口里只留「精炼摘要 + 一行搜索指针」；
3. 模型真需要时通过 `filesystem__read` 按指针读回原文（多一次 1-2s 往返）；
4. **白名单硬规则**：当前任务状态 + 最近 N 条决策/操作约定**永不归档**、强制常驻。

这样「移出窗口（省空间）」和「内容不丢（保质量）」不再互斥——归档是周期性的
（攒一批移一次，付一次缓存税，之后重新热），即「周期重铸」的摊销成本。

### 实测依据（隔离桩 + 常驻门禁，工具实测）
| 项 | 实测结果 | 方法 |
|---|---|---|
| 归档可恢复性 | 写盘→读回 **byte-for-byte 一致** | 真函数往返（`_archive_gate` HARD1）|
| 折叠区省量 | 省 **94%/段**（桩：3169→165 字符）| 真函数 + scratch 文件夹 |
| 决策存活率 | 关键词 **1/4** → 语义 **3/4** | LLM 摘要器 vs 关键词，2次run稳定 |
| 召回往返 | ~1-2s（桩内磁盘直读0s）| 模型多一次工具往返 |

### 两个相互独立、可叠加的杠杆
- **语义摘要器（切 llm）**：唯一能撼动 79% 大头的杠杆，且实测省空间不打折、
  决策存活率还回升。落点 `gateway.py`（默认 structured 不变，仅 config
  `strategy=llm` 时激活）。**实测占用 45.8% → 约32%。**
- **可恢复归档（默认开）**：让"移出窗口的内容仍可零损失读回"。落点前端
  `app.js` finalize 块（压缩收尾重建 messages 之前插入）。

### 代价（诚实记录）
- 归档出去的内容**默认看不见**，需模型主动搜索才捞回 → 所以白名单是安全带，不能省。
- 恢复需多一次搜索往返（~1-2s）。
- 语义摘要器判准非 100%（实测 3/4，漏 1 条），靠白名单硬规则兜底"绝不能忘的"。
- 重铸那一轮付一次缓存税（实测单次 +15s），靠"每N轮摊销一次"摊薄。

### 锁（防退化的常驻门禁，均已并入 run_tests）
- `tools/_semantic_summarizer_gate.py`：硬锁「语义摘要存活率 ≥ 关键词存活率」
  （锁本次改进契约）；绝对存活率作软警告（小模型单次波动，符合"硬锁主特征"原则）；
  上游不可达自跳过返回0（防CI假红）。
- `tools/_archive_gate.py`（确定性，不依赖上游）：
  - HARD1 真函数 write/read byte-for-byte 零损失往返
  - HARD2 白名单 `ARCHIVE_WHITELIST_N` 仍 == 3
  - HARD3 `archiveOn` 仍默认 true（设计命脉不被关掉）
  - HARD4 白名单正则精确保住决策/任务状态行、丢弃纯叙述

### 不做的（及原因）
「知识库/经验库转按需」实测只省 8178 tokens（3.1%，非最初估的"大头"），且这些
是"务必每轮遵守的铁律"——降级为按需=赌模型每次主动检索，桩B实测不常驻就不守规矩。
**省零头却降级核心约束，不值得，故保持常驻。**


---

## §2 输出预算天花板：从「写死 32768」到「前端可调、请求级即时生效」

**日期**：2026-10-22　**状态**：已落地（默认空 = 出厂 32768，零行为变化）

### 背景
两个数字长期被混淆：
- 面板「上下文占用 262K tokens」= 模型**真实上下文窗口** n_ctx（引擎 /health 报的真值），是占用百分比的分母，**前端只读、不该改**（改它不改模型容量，只让百分比失真——即此前修过的双分母 bug）。
- 设置里「最大 token 数」= **单轮回复的生成预算**（body.max_tokens），不是窗口。它此前被后端 `compute_output_cap` **写死硬顶到 OUTPUT_CEILING=32768**（仅环境变量 STRATA_MAX_OUTPUT_CEILING 能钉），所以用户把它填到 121K 也「填了个寂寞」——三重钳制 `min(asked, ceiling, 窗口剩余)` 里 ceiling 卡死了它。

用户诉求：这个写死的天花板应该可以前端改，且改了要真实生效。

### 决策
把天花板从写死常量改成**前端可调 + 请求级传值**：
1. 思维抽屉「最大 token 数」下方新增 **「输出预算天花板」输入框**（spinbox，`s-ceiling`）。
2. 前端 `settings.maxCeiling` → 发送时带 `body.max_ceiling`（仅非空时带，留空即回落）。
3. 后端读到 `body.max_ceiling` 后喂给 `compute_output_cap` 的 `ceiling` 参数；**无值则回落全局 OUTPUT_CEILING=32768**。
4. 窗口夹紧（`min(asked, ceiling, 窗口剩余)`）照旧——填超大值不会触发上游 400，安全。

**关键设计点**：走「请求级传值 + 无值回落原常量」，保证老存档/未填值零行为变化，只在用户显式填大值时才放开天花板。它只放开**单轮输出预算**，不撑大模型真实窗口。

### 落点
- 前端：`app.js` DEFAULTS.maxCeiling / loadDrawer 回填 / s-apply 保存 / 发送带 body.max_ceiling；`index.html` 新增 `s-ceiling` 输入框；`i18n.js` 新增 `drawer.maxCeiling` 中英成对键。
- 后端：`http_server.py` 请求级读 `max_ceiling` 喂 `compute_output_cap` 的 ceiling 参数。
- **生效条件**：前端已部署（MD5 全 MATCH）；后端 http_server.py 改动需**重启独立版 8099** 加载（寄生版跑第三方 loop，不执行工作区 http_server）。

### 锁（防退化的常驻契约测试，已并入 run_tests）
- `tests/test_output_ceiling.py`（确定性，不依赖上游，11 项全绿）：
  - 天花板参数真能顶开 cap（65536 > 32768 > 16384 严格单调；90000 被采纳）——证明不再写死。
  - 旧存档/未填值回落出厂 OUTPUT_CEILING（兼容路径）。
  - 窗口夹紧仍生效（大天花板遇近满窗口仍按窗口剩余额出，绝不触发上游 400）。
  - 静态守卫锁前端接线：DEFAULTS 有字段 / 发送写 body.max_ceiling / loadDrawer 与 save 读写 s-ceiling / 后端读 max_ceiling。

### 实测（确定性 + 端到端诚实记录）
- **机制正确性（确定性，已坐实）**：契约测试直接证明 `compute_output_cap(ceiling=65536)`
  返回 65536、能顶开出厂 32768——天花板不再写死，这是本设计的核心契约，不依赖模型行为。
- **端到端（受本机算力限制，未做长跑）**：对照双跑证实同 prompt 下 ceiling 改变的是「单轮生成
  预算上限」；但要让 ceiling 真成为约束，需模型单次自然生成 >32768 token。本机生成约
  23 token/s，单破 32768 需约 24 分钟、60000 需约 43 分钟，远超工具单次超时——属物理限制，
  非 bug；模型不会自然生成几万 token 就主动 stop，故端到端长跑不经济，按用户决定不跑。
- 当前监听进程（7088，20:01 启动）晚于 http_server.py 落盘（19:44），新代码已加载、无需重启。

## §3 生成期 footer 渐进点亮：只点亮「发送即已可得」的数据，依赖引擎 usage 的到位即亮避免虚假跳变

**日期**：2026-11-03　**状态**：已落地（方案A）

### 背景
生成中（streaming）阶段的 turn footer 此前刻意精简——live skeleton 只显耗时 + phase。
用户诉求：生成过程中 footer 应能实时点亮「此刻已经拿得到」的数据，最典型就是种子 chip。
但必须先分清哪些数据"发送那一刻就已可得"、哪些"必须等引擎回报 usage 才有"——否则中途要么显示假数字、要么跳变。

### 决策
只对 **send() 发起阶段就已写入** 的数据做渐进点亮；依赖引擎回报的项保持在完成态到位即亮：
1. `m.seed` / `m.seedPinned` 在 send() 里即写入（app.js L7146/7147，非 usage chunk），整个流式窗口都已可得 → streaming 骨架新增 `stat--seed` span 并逐 tick 点亮；自带专属 anti-flicker sig（`_seedSig`），只在变化时重写、避免跳变。
2. lit chip 与完成态种子 chip 完全同款（class / data-seed / role / tabindex / title + i18n 键 + pin/refresh icon）；`#chat` 的 click-copy 委托用 `closest()`+data-seed，所以同一容器的 live chip 也能点一下复制。
3. **诚实守卫**：`m.seed==null` 时 chip 保持隐藏——中途绝不显示假数字。

依赖引擎 usage / 完整计时的项（tok/s、tokens、ctx%、思考耗时）中途没有或会跳变 → **保持在完成态到位即亮，不强行塞进骨架避免虚假跳变**。轮次 chip 流式期本就支持（跑 tool 即显），未动。

### 实测依据（差分门禁，工具实测；非估算）
- `tests/test_footer_progressive_seed.mjs`：单一变量翻转「m.seed 是否存在」证明守卫 load-bearing——有→点亮含种子数、无→保持隐藏；round-chip 单变量翻证照旧工作。单跑 8/8 GREEN（4 静态锁 + 4 差分），已纳入 run_tests SUITES 基线。

### 代价（诚实记录）
- 依赖 usage 的项不能中途点亮（否则虚假跳变），这部分视觉改善要等完成态才到位——这是诚实取舍，非缺陷。

### 锁（防退化的常驻门禁，已并入 run_tests）
- `tests/test_footer_progressive_seed.mjs`：静态锁「骨架 gained stat--seed span」「seed chip 自带 _seedSig anti-flicker、不与 _sig 共用」「honest hidden-until-seed guard」；jsdom 差分翻转单一变量证 load-bearing。

> 落点：前端 `app.js` renderStats streaming 分支 = anchor commit `v-baseline-2026-11-03-p`（实现本体）；门禁与其 SUITES 登记 off-anchor 在其之上。


---

## §4 监控页 custom-API 路径：网关本地聚合接管显示，静默区逐项点亮（DESIGN S4）

**日期**：2026-11-05　**状态**：已落地（实现 anchor commit `6e17519` + 接线 commit `5d5df6a`）

### 背景
选定在线自定义 API 模型后，监控页整页失联（全「—」、上下文 0%、暂无请求），
顶栏 pill 却仍工作。根因链（读实非臆测）：监控页 `renderMonitor` 的数据只来自
`poll() → fetch("metrics")`，这条相对地址命中 `PROXY_PREFIXES` 被转发给默认上游
8080 引擎；custom 模型的请求只进网关**自己的 `api_requests` 环**（走 `/api/requests`），
`/metrics` 永远到不了 custom 端点。8080 引擎不在跑 → fetch 失败进 `catch` →
`paintCustomPill()` 点亮顶栏，但 `renderMonitor()` 根本没被调用 → 整页空白。

### 决策
分两步，均带常驻差分门禁（实现本体 anchor 在前，接线在后）：
1. **本地聚合接管（`6e17519`）**：`/metrics` 代理失败时回落网关自己的
   `aggregate_local_metrics()`——ring → 契约字段映射 + `_read_local_hardware()`
   读本机（nvidia-smi/psutil），custom 模式下页面不再空白。
2. **静默区逐项点亮（`5d5df6a`）**：
   - **A1** `_mon_chunk(tokens=)` 承接 sse() 解析出的 usage 真值三元组
     (prompt, output, cached)，`usage_tokens()` 优先读 `e["tok"]`——上游回 usage
     时提示词/输出/复用/命中率列真点亮。
   - **A2** 修真实读键 bug（见 known-bugs 段）。
   - **A3** 解码速度：有 usage 用真 token/真跨度；无则 bytes/3.5 估算并标 `est`
     标志，前端「≈」前缀 + hover tooltip 明示「估算值，非引擎实测」。
   - **A4** `engine_block()` 只取 model_registry 声明窗口作分母（**不回落 8080
     引擎 n_ctx**——custom 模式下那是另一台机器/另一个模型的窗口），环形占用仪表点亮。
   - **B5** llm_client 流式请求带 `stream_options.include_usage`（OpenAI 标准扩展，
     主流兼容端点认；拒收方走既有 400 拒绝路径，无新失败模式）。
   - **C6** 专家槽位卡结构上拿不到（本地引擎独有），诚实留空 + 悬浮说明「仅本地
     引擎模式可用」，中英 i18n 双语。

### known-bugs（本轮钉死并修复）
- **A2 读键错位（真 bug，非「数据拿不到」）**：aggregate 的耗时列读
  `r.get("wallclock_s")`，但 finalize 实际写入的键是 `duration_s`（L2950 附近，
  注释明写「waterfall must use this」因为 wallclock_s 对已完结轮次仍增长）。
  两键永不相交 → custom 模式耗时列**永远显示「—」**，本地聚合数据其实一直都在。
  修复 = 读键对齐 finalize（`r.get("duration_s", r.get("wallclock_s"))` 保留回落）。
- **手写桩镜像生产签名的同步陷阱（环境结论，非产品 bug）**：6 个 agent-loop
  主链路测试手写桩镜像旧签名 `def _mon_chunk(self, typ, length)`；生产加
  `tokens=None` 关键字参数后桩收不到 → 事件丢失 → 9 测试红。生产签名是
  source of truth，桩是镜像——改桩即同步恢复（生产签名向后兼容，不动）。

### 实测依据（差分门禁，工具实测）
- `tests/test_monitor_custom_api_landing.py` 16 项差分全绿（A1 tok 三元组填充/
  无 tok 回落、A2 有/无 duration_s 翻转、A3 估算 vs 真实 tag 翻转、A4 有/无
  registry 条目翻转、B5 源码静态锁、C6 双词典静态锁），已注册进 run_tests SUITES。
- 全套 `REGRESSION: ALL GREEN` + 锚链门禁绿 + post-green 真回退 tag 复验绿。

### 锁（防退化的常驻门禁，已并入 run_tests）
- `tests/test_local_metrics_fallback.py`（S4 第一步的门禁，差分证 live.state
  由事件类型驱动、freshness 驱动 idle、GPU 有/无翻转、psutil 有/无翻转）。
- `tests/test_monitor_custom_api_landing.py`（本轮 16 项差分，每条都是单一变量翻转）。
- 生效条件：前端 app.js/i18n.js 部署即生效；后端 http_server.py/llm_client.py
  改动需**重启独立版 8099** 加载。
