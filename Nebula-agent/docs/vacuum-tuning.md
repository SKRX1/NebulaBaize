# semantic.db VACUUM 调参说明

`tools/maintain_semantic_db.py` 每天 04:30 由调度器唤醒，对 `data/semantic.db` 做一次
**碎片门控检查**：满足门控才真·VACUUM（整文件重写回收空闲页），否则 SKIP（只读 3 个
PRAGMA + 追加一行日志，不开写锁）。检查廉价、动作昂贵，所以门控参数按库增长情况调。

## 门控判定（plan_vacuum）

```
真·VACUUM  ⇔  page_count >= MIN_PAGES  且  freelist_count / page_count >= THRESHOLD
```

- 库太小（`page_count < MIN_PAGES`）→ 永不 VACUUM：整文件重写不划算。
- 碎片比低于 `THRESHOLD` → SKIP：回收那几页不值得一次全量拷贝。
- 取到写锁失败（memory server 正占锁）→ SKIP，下个周期重试，绝不阻塞在线 recall。

## 当前默认值（代码实测）

| 参数 | 默认 | 含义 |
|---|---|---|
| `MIN_PAGES` | **2000** | 库小于此页数不 VACUUM（≈ 8 MB @ 4KB 页） |
| `THRESHOLD` | **0.25** | 空闲页占比 ≥ 25% 才 VACUUM |
| `BUSY_MS` | **3000** | 抢写锁最长等待，超时即 SKIP |
| `MAX_LOG_BYTES` | **1048576** | 审计日志达 1 MB 轮转到 `.1`（0 关闭） |

一个 4 KB 页 ≈ 4 KB，故 `MIN_PAGES=2000` ≈ 8 MB；页数×4KB ≈ 库字节数。

## 怎么按库增长调

CLI 可临时覆盖，用于按库规模试参数（不改代码）：

```
python tools\maintain_semantic_db.py --min-pages 4000 --threshold 0.15 --busy-ms 5000
```

调参方向（按观测数据，不要凭感觉）：

- **库变大**（页数远超 2000）：`MIN_PAGES` 保持即可，它只是"太小的库别折腾"下限；
  库已很大时可略调高，避免对小规模碎片波动频繁全量重写。
- **碎片涨得慢**（长期 `frag` 远低于 0.25，天天 SKIP）：可把 `THRESHOLD` 略调低
  （如 0.15），让它在碎片更早、回收更多时触发；每次 VACUUM 是一次全量拷贝，
  阈值越低触发越勤、I/O 越多，权衡。
- **memory server 长期占锁**（日志出现 `write lock busy`）：略调高 `BUSY_MS`，
  给抢锁更多耐心；不要设太长，以免拖慢每日任务窗口。

判断依据来自审计日志 `data/semantic_maintain.log`（每行含 `pages=… free=… frag=…%`
与 VACUUM 行的 before/after 字节），用 `tools/review_semantic_log.py` 看趋势：

```
python tools\review_semantic_log.py --include-archive
```

趋势条 `碎片率趋势` 显示最近 `--trend-n`（默认 30，约一个月每日运行）的碎片走势；
若长期贴近 0%，说明库以追加为主、删除少，25% 阈值很宽松、维持默认即可。

## 改默认值的落地方式

默认值写在 `tools/maintain_semantic_db.py` 顶部常量（`MIN_PAGES` / `THRESHOLD` /
`BUSY_MS`）。改默认属代码改动：改后须过 `tests/test_maintain_semantic_db.py`
（锁 `plan_vacuum` 阈值/下限门控）+ 全套回归；调度任务 `记忆库体积守护 VACUUM`
（`config/mcp_servers.json`，每天 04:30）无需改频率——它是"每天检查、条件回收"。
