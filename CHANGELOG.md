# Changelog

本项目的所有显著改动都记录在此文件。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

本项目のすべての主な変更点は本書に記録します。

All notable changes to this project are documented in this file.

## [Unreleased]

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
