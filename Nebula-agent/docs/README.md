# docs 索引

> **简体中文** | [English](README.en.md)

本目录文档的集中导航。新增设计/运维文档时在此登记一行（按主题归类）。

## 运维 / 调参

- [`vacuum-tuning.md`](vacuum-tuning.md) — semantic.db VACUUM 门控调参说明
  （MIN_PAGES / THRESHOLD / BUSY_MS 怎么按库增长调整；含当前真实库基线）。

- [`backup-soft-alert.md`](backup-soft-alert.md) — 每日代码备份的前置检查：为何从硬阻断改为
  「软告警不阻断 + 告警落 data\backup.log + 体积轮转」。含 cmd 下 `|| true`/`|| exit /b 0` 皆错、
  唯一安全原语是括号组 `( … || cd . )` 的实测真值表，以及「价值在哨兵不在阻断」的设计取向。

## 设计 / 评审

- [`plan-b-shell-direct-exec-review.md`](plan-b-shell-direct-exec-review.md) —
  shell 直接执行（plan B）方案评审记录。
