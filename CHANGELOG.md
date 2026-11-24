# Changelog

本项目的所有显著改动都记录在此文件。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

本项目のすべての主な変更点は本書に記録します。

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed / 修复

- **侧边栏「所有标签页突然全部隐藏」bug** — 把便签推送到对话（或任意触发采样保存的操作）后，左侧任务栏会在【每个】标签页一起变隐藏、所有显隐开关显示为关，只有点「恢复默认」才救回（commit `a75ab84`）：
  - **根因**：采样抽屉「应用」按钮（`s-apply`）用对象字面量**整体重建 `settings`，但字面量漏了 `sidebarTabs` 字段** → 运行期内存里的 `settings.sidebarTabs` 变成 `undefined`。`sidebarVisApply` 旧写法读 `settings.sidebarTabs || []` 退化成空数组 → body 在每个标签页都被加 `no-sidebar`，侧边栏全关。持久化的独立键 `strata.sidebar.tabs` 本身没坏，所以刷新/恢复默认可临时救回，但运行期一直卡在隐藏态。复现路径：便签推送 → `executeSpark` 调 `showTab("chat")` → `sidebarVisApply` 读到被抹掉的字段。
  - **修复**：`sidebarVisApply` / `renderSidebarSettings` 改经新 helper `sidebarShowList()` **直接读权威独立键 `strata.sidebar.tabs`**（缺失才回退内存字段、再回退空列表），契合既有「`sidebar.tabs` 才是权威源、`sampling` 键不含 `sidebarTabs`」的解耦设计。任何重建 `settings` 的路径都不再能在运行期抹掉侧边栏。
  - 回归门禁：`tests/test_sidevis_sapply_clobber_jsdom.mjs`（A helper 读权威键 / B 抹掉内存字段后 chat 仍显示侧边栏 / C 单变量差分：key+字段都缺才退化隐藏，证 helper 是 B-1 的真兜回）。

  *Sidebar silently hidden on every tab:* pushing a spark into the chat (or any action that triggers a sampling save) used to hide the left sidebar on EVERY tab at once, with all show-switches reading off — only “Reset to default” would bring it back. Root cause: the sampling drawer’s Apply button rebuilds the whole `settings` object with a literal that omits `sidebarTabs`, so the in-memory `settings.sidebarTabs` went `undefined`; `sidebarVisApply` then read `|| []` → empty → `body.no-sidebar` on every tab. The independent `strata.sidebar.tabs` key itself was intact (hence a reload/Reset recovered it), but the live session stayed hidden. Fix: `sidebarVisApply` / `renderSidebarSettings` now read the authoritative `strata.sidebar.tabs` key via a new `sidebarShowList()` helper (falling back to the field, then empty), matching the existing decoupling design where `sidebar.tabs` is the source of truth and the `sampling` key carries no `sidebarTabs`. Gated by `tests/test_sidevis_sapply_clobber_jsdom.mjs` (load-bearing single-variable differential).

## [0.1.0] - 2026-11-24

### Added / 新增

- **采样设置双层默认值模型（方案A）** — 采样抽屉「重置 / 设为默认值 / 应用」三个按钮的语义重新划分（commit `25fc4c9`）：
  - **设为默认值**：先把当前界面值 `应用`（写入 `sampling` 键、立即生效），再把它固化进新的 `sampling.default` 键——即「重置时会回到的基线」。
  - **重置**：恢复到 `sampling.default`；**若从未设过默认值则回落出厂 `DEFAULTS`**，永不落空。重置只刷新抽屉界面，仍需点「应用」才写盘。
  - **应用**：语义不变（把当前界面值写入 `sampling` 键）。
  - 三按钮的悬浮提示文案已同步更新（中英双语）以反映新语义。
  - 回归门禁：`tests/test_sampling_default_layer_jsdom.mjs`（L1 双写 / L2 取消不写 / L3 有默认回落基线 / L4 无默认回落出厂 / L3-vs-L4 单变量差分 load-bearing / L5 重置只刷界面不落盘）。

  *Sampling drawer two-layer default model (Plan A):* **Set to default** now applies the on-screen values (writes `sampling`, takes effect immediately) and then freezes them into a new `sampling.default` key — the baseline Reset returns to. **Reset** restores `sampling.default`, falling back to factory `DEFAULTS` when none was ever set (never blank); it only updates the form, pressing Apply is still required to persist. **Apply** is unchanged. Tooltips updated in both languages. Gated by `tests/test_sampling_default_layer_jsdom.mjs`.

- **调试页 / 记忆页卡片默认折叠双开关（对称）** — 新增两个设置抽屉开关（commit `e6c3453`）：「调试页卡片默认折叠」`settings.debugFold`（默认开=折叠）与「记忆页卡片默认折叠」`settings.memFold`（默认关=展开）。两者各自只管自己的卡片、互不越界；用户对某张卡的手动展开/折叠仍被记住并优先于开关。回归门禁：`tests/test_card_fold_settings.mjs`（四象限可控 + 单变量差分 load-bearing + 跨隔离 + 用户手动优先）。

  *Debug / memory card default-collapse switches (symmetric):* `settings.debugFold` (default on = collapsed) and `settings.memFold` (default off = expanded), each scoped to its own cards; a per-card manual toggle is remembered and wins over the switch. Gated by `tests/test_card_fold_settings.mjs`.
