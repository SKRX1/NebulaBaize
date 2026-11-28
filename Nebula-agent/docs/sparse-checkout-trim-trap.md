# 误开 sparse-checkout 致主仓 servers/ 与 tools/ 集体「消失」

> **简体中文** | [English](sparse-checkout-trim-trap.en.md)

锁定的事实：**主仓（开发/运行本体）永远不该启用 sparse-checkout**。一旦 cone 模式按
列表裁剪，列表外的目录会被 git 物理删除并打上 `skip-worktree` 标志，`git status` 仍显示
「干净」——表面看就像「工具和服务突然被删了」，实则被稀疏检出藏了起来。

## 现象（用户视角）

`servers/`（MCP 服务脚本）与 `tools/`（回归/备份/脚手架脚本）整目录从工作树消失，
但 git status 不报删除、git 仍认为它们存在；运行时大量工具报 `No such file` 或
`ModuleNotFoundError`。须从 `E:\星云备份\星云白泽备份` 里的 bundle 恢复才找回。

## 根因（操作事故）

为**临时参考仓**（`%TEMP%\...` clone 的第三方仓）做稀疏检出、只看少数目录免下载全仓时，
误把 `git sparse-checkout set Nebula-agent/runtime Nebula-agent/serve/web Nebula-agent/tests`
跑在了**主仓 cwd** 上。cone 模式下这等价于「工作树只保留这 3 个目录」，于是 servers/、
tools/ 等被裁掉。配置铁证：

```
core.sparseCheckout       = true
core.sparseCheckoutCone   = true
git sparse-checkout list  = Nebula-agent/runtime
                            Nebula-agent/serve/web
                            Nebula-agent/tests   （缺 servers/ 与 tools/）
```

## 恢复与拆雷

1. 单文件找回：`git checkout-index -f --ignore-skip-worktree-bits -- <path>`
   （`skip-worktree` 文件普通 `git checkout` 拒绝恢复，必须带这个开关从 index 强落盘）；
2. **彻底拆雷**：`git sparse-checkout disable`，使 `core.sparseCheckout`/`Cone` 转 `false`、
   skip-worktree 计数归 0，servers/ 与 tools/ 永久回到全量工作树。实测拆雷后
   `tools/` 从被裁的 15 个全量恢复到 63 个、`servers/` 全部在盘。

## 预防约定

- 给**临时参考仓**做 sparse 操作前，先 `cd` 进该仓目录（或用 `--git-dir` 显式指向它），
  绝不在主仓 cwd 下跑 `sparse-checkout set/disable`；
- 凡见 `core.sparseCheckout=true` 即是主仓高危信号，先 `git sparse-checkout disable`；
- 临时 clone 用 `--depth 1 --filter=blob:none --sparse` 时，sparse 命令务必作用于该临时仓，
  用完连临时目录一并清理，别让稀疏配置回流到主仓。

## 与备份的关系

bundle 用 `git bundle create ... --all` 取的是**全量提交图**，不受 sparse-checkout 影响——
所以被裁的 servers/tools 仍在 bundle 里、可从备份整体 clone 找回；但工作树当下缺文件会
让运行时与回归「假崩」，故一旦发现 servers/tools 缺失，先 `git config --get core.sparseCheckout`
甄别是否误开稀疏检出，再决定是恢复还是拆雷。
