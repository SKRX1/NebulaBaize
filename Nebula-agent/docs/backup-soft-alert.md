# 每日代码备份的前置检查为何改为「软告警」

> 记录一次明确的产品决策，方便日后回看：为什么 03:00「每日代码备份」的前置检查（`backup_precheck.py`）不再**硬阻断**备份，而是改为**软告警**（`|| exit /b 0`）。

## 背景

每日备份任务（`daily_at 03:00`）的真实 task 形如：

```
cd /d "<repo>" && python Nebula-agent\tools\backup_precheck.py \
  && cd /d "<repo>\Nebula-agent" && python tools\backup-bundle.py --keep 14
```

`backup_precheck.py` 先 `git fetch`，再比较本地与 `origin/main` 的 ahead/behind，**只有双侧都领先（真分叉）时才退码 2 阻断**；单侧领先或 `0 0` 同步一律放行。判定逻辑在 `decide(behind, ahead)`，已有离线单测（`tests/test_backup_precheck.py`）与端到端差分（`tests/test_backup_precheck_e2e.py`，真 repo 构造真分叉坐实退 2 经 `&&` 跳过 bundle）双重锁定。

最初设计是**硬阻断**：分叉时 `&&` 短路，bundle 不跑，强制"先整合再备份"。

## 决策：改为软告警（不再阻断）

**结论**：前置检查继续运行、继续告警，但**不再阻断备份**——分叉时备份照常进行，告警仍发声供事后复盘。

### 为什么改

1. **真实工作流里分叉近乎不发生**：本机是唯一推送方、每轮先 push，`origin/main` 长期与本地 `0 0` 一致（实测长期如此）。硬阻断的**日常触发率≈0**。
2. **阻断的代价与收益不对称**：分叉是小概率事件，但一旦发生、若恰在 03:00 触发，硬阻断会**静默跳过**当天的整份 bundle——丢一次每日快照，而备份的本职是"每天尽量留一份"。
3. **硬阻断的"静默"特性难排查**：被 `&&` 跳过时，旧实现没有任何落盘痕迹，次日不易发现"昨天其实没备份"。

### 为什么选 `|| exit /b 0` 而不是 `|| true`

这是本决策最容易踩的坑，**已实测坐实**：

- 调度 task 经 `subprocess shell=True`，在 Windows 上走的是 **`cmd.exe`**（task 文本本身就是 `cd /d` 这种 cmd 语法）。
- **`cmd.exe` 没有 `true` 内建**（那是 PowerShell）。且 cmd 的 `A || B && C` 是扁平左结合链：
  - `|| true`：分叉（precheck=2）时 `|| true` 这步在 cmd 里失败，下游 `&&` 被跳过 → **两态都不备份**（最糟）。
  - `|| ver >nul`：正常日（precheck=0）走了 `&&` 分支后又被链式结构影响 → 真值表实测正常日反而不备份。
  - **`|| exit /b 0`**：恒成功 no-op，吞掉退出码且不污染 `&&` 链 → **正常日与分叉日都放行 bundle**（唯一两态安全的形式）。

> 真值表实测（`cmd /c exit N` 模拟 precheck，marker 文件记录 bundle 是否到达）：

| 写法 | precheck=0（正常日） | precheck=2（分叉日） | 结论 |
|---|---|---|---|
| `\|\| true`（PowerShell 习惯） | 不备份 | 不备份 | ✗ 两态都坏 |
| `\|\| ver >nul` | 不备份 | 备份 | ✗ 正常日反坏 |
| `\|\| exit /b 0` | 备份 | 备份 + 仍告警 | ✓ 采用 |

因此最终 task 在 `backup_precheck.py` 后插入 `|| exit /b 0`，使链变成"precheck 无论成败都继续 bundle"，而 precheck 自身的 `PRECHECK FAIL diverged …(告警)` 仍打到 stderr（告警能力完整保留，已单测/真 repo 双重坐实 precheck 单独仍退 2）。

## 当前可观测性现状（重要，别误以为已有日志）

截至本文撰写，**`data/` 内没有独立的 backup/precheck 日志文件**：

- `backup_precheck.py` / `backup-bundle.py` 均不写日志；task 命令**没有** `>>` 重定向。
- `data/schedule_state.json` 仅存 `last_run: {ts, ok}`，**不存 stdout/stderr**。
- task 经 `runtime/gateway.py:_sched_run_task` 以 `agent.run(task)` 执行；该任务 `deliver=session_stream`，所以 agent 输出（含转述的告警）会**实时推送进该任务的会话流**——这是当前唯一的"看告警"途径，**不落盘**。

**净效果**：正常日照常备份；偶发分叉时备份**照常进行**，告警经会话流可见，但 `data/` 内暂无可事后复查的 backup 日志。若要让"分叉时 PRECHECK FAIL 能在 data 内日志复查"，需给 task 末尾追加 `>> data\backup.log 2>&1`（仿周复盘任务的 `>> data\semantic_review.log` 模式，机制已在该任务验证）。该项属需主人拍板的改动，未擅自执行。

## 如何回看是否备份成功

- 看 `data/schedule_state.json` 的 `每日代码备份.last_run`（ts 应为当日 03:00 左右、`ok=true`）。
- 看主/镜像备份盘 `E:\星云备份\星云白泽备份`、`F:\星云备份\星云白泽备份` 是否新增当日 `strata-bundle-YYYYMMDD-HHMMSS.bundle`（正常日 03:00 会产出一份，与 last_run 时间吻合）。

## 相关代码 / 测试

- `Nebula-agent/tools/backup_precheck.py` — 前置检查（`decide` 纯函数 + main）
- `Nebula-agent/tools/backup-bundle.py` — bundle 生成与双盘校验、keep-N 裁剪
- `Nebula-agent/tests/test_backup_precheck.py` — `decide()` 离线差分（仅双侧领先才阻断）
- `Nebula-agent/tests/test_backup_precheck_e2e.py` — 真 repo 端到端差分（退 2 → `&&` 跳过 bundle）
- `runtime/gateway.py:_sched_run_task` — 调度 task 的实际执行与 deliver 路由
- task 定义：`config/mcp_servers.json` → `schedule.entries[0].task`
