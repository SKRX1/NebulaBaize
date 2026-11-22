# docs 索引

本目录文档的集中导航。新增设计/运维文档时在此登记一行（按主题归类）。

## 运维 / 调参

- [`vacuum-tuning.md`](vacuum-tuning.md) — semantic.db VACUUM 门控调参说明
  （MIN_PAGES / THRESHOLD / BUSY_MS 怎么按库增长调整；含当前真实库基线）。

- [`backup-soft-alert.md`](backup-soft-alert.md) — 每日代码备份的前置检查为何从硬阻断
  改为软告警（`|| exit /b 0`）：真实分叉近零、阻断丢整份快照、`|| true` 在 cmd 下
  反向的实测真值表；含"当前 data 内无 backup 日志、靠 session_stream/bundle 核对"的可观测现状。

## 设计 / 评审

- [`plan-b-shell-direct-exec-review.md`](plan-b-shell-direct-exec-review.md) —
  shell 直接执行（plan B）方案评审记录。
