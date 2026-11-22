# 每日代码备份的前置检查：从硬阻断改为「软告警 + 可落盘复查」

> 记录一条明确的产品决策，方便日后回看：为什么 03:00「每日代码备份」的前置检查
> （`backup_precheck.py`）不再**硬阻断**备份，而是「**软告警不阻断 + 把告警落盘**到
> `data\backup.log`，并给该日志加体积上限轮转」。本文也**更正**早前一版误记的
> `|| exit /b 0` 写法（实测在 cmd 下是错的）。

## 背景

前置检查 `backup_precheck.py` 先 `git fetch`，再比较本地与 `origin/main` 的 ahead/behind，
**只有双侧都领先（真分叉）时才退码 2 阻断**；单侧领先或 `0 0` 同步一律放行。判定逻辑
`decide(behind, ahead)` 已由离线单测（`tests/test_backup_precheck.py`）与端到端差分
（`tests/test_backup_precheck_e2e.py`，真 repo 构造真分叉坐实退 2）双重锁定。

最初设计是**硬阻断**：分叉时 `&&` 短路，bundle 不跑，强制"先整合再备份"。

## 决策：软告警不阻断 + 告警落盘 + 日志体积轮转（已落地）

结论：前置检查**继续运行、继续告警**，但**不再阻断备份**——分叉时备份照常进行；告警
写入 `data\backup.log` 可事后复查；该日志由 `rotate_log.py` 做体积上限轮转防无限增长。

### 为什么不再硬阻断

1. **真实工作流里分叉近乎不发生**：本机是唯一推送方、每轮先 push，`origin/main` 长期
   与本地 `0 0` 一致（实测长期如此）。硬阻断的日常触发率≈0。
2. **阻断代价与收益不对称**：分叉是小概率，但一旦发生、恰在 03:00 触发，硬阻断会
   **静默跳过**当天的整份 bundle——丢一次每日快照，而备份本职是"每天尽量留一份"。
3. **硬阻断的"静默"难排查**：被 `&&` 跳过时旧实现没有任何落盘痕迹。

### 关键坑①：`|| true` / `|| exit /b 0` 在 cmd 下都错（实测更正早前记录）

调度 task 经 `subprocess shell=True`，在 Windows 上走的是 **cmd.exe**（task 文本本身就是
`cd /d` 这种 cmd 语法）。本轮用真 `backup_precheck.py`（退 2）+ 真 cmd 端到端实测，结论
与前次纯文字推理不同，**特此更正**：

| 写法 | precheck=0（正常日） | precheck=2（分叉日） | 结论 |
|---|---|---|---|
| `|| true` | 不备份 | 不备份 | ✗ cmd 无 `true` 内建（那是 PowerShell） |
| `|| exit /b 0`（早前误记的方案） | 备份 | **不备份** | ✗ `exit /b 0` 结束整个 cmd 进程，后续 `&& bundle` 根本不跑——比硬阻断更糟（agent 还退 0 误判成功） |
| `|| rem` / `|| (rem ok)` | 不备份 | 不备份 | ✗ 不可靠 |
| **`( … || cd . )`（采用）** | 备份 | 备份 + 告警落盘 | ✓ 括号组内 `||` 吞码、`cd .` 成功→整组退码 0→后续 `&&` 正常 |

要点：裸链 `A || B && C` 在 cmd 是扁平左结合，`||` 后的成功不一定能透传给 `&&`；但把
precheck 与吞码 no-op **关进括号组 `( … )`** 后，整组的退出码即"组内最后一条命令"的状态，
`cd .` 恒成功→整组退 0→外层 `&&` 放行 bundle。**括号分组是这里唯一稳的写法。**

### 关键坑②：重定向必须包裹整组，否则抓不到告警

cmd 里 `A && B && C >> log` 把 `>> log` **只绑到最后一条 C**，precheck 段的 stderr（
`PRECHECK FAIL` 告警）完全不被捕获。要捕获全程必须 `>>` **包裹整组**：

```
( cd /d "<repo>" && python backup_precheck.py || cd . ) >> "<绝对log>" 2>&1
```

（`cd .` 不改盘，但为彻底规避相对路径在括号子环境的歧义，日志用**绝对路径**。）

### 关键坑③：日志轮转必须在 `>>` 打开文件之前

`>> backup.log` 在 cmd 启动时即持有该文件句柄，组内/子进程无法再轮转它（Windows 锁）。
所以 `rotate_log.py` 必须是 task 的**第一个** step，在 grouped 重定向打开 backup.log **之前**
退出（cmd 顺序执行保证句柄已释放）。`tests/test_rotate_log.py` 锁定其"超体积→降序移位保留
N 份 + 截断活动文件（非删除）"的契约。

## 落地后的真实 task（config/mcp_servers.json → schedule.entries[0].task）

```
cd /d "<repo>" \
  && python Nebula-agent\tools\rotate_log.py "<abs>\Nebula-agent\data\backup.log" --max-bytes 1048576 --keep 3 \
  && ( python Nebula-agent\tools\backup_precheck.py || cd . ) >> "<abs>\Nebula-agent\data\backup.log" 2>&1 \
  && cd /d "<repo>\Nebula-agent" && python tools\backup-bundle.py --keep 14
```

执行语义（已真 repo + 真 cmd 端到端验证）：
- **正常日（0 0）**：rotate 多为 no-op → 日志追加 `PRECHECK OK` → bundle 跑。
- **分叉日**：日志追加 `PRECHECK FAIL diverged …`（告警可复查）→ 经 `( … || cd . )` 不阻断 →
  bundle **照常跑**。
- 日志超过 1 MiB 时 `rotate_log.py` 把 `backup.log` 轮转为 `.1/.2/.3`（保留 3 份，旧的删除），
  活动文件截断为空待下次追加；磁盘占用≈4 MiB 封顶。
- 注：`backup_precheck.py` 的 `(blocking)` 字样是其原始措辞；新方案下它只是**告警**，实际不阻断。

## 如何回看是否备份成功 / 是否曾分叉

1. 看 `Nebula-agent\data\backup.log`：每次运行追加一行 `PRECHECK OK …`（正常）或
   `PRECHECK FAIL diverged …`（曾有分叉但仍备份了）。超体积看 `.1/.2/.3` 历史。
2. 看 `Nebula-agent\data\schedule_state.json` 的 `每日代码备份.last_run`（ts≈当日 03:00、`ok=true`）。
3. 看主/镜像盘 `E:\星云备份\星云白泽备份`、`F:\星云备份\星云白泽备份` 是否新增当日
   `strata-bundle-YYYYMMDD-HHMMSS.bundle`。

## 相关代码 / 测试

- `Nebula-agent/tools/backup_precheck.py` — 前置检查（`decide` 纯函数 + main，退 2 仅真分叉）
- `Nebula-agent/tools/rotate_log.py` — backup.log 体积上限轮转（2026-11-22 新增）
- `Nebula-agent/tools/backup-bundle.py` — bundle 生成与双盘校验、keep-N 裁剪
- `Nebula-agent/tests/test_backup_precheck.py` — `decide()` 离线差分
- `Nebula-agent/tests/test_backup_precheck_e2e.py` — 真 repo 端到端（退 2 → 旧 `&&` 跳过 bundle）
- `Nebula-agent/tests/test_rotate_log.py` — `rotate_log.rotate` 契约（no-op/超量/keep-N/截断非删除/边界）
- `runtime/gateway.py:_sched_run_task` — 调度 task 的实际执行与 deliver 路由（task 经 `agent.run` 跑 shell）

## 生效方式

调度 host（`scheduler_host.SchedulerHost`）**每 tick 热重载** config，改 task 后即时生效，
**无需重启** 8099。（早前误记"需重启"，特此更正。）

## 设计取向（最终结论）：价值是「哨兵」而非「阻断」

经过几轮实测与复盘，对本功能的定位收束为一句：**前置检查的价值在于「发现异常时留下信号」，
而不在于「阻断备份」**。软告警恰好把长期纠结的两难拆开了：

- 「保备份」——无论是否分叉，每天都要尽量留一份 bundle（备份的本职）；
- 「留信号」——真分叉时仍留下 `PRECHECK FAIL diverged` 痕迹（data\backup.log + 会话流可复查）。

硬阻断用「牺牲当天快照」去换「强制先整合的提醒」，代价与收益不对称（分叉近乎不发生、触发率≈0，
而一旦触发就丢整份快照且旧实现还无痕迹）；完全不用前置检查则失去这唯一的分叉哨兵，省下的只是
每天一次 fetch 的几秒。故「用，但不让它阻断」严格优于「用且阻断」与「不用」两种立场。

因此 `decide()` 仍保留退码 2 / level=FAIL（这是**契约与信号**，其它调用方可据此自行阻断），
只是每日 task 选择用 `( … || cd . )` 吞掉它继续备份。**信号保留，动作解耦。**

> 决策定论（2026-11-22 主人拍板）：维持现状——保留前置检查的软告警，不再改动。
