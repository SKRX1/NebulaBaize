# docs 索引

> **简体中文** | [English](README.en.md)

本目录文档的集中导航。新增设计/运维文档时在此登记一行（按主题归类）。

## 运维 / 调参

- [`vacuum-tuning.md`](vacuum-tuning.md) / [English](vacuum-tuning.en.md) — semantic.db VACUUM 门控调参说明
  （MIN_PAGES / THRESHOLD / BUSY_MS 怎么按库增长调整；含当前真实库基线）。

- [`backup-soft-alert.md`](backup-soft-alert.md) / [English](backup-soft-alert.en.md) — 每日代码备份的前置检查：为何从硬阻断改为
  「软告警不阻断 + 告警落 data\backup.log + 体积轮转」。含 cmd 下 `|| true`/`|| exit /b 0` 皆错、
  唯一安全原语是括号组 `( … || cd . )` 的实测真值表，以及「价值在哨兵不在阻断」的设计取向。

- [`proxy-port-consistency.md`](proxy-port-consistency.md) / [English](proxy-port-consistency.en.md)
  — 代理端口一致性：三处独立存的 7890，换机器/换端口时如何一处定位；启动自检 check_proxy_config 探活 + 下载代理不通直连重试日志。

- [`sparse-checkout-trim-trap.md`](sparse-checkout-trim-trap.md) / [English](sparse-checkout-trim-trap.en.md)
  — 误开 sparse-checkout 致主仓 servers/ 与 tools/ 集体「消失」的排障笔记：cone 模式裁列表外目录、
  skip-worktree 让 git status 仍显干净假象；`checkout-index --ignore-skip-worktree-bits` 找回 +
  `sparse-checkout disable` 拆雷；主仓永不该用稀疏检出。

## 设计 / 评审

- [`plan-b-shell-direct-exec-review.md`](plan-b-shell-direct-exec-review.md) / [English](plan-b-shell-direct-exec-review.en.md) —
  shell 直接执行（plan B）方案评审记录。

## 历史 / 归档

- [`baseline-tag-archive.md`](baseline-tag-archive.md) / [English](baseline-tag-archive.en.md) —
  已被后续基线覆盖、予以清理的 `v-baseline-*` tag 归档账本（逐 tag 记录其指向 commit
  与精确重建命令；删 tag 不丢任何 commit，master 链已含）。
