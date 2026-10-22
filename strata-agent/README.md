# Strata Agent Gateway — 安装与使用说明
## 仓库约定：commit 切分惯例 + 门禁锁清单

> 后续 agent 请延续本节惯例，让设计文档与其代码在同一仓库同轨演进、基线不漂移。

### commit 切分惯例
1. **核心资产批量基线 commit**：源码 + 全部 tests + 常驻门禁锁 + 核心 config，配 `.gitignore` 排除噪音（缓存/备份/截图/日志/outputs-zip/scratch/一次性脚本/运行时数据/根垃圾，含 Windows 保留名 `nul`，否则 `git add -A` 直接 fatal）。
2. **设计决策的「直接代码落点」单独成 commit**，与对应 DESIGN.md 章节同轨（例：§1 归档/语义摘要 = gateway.py 落点 + session.py 归档指针 + 两门禁锁；§2 输出预算天花板 = 前端字段 + 后端 read + 契约测试）。
3. 每个 commit 只纳入与本次决策相关的文件，**不把一次性脚本/根垃圾带进基线**；commit message 点明它固化的是哪条决策。
4. **scratch 卫生**：工作区根 `tools\` 是纯 scratch（一次性脚本命名族 `_find/_patch/_scan/_r_/_t_`，git tracked=0），用毕即删、不堆积；常驻门禁锁一律落 `strata-agent\tools\`，二者边界不容混淆——清理 scratch 逐个点名删，绝不宽 glob 扫尾、绝不跨目录误删常驻资产。

### 门禁锁清单（run_tests SUITES 引用的常驻门禁，防退化）
下列门禁已登记进 `tools/run_tests.py` 的 SUITES，CI 任一改动触碰其守护面即自动跑；上游不可达时自跳过返回 0（防 CI 假红）：

| 门禁 | 守护内容 | 上次实跑绿（人工观测锚）|
|---|---|---|
| `tools/_seg_scroll_baseline.py` | 五象限分段滚动基线 | 52b7820 (2026-10-22，全套 ALL GREEN 本轮实跑) |
| `tools/_semantic_summarizer_gate.py` | 语义摘要存活率 ≥ 关键词存活率（DESIGN.md §1 锁）| 52b7820 (2026-10-22，全套 ALL GREEN 本轮实跑) |
| `tools/_archive_gate.py` | 归档写/读零损失 + 白名单 N=3 + default-on（DESIGN.md §1 锁）| 52b7820 (2026-10-22，全套 ALL GREEN 本轮实跑) |
| `tests/test_code_hygiene.py` + `tests/_hygiene_baseline.json` | 桩/吞异常/TODO 计数不得高于基线（ratchet 防漂移）| 52b7820 (2026-10-22，全套 ALL GREEN 本轮实跑)（登记本轮实跑）|
| `tests/test_output_ceiling.py` + (默认 `maxCeiling`/`OUTPUT_CEILING=32768`) | 单轮输出预算天花板须可被前端顶开 + 旧存档回落 + 窗口夹紧仍生效（DESIGN.md §2 锁）| 52b7820 (2026-10-22，全套 ALL GREEN 本轮实跑) |

### 实测边界（诚实记录，避免后续误判）

> 这一列是**人工实跑观测锚**（最后一次整套 run_tests 全绿的 commit），非 git 自动字段；
> 各锁文件进入 git 历史的 commit 见 DESIGN.md 对应章节。

以下结论明确区分「确定性实测」与「端到端未跑/不经济」，后续 agent 勿把下列项误当成已有端到端实测：

- **DESIGN.md §2 输出预算天花板**：机制正确性由**确定性契约测试**坐实（直接对纯函数
  `compute_output_cap` 喂不同 ceiling 参数对照 65536>32768>16384 单调）。**端到端「真突破
  32768」未跑**——本机生成约 23 token/s，破 32768 需约 24 分钟、60000 需约 43 分钟，远超
  工具单次超时，且模型不会自然生成几万 token 就主动 stop；属物理限制非 bug，判定不经济
  故不跑，不谎称有端到端长跑数据。
- **DESIGN.md §1 归档/语义摘要**：归档零损失、折叠省量、决策存活率均为**隔离桩 + 常驻门禁**
  实测；语义摘要器判准非 100%（实测 3/4，漏 1 条），靠白名单硬规则兜底。



让 Strata 具备**完整智能体能力**的纯插件扩展包：自主执行循环、MCP 工具、记忆系统、Skills、权限/沙箱。**零修改 Strata**，升级后指向此包即可。

## 依赖
- Strata 在运行（默认 `http://127.0.0.1:8080`，OpenAI 兼容 API）。
- Python 3.10+（建议用管理版运行时）。纯标准库优先；内置缩进式 YAML 解析器已覆盖本项目所有配置（嵌套映射/序列/流式列表/引号标量），PyYAML 仅可选增强。第三方仅 sqlite-vec 可选。

## 快速开始

1. 让 Strata 引用此包的 MCP 配置（二选一）：
   - 在 Strata 启动脚本里加 `--mcp-config <此包>/config/mcp_servers.json`
   - 或把 `config/mcp_servers.json` 的内容贴进 `strata-<model>.json` 的 `mcp_servers` 字段。
   - 重启 Strata。
2. 启动智能体网关（CLI 交互）：
   ```
   bin\run-agent.bat
   ```
   或在命令行运行：
   ```
   python runtime\gateway.py --task "把你的任务写在这里"
   ```

## 能力对照

| 能力 | 来源 | 状态 |
|------|------|------|
| 模型生成（共享实例） | Strata API | ✅ 直接使用，速度一致 |
| 自主执行循环 | `runtime/loop.py` (Plan-Act-Observe-Reflect) | ✅ |
| MCP 工具（fs/shell/websearch/memory/browser） | `servers/*.py` | ✅ 端到端已验证 |
| Skills 插件（声明式 YAML） | `skills/*.yaml` | ✅ 示例可运行，嵌套 YAML 由内置解析器原生支持 |
| 记忆（会话/情景/语义） | `runtime/memory/*` | ✅ 标准库实现 |
| 越用越聪明（学习闭环） | loop 自动沉淀 + 提示词记忆纪律 | ✅ 跨会话写入/召回已验证 |
| 提示词点名资料库闭环 | 默认系统提示词显式引导模型使用 ingest/sources/forget（MCP 可见≠模型被引导；G1/G3 同类问题） | ✅ 默认提示词含四动词 + 媒体转写优先 实测 |
| 网络搜索自主放行 | websearch 移入 auto_approve（不再每次询问；用户选择）+ 提示词搜索纪律（信息超出上下文/记忆时主动搜）；写/删/shell 仍走审批门 | ✅ 搜索端到端不触发确认、写仍受门 实测 |
| 自动测试 / 自我纠错闭环 | `runtime/verifier.py` + loop 自检门 | ✅ 跑->红->喂回->修->绿 闭环已验证 |
| 浏览器/渲染（HTML 自动调试） | `servers/browser_server.py`（Edge 无头 CLI，纯标准库） | ✅ render/screenshot/console 实测可用 |
| 定时任务自动化（时间触发） | `runtime/scheduler.py` + gateway `--daemon`（纯标准库，不依赖 OS） | ✅ 周期/每日/一次性 调度实测可用 |
| 调度器生产化 | scheduler：一次性状态持久 + misfire 合并 + 任务异常隔离 | ✅ 跨重启不重触发/合并/隔离 实测 |
| LLM 调用韧性 | `runtime/llm_client.py` 重试 + 指数退避 | ✅ 瞬断重试后恢复 实测 |
| 可观测性 / 审计 | `runtime/audit.py`（JSONL 轨迹 + 成本/耗时计量） | ✅ tokens/轮次/重试/耗时 实测 |
| 长任务 checkpoint | `runtime/checkpoint.py` + gateway `--resume` | ✅ 落盘 + 断点续跑 实测 |
| 语义向量检索 | `semantic.py` 可插拔 embedding（默认纯标准库哈希向量器 + Python 余弦） | ✅ 向量路径实测可跑（FTS 默认无回归） |
| 资料库语料层（喂资料学习） | `runtime/corpus.py` 解析文档→切块→按 source 入库，复用同一套 FTS/向量检索 | ✅ ingest→检索命中→按 source 删净 实测（txt/md/csv/docx/pptx/xlsx/**html**；PDF 诚实跳过） |
| 媒体资料（图/音/视频） | `corpus.multimodal_bridge(path)` → 按模态路由到平台多模态层：图→vision/OCR、音→ASR（AudioTranscribe）、视频→caption；转写为 `.txt/.md` 后 `ingest` 学习 | ✅ 诚实跳过 + 具体桥接路径 实测（纯标准库核心不内置 OCR/ASR；桥接表是合约，不是注释） |
| 按来源删除 | `semantic.delete(id)` / `delete_source(source)` / `list_sources()` | ✅ 删一份文档=删其所有块，按 source 作用域删除实测 |
| 权限/审批/沙箱 | `runtime/policy/*` | ✅ 默认规则就绪 |
| 审批门命名空间修正 | approval.yaml 用生产真名 `filesystem__write`（非别名 `fs__write`） | ✅ 写文件审批门生产环境实测触发 |
| 主动记忆检索注入（RAG） | loop 任务开始强制注入 top-k 相关记忆，不靠模型自觉 | ✅ 语义+情景命中即注入实测 |
| Skills 权限/触发词落地 | skills_loader 输出 meta，权限外动作强制审批、触发词 surface | ✅ 权限强制 + 触发词 surface 实测 |
| 轮次耗尽收尾 | 超 max_rounds 无答案也触发 distill/audit/事件（非静默 return） | ✅ finalize 事件+audit 实测 |
| MCP server 死亡检测 | 子进程中途挂掉立即报错，不干等 60s 超时 | ✅ 死亡毫秒级检出实测 |
| session.max_chars 接线 | gateway 读 config.session.max_chars 构造 session（非硬默认） | ✅ 小预算折叠/默认不折叠实测 |

## 升级策略

- Strata 换 `engine/strata.exe` → 重启即可，插件不受影响。
- Strata 更新 `serve/server.py` → 运行 `python tools/upgrade_check.py` 自检。
- 插件包本身 → 独立进程，重启网关即可。

## 自检

> 一键跑全套（CI 契约）：`python tools\run_tests.py` —— 聚合全部套件，按退出码判定，全绿（含 skip）才返回 0。设 `STRATA_CI=1` 时 daemon 等"在线 LLM"套件自动跳过，保证 CI 可重复。

```
python tests\test_smoke.py     # executor <-> MCP server 端到端通路
python tools\upgrade_check.py  # Strata 端点可用性
python tests\test_policy.py    # 权限门+学习闭环+自检门+调度+韧性/审计+checkpoint+向量+RAG注入+skills权限/触发+轮次耗尽+server死亡检测+max_chars+审批默认值生产命名空间(H1)+删除审批门(H2)+默认提示词点名资料库闭环(H3/H4契约)+网络搜索自动放行+提示词搜索纪律（27 用例）
python tests\test_browser.py   # Edge 无头 render/console/screenshot（Edge 不在则 skip）
python tests\test_e2e.py       # 全链路集成：plan→权限/审批门→真实子进程→审计/计量→双写蒸馏→跨会话主动RAG召回（闭环实证）
python tests\test_daemon.py    # 生产 daemon 全链路：调度器真实触发一次 LLM 任务（真实在线模型；STRATA_CI 或离线则 skip）
python tests\test_corpus.py    # 资料库语料层：喂文档→学习入库→检索命中→按 source 删净（含 HTML 解析 + 媒体多模态桥接跳过，8 用例）
```

## 自动测试 / 自我纠错闭环（可选开启）

`runtime/verifier.py` 提供一个"自检门"：智能体声称"完成"时自动跑验证（按命令退出码判定，等同于 CI 契约）；**红了就把真实失败喂回对话，让模型反思、修复、再验证**（有限重试）。这是把"能跑测试/能修 bug"变成"自动跑->红->修->绿"的接线。

开启方式（在 `config/mcp_servers.json` 加 `verify` 块）：

```json
"verify": { "command": "python tests\\test_smoke.py", "max_retries": 2 }
```

`command` 路径按退出码判定；也可传 `check_fn`（自定义校验，如 lint / 类型检查 / 浏览器渲染探针）。HTML 渲染级自动调试已通过 `servers/browser_server.py`（Edge 无头 CLI，纯标准库、零新增依赖）接通：`render` 返回 JS 执行后的 DOM、`screenshot` 出 PNG、`console` 抓控制台/JS 报错——即可进入"渲染→看报错→修→再渲染"闭环（实测 render 返回 AFTER-JS、console 捕获到 JS 日志）。Playwright 仅在需要复杂多步交互时才值得（属第三方依赖）。

## 定时任务自动化（纯标准库调度器）

`runtime/scheduler.py` 提供时间触发层（此前项目的自动化全是事件驱动、缺时间驱动）。纯标准库实现（`datetime`+`time`），**不依赖操作系统调度器**——自包含 daemon。

在 `config/mcp_servers.json` 的 `schedule.entries` 配置任务，用 daemon 模式运行：

```
python runtime\gateway.py --daemon
```

每个 entry 声明"跑什么 + 何时触发"（三选一）：
```json
"schedule": { "entries": [
  { "name": "ledger", "task": "汇总账本", "every_minutes": 30 },
  { "name": "daily",  "task": "生成日报", "daily_at": "09:00" },
  { "name": "once",   "task": "归档",     "at": "2026-12-01T08:00" }
]}
```
- `every_minutes` / `every_hours`：周期
- `daily_at: "HH:MM"`：每日
- `at: "YYYY-MM-DDTHH:MM"`：一次性（触发后自动消费）

实测：周期项会反复触发、一次性项到点才触发、调度器睡到最近的下一个触发点再跑（真实墙钟，绝不伪造触发）。离线测试 case10 验证 interval/每日/一次性三种触发 + 重排 + 一次性消费。
