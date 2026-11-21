# 方案B评审：让「纯 shell 任务」脱离 LLM 回合、直接 subprocess 执行

## 背景（已实测事实）
- 调度任务的 `task` 字符串目前**不是直接跑 shell**，而是当作 **LLM 提示词喂给 `agent.run()`**（`gateway.py:_sched_run_task` → `agent.run(task, history=[])`），靠模型自己决定调用哪个工具去执行命令。
- 判定点在 `scheduler.py:_safe_run`：`run_task` 不抛异常=成功，抛任意异常=记 `last_run.ok=false`。
- 「每日代码备份」今天 03:30 记 `ok=false`；脚本本身健康（实跑 `backup-bundle.py --keep 14` → `ALL GREEN`，含 F 盘跨盘镜像 MD5）。失败发生在「LLM 回合」这一层，而非脚本层。
- 本会话已落地的修复（commit `827b053`）= 方案A：把 `schedule-error` 接到审计 JSONL + stderr，使失败原因**可见可审计**。**它没有改执行语义**，所以「LLM 回合跑 shell」这条路径本身未变。

## 方案B是什么
对「动作明显是一条 shell 命令」的任务（如本条 `cd /d "..." && python tools\backup-bundle.py --keep 14`），**跳过 LLM 回合、直接 subprocess 执行**，把退出码作为成败判据（非 0 即 red，并把 stderr 写入审计）。

## 影响面（关键：会改执行模型，波及其余所有定时任务）
1. **判定语义变化**：现在的「成功」= LLM 回合无异常；方案B 的「成功」= 命令退出码 0。两条路径判据不同，需明确哪些任务走哪条。
2. **审批/roots 语义**：当前 `approval`、`roots`、`model` 是为「agent 回合」设计的（standing consent、fs_allowed_roots swap、model routing）。纯 shell 直跑时，这些字段大多**失去意义**（没有工具调用、没有 model），需要单独的 shell 审批/roots 规则，否则用户会困惑「为什么给 shell 任务选了 model」。
3. **busy 串行化**：现有 `idle_gate` 把调度任务排在交互回合之后（防止并发抢模型/shared executor）。直跑 shell 抢的是 subprocess 资源，不是模型——是否仍走 idle_gate 需决策（走则保守、与现状一致；不走则更快但可能与交互回合并发读写共享文件）。
4. **环境差异**：直跑 subprocess 的 cwd/env/编码（尤其中文路径 `E:\星云\...` 与 chcp 65001）必须实测；脚本已自证「路径作 unicode argv 传入、不硬编码中文路径」，这条已具备，但 `cmd /d` 行尾、退出码捕获仍要测。
5. **不可逆性低**：方案B 是**新增分支**（带标志位区分 shell 任务 vs agent 回合），不是把现有任务一刀切；老任务保持 LLM 回合，新 shell 任务走直跑，可共存。

## 与方案A的关系
- 方案A（已落地）解决的是「失败**看不见**」——无论走哪条执行路径都需要它，是**通用可观测性基座**，不是临时补丁。
- 方案B解决的是「**根本不该绕一圈 LLM** 去跑一条确定性 shell 命令」——是执行模型的增强，风险更高、影响面更广，应**单独评审后再做**。

## 建议（默认，供拍板）
默认建议：**先不动**，让方案A 在真实 03:30 触发观察至少一次（确认审计里能看到真实成败）。若确认失败主因就是「LLM 回合不稳定地没去跑 shell」，再立方案B，并至少满足：
1. 用显式标志（如任务条目加 `exec: "shell"`）区分，**不**改动既有 agent 回合任务；
2. shell 直跑也**复用方案A 的审计通道**（失败原因落 JSONL）；
3. 配一个离线差分测试：注入一条失败 shell（非0退出码）→ 断言记 `ok=false` 且审计含 stderr；注入成功 shell（0退出码）→ 断言 `ok=true`。

## 一句话风险评级
- 方案A（已做）：低风险，纯可观测性，已落地。
- 方案B：中风险，改执行模型、波及全部定时任务的判定/审批语义；建议先观察 + 单独立项。
