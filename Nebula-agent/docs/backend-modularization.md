# 后端模块化进度

**简体中文** | [English](backend-modularization.en.md)

星云后端 `serve/server.py` 曾是一个 7,000+ 行的单体。为把它变得可测、可维护，我们按「零耦合纯族整搬」
的纪律持续从中摘取内聚的纯函数族移入独立模块 `serve/*.py`。本文件登记这一抽离链的进度与方法纪律。

## 方法纪律

1. **AST out-deps 扫描判定纯**：用 AST 计算每个候选函数引用的「模块全局名」（排除 stdlib、局部名、内建），
   仅当 free names 全是 stdlib import + 自身参数/彼此成员时才列为「安全叶子」整搬。函数依赖的模块级常量
   若同属一族，则**连常量一并搬出**（如 engine_diag 的 `_WIN_CRASH` / `TRANSIENT_START_MARKS`）。
2. **byte-for-byte 等价迁移**，不改写函数体——从 server.py 里字节级搬出而非重打，保证内嵌的转义引号诊断
   字符串逐字保留。
3. **try/except 双路径 import 兜回**（后端抽离专属约定）：`from serve.X import ...` / `except ImportError:
   from X import ...`，因 `server.py` 可被 `python serve/server.py` 直接运行（此时 `serve/` 是 `sys.path[0]`）。
   调用点保持原名不改。前端 `app_utils.js` 是全局共享，**无**此约定。
4. **每个净叶子配 load-bearing 差分行为测试**，统一登记进 `tests/test_pure_modules.py`（逐模块汇总，已在
   `tools/run_tests.py` 的 SUITES 登记，无需另登记）。差分须证明「该分支必须被走到」。
5. **异质职责不合并**：同属引擎子系统的「配置装配」与「启动失败诊断」不合并；早前因「与 boot_diagnose
   异主题（返回 bool 而非消息）」被留在 server.py 的 `engine_crashed`，后来与退出码/崩溃判定成员才是彼此
   的强内聚组，据此成组抽入 `engine_diag`。

## 抽离进度

| 模块 | 主题 | 批次 | 状态 |
|---|---|---|---|
| `serve/wire_codec` | OpenAI/Anthropic 流式重装配 | plan-B 批（2026-11-17） | 完成 |
| `serve/net_gate` | host / origin / api-key 准入闸 | plan-B 批 | 完成 |
| `serve/req_args` | 请求/配置采样参数净化 | plan-B 批 | 完成 |
| `serve/req_stats` | 每请求 token/计时账目 | plan-B 批 | 完成 |
| `serve/ram_guard` | RAM 预算启动告警 | plan-B 批 | 完成 |
| `serve/gpu_score` | 每卡 NVIDIA/AMD 能力评分 | plan-B 批 | 完成 |
| `serve/boot_diagnose` | 人类可读的启动失败诊断（bind/编码器/日志尾） | plan-B 批 | 完成 |
| `serve/path_locate` | 配置/用户输入解析为真实可用路径 | plan-B 批 | 完成 |
| `serve/gpu_config` | 配置的 GPU 列表 / 是否多层分卡 | plan-B 批 | 完成 |
| `serve/env_probe` | 目录可写 / 是否 Linux 桌面会话 | plan-B 批 | 完成 |
| `serve/engine_stall` | 冻结引擎看门狗谓词 + 两阈值 | plan-B 批 | 完成 |
| `serve/tokenizer` | 字节分词替身 / Detokenizer / stop_strings / StopMatcher | 续抽链第 1 步 | 完成 |
| `serve/approval` | 工具审批策略：registry 写操作集 + 破坏性 shell deny + desc | 续抽链第 2 步 | 完成 |
| `serve/conv_cache` | 引擎会话缓存日志读取 + Monitor 缓存卡片 | 续抽链第 3 步 | 完成 |
| `serve/engine_diag` | 引擎退出状态词 / 崩溃判定 / draft-head 提示 / GPU-runtime marks | 续抽链第 4 步 | 完成 |
| `serve/exceptions` | 引擎/会话异常层级（9 类：继承关系 + status / retry_after 载荷） | 续抽链第 5 步 | 完成 |

「plan-B 批」= 首轮成批抽离（refactor plan-B，2026-11-17，一次性摘出 11 个纯模块）；「续抽链」= 在其之后
每次挑一个零耦合内聚纯族续抽的增量链（tokenizer → approval → conv_cache → engine_diag → exceptions）。每步都打命名回滚
点 tag + bundle 固化，详见 `baseline-tag-archive.md`。

## 候选池现状

server.py 仍随新代码增长。续抽下一族前先跑 AST out-deps=0 扫描重列候选（`tools/_q_*.py` 探针系列，用完即删）。
注意 engine 族里 `cpu_isa_words` / `start_exit_note` / `START_RETRIES` / `transient_start_failure` 属启动
重试与 CPU 指令集探测的**异质职责**，故意留在 server.py（`transient_start_failure` 读 `TRANSIENT_START_MARKS`
经 import 兜回）。

## 续抽链第 6 步（2026-11-26）：req_args 续入 sampling 块

复扫 server.py 顶层纯函数（AST out-deps=0），得 21 个候选，逐一读源码研判内聚性后：
仅 `sampling_defaults_from_config`（64L）+ 其唯一引用的 `SAMPLING_ALIASES` 常量是真·低风险净
叶子——主题「运行配置的可选 `sampling` 块净化」正属已抽模块 `serve/req_args`（采样参数校验层）
的职责，故连常量同搬入 req_args，server.py 用 try/except 双路径兜回，调用点原名不改。

- **byte-for-byte 等价**：67 行与原文逐字比对 identical。
- **load-bearing 差分测试**：`test_pure_modules.py::test_req_sampling_defaults_from_config` 锁
  #1819 别名映射的两半——只发别名则重映射不报错、别名+规范名同发则 SystemExit；外加 6 个坏配置
  各触发 SystemExit、null/unknown 跳过。
- **双路径 import 实测**：包路径与 `python serve/server.py`（serve/ 上 path[0]）的 except 分支各 rc=0。

其余 20 候选研判后**故意保留**：`cpu_isa_words`/`profile_shape`/`desktop_vram_note`/`parallel_args`/
`gpu_vram_mib` 等属引擎启动诊断/CPU 探测/GPU 采样的**异质职责**（部分 lazy-import `serve.telemetry`）；
`_recycle_send_to_bin`/`_recycle_restore_file` 是 server.py 与 runtime/http_server.py 的**两份共享
helper**（抽取须协调双份，非低风险）；`write_temporary`/`popen`/`experts_loading_words` 等是零碎单函数
不成族。至此 server.py 续抽候选池进一步枯竭。