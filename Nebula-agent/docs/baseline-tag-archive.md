# 基线 Tag 归档账本 · Baseline Tag Archive

本文件登记「已被后续基线覆盖、予以清理」的 `v-baseline-*` 附注 tag，记录其指向的 commit，
以便随时精确重建。判据：被删 tag 指向的 commit 全部是 HEAD（master）的祖先（`git merge-base
--is-ancestor` 逐一坐实），故删 tag **不丢任何 commit**——master 链已含它们；tag 仅是命名指针，
按下方命令即可重建。旧 bundle（E/F 盘各保留最新 14 份）亦含这些 tag，clone 旧 bundle 同样可恢复。

## 2026-11-21 系列清理（保留 -h = v0.1.0 当前回滚点）

2026-11-21 当天密集打了 a~h 共 8 个全绿里程碑 tag，构成一条线性链；`-h`（HEAD 93e4727，
v0.1.0 角标定稿点）作为当天最新代表与当前回滚点保留，a~g 为被后续基线覆盖的旧点，予以清理。

| 已删 tag | 指向 commit | 当日语义 |
|---|---|---|
| v-baseline-2026-11-21-a | 99cdc009d03fd4043e29631b4243037dc8d4d2c5 | sidebar all-hidden 回归修复（decouple sidebarTabs from sampling） |
| v-baseline-2026-11-21-b | b7e338c43b00e9e0abbb31dea241e5af25e4063b | watchdog xplat register + content=None wire normalize |
| v-baseline-2026-11-21-c | bd12c55fac31e73079a95912a895d925898f90d9 | watchdog 8099 relaunch interval 10s->5s |
| v-baseline-2026-11-21-d | b0cd5b6e2822a3485028c7863b94351890b6e758 | CHECK_INTERVAL==5 pinned in watchdog gate |
| v-baseline-2026-11-21-e | 041a3e904ae2e2caecd631ce7b3a71107f08d55a | fs_allowed_roots 3 dirs landed from stale stash@1 |
| v-baseline-2026-11-21-f | 31ddbbd1335beb109d737a7f56832af2991dc21b | workspace tail-drop + reset-order |
| v-baseline-2026-11-21-g | 72d7ac21bf608d1f5a5e26567e4eabd7e2d4680b | review_semantic_log trend_n=30（term1 bundle 固化） |

## 重建命令（如需恢复某个被清理的 tag）

```bat
git tag -a v-baseline-2026-11-21-a 99cdc009d03fd4043e29631b4243037dc8d4d2c5 -m "baseline rollback point @99cdc00: sidebar all-hidden regression fix + gate G root-cause lock"
git tag -a v-baseline-2026-11-21-b b7e338c43b00e9e0abbb31dea241e5af25e4063b -m "baseline: watchdog xplat register + content=None wire normalize chain"
git tag -a v-baseline-2026-11-21-c bd12c55fac31e73079a95912a895d925898f90d9 -m "baseline: watchdog 8099 relaunch interval 10s->5s"
git tag -a v-baseline-2026-11-21-d b0cd5b6e2822a3485028c7863b94351890b6e758 -m "baseline: CHECK_INTERVAL==5 pinned in watchdog gate"
git tag -a v-baseline-2026-11-21-e 041a3e904ae2e2caecd631ce7b3a71107f08d55a -m "baseline: fs_allowed_roots 3 dirs landed from stale stash@1"
git tag -a v-baseline-2026-11-21-f 31ddbbd1335beb109d737a7f56832af2991dc21b -m "baseline: workspace tail-drop + reset-order"
git tag -a v-baseline-2026-11-21-g 72d7ac21bf608d1f5a5e26567e4eabd7e2d4680b -m "baseline rollback point: review_semantic_log trend_n=30 (term1 bundle)"
```
