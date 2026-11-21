# 星云白泽 · Nebula Baize
[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE) [![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-pink.svg)](https://github.com/sponsors/SKRX1)

> An original **application-layer** agent — gateway, runtime, skills, memory, and web UI —
> **powered by Strata** inference engine.
>
> 一个**原创应用层**智能体（网关 / 运行时 / 技能 / 记忆 / 前端），底层通过 `--url` 接入 **Strata** 推理引擎。

**Author / 作者：** 时空象容

---

## Architecture · 架构

A one-line picture of “what this repo ships” vs “what it runs on top of”:
一张图说清楚“本仓库发布什么” vs “它跑在什么之上”：

```
+--------------------------------------------------------+
|  Nebula Baize / 星云白泽  (THIS repository)             |   <- original application layer / 原创应用层
|  gateway · runtime · skills · scheduler · memory · tools   |      (AGPL-3.0, (c) 2026 时空象容)
|  web frontend (serve/web)                               |
+--------------------------------------------------------+
                          |
                    --url (HTTP / OpenAI-compatible)
                          |
                          v
+--------------------------------------------------------+
|  Strata inference engine  (runtime prerequisite, NOT bundled) |   <- runtime dep / 运行前置，不随包发布
|  native backend: src · include · metal · sycl · third_party|      (separately licensed by its authors)
+--------------------------------------------------------+
```

The arrow `--url` is the *only* link between the two. This repository = the top box only.
箭头 `--url` 是两者之间唯一的连接。本仓库 = 只有上面那个框。

---

## What this is · 这是什么

星云白泽 is the **original application layer** of this project: the agent gateway, runtime,
skills, scheduling, memory subsystem, tools, and the web frontend. This code was authored for
Nebula Baize and is what this repository ships.

It is **not** the inference engine. At runtime it connects to a separately-installed
**Strata** engine over a network endpoint (`--url http://127.0.0.1:8080/v1`). The Strata engine
and its native backend are **not bundled** in this release — they are a runtime prerequisite you
supply yourself.

星云白泽 是本项目的**原创应用层**：智能体网关、运行时、技能、调度、记忆、工具与 Web 前端。
本仓库发布的就是这部分代码。它**不含**推理引擎——运行时通过 `--url` 接入一个独立安装的
**Strata** 引擎；引擎及其原生后端**不随包分发**，作为运行前置由你自备。

## License · 许可

- The original application-layer code in this repository is released under the
  **[AGPL-3.0 License](LICENSE)** + commercial dual-licensing (see `COMMERCIAL-LICENSE.md`), Copyright (c) 2026 **时空象容**.
- Bundled third-party runtime dependencies and their permissive licenses are listed in
  **[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)**.
- The **Strata** engine is **not bundled** and is **not** covered by this repository's license.
  It is a separate, independently-licensed project used as a runtime dependency; "Strata" is a
  name owned by its authors — this project is *powered by* Strata, not an official Strata product.

本仓库的原创应用层代码以 **[AGPL-3.0 许可](LICENSE)** 发布，并配套**商业双轨授权**（详见 `COMMERCIAL-LICENSE.md`），版权所有 时空象容。
随包的第三方宽松许可依赖见 **[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)**。
**Strata** 引擎**不随包发布**，也不在本仓库许可覆盖范围内——它是作为运行依赖的独立项目；
"Strata" 归其原作者所有，本项目是 *powered by Strata*，非 Strata 官方产品。

### Prerequisites · 前置条件

- **Python 3.14（建议装最新补丁版；最低 3.10）** — 必需。Windows 上 `setup.bat` 会先探测本机已有的
  可用 Python（`py -3` / `where python` / 安装目录扫描），**检测到版本 ≥3.10 就不再下载、也不安装**；
  只有完全找不到可用的 Python 时，它才会静默下载并安装一个 Python 3.14。Linux/macOS 请自备 Python 3.14。
- **Node.js** — *运行本应用层不需要*，它只在你要跑 JS 测试套件（jsdom 门禁 / Playwright e2e）时才需要安装。
  星云白泽运行时是纯 Python，无 Node 依赖。
- **图像模型 / 出图** — 由一个**外部 `sd-cli` 可执行文件**完成（运行时用 `subprocess` 调用它），它**不是 Python
  包、不进 `requirements.txt`**；要使用出图功能请自备一个 Stable-Diffusion CLI。
- **Python 依赖** — 见 `Nebula-agent/requirements.txt`：运行时硬依赖仅 `pillow / psutil / PySocks`（均为预编译
  wheel，无需本机编译器）。`PyYAML / send2trash / strata_tokenizer` 属可选依赖，代码用 try / `find_spec` 优雅
  降级，故有意不列入 requirements。

## Getting started · 开始使用

1. **Clone, then bootstrap the venv once** (a fresh clone has no `.venv`, so the launchers
   fail until this runs): `setup.bat` on Windows, or `bash setup.sh` on Linux/macOS.
   It creates `.venv`, installs the pinned deps (pillow/psutil/PySocks), rewrites config,
   and verifies all servers + the gateway import.
2. Install and run a **Strata** engine (the runtime prerequisite), serving an OpenAI-compatible
   endpoint, e.g. `http://127.0.0.1:8080/v1`.
3. Point this app layer at it via `--url` / model / port (edit `run_standalone.bat`, or pass
   `UPSTREAM_URL=... MODEL=... PORT=... bash Nebula-agent/run_standalone.sh`).
4. Start it: `run_standalone.bat` (Win) / `run_standalone.sh` (Linux/macOS) under `Nebula-agent/`;
   open the local frontend (default http://127.0.0.1:8099).

1. **克隆后先引导一次 venv**（新克隆没有 `.venv`，不跑这步启动脚本会直接失败）：Windows 用 `setup.bat`，
   Linux/macOS 用 `bash setup.sh`。它会创建 `.venv`、安装固定依赖（pillow/psutil/PySocks）、重写配置，
   并校验全部 servers + gateway 可导入。
2. 先安装并运行一个 **Strata** 引擎（运行前置），提供 OpenAI 兼容端点，如 `http://127.0.0.1:8080/v1`。
3. 通过 `--url` / 模型 / 端口把本应用层指向它（编辑 `run_standalone.bat`，或用
   `UPSTREAM_URL=... MODEL=... PORT=... bash Nebula-agent/run_standalone.sh`）。
4. 启动：在 `Nebula-agent/` 下运行 `run_standalone.bat`（Win）/ `run_standalone.sh`（Linux/macOS）；
   在浏览器打开本地前端（默认 http://127.0.0.1:8099）。

## Recovery · 备份恢复

- Backups are rolling git bundles (`--keep 14`), on E: (primary) and F: (mirror) under
  `星云备份\星云白泽备份`. Each carries the full repo (commits + all baseline tags).
- 备份是滚动的 git bundle（`--keep 14`），落在 E:（主盘）与 F:（镜像）的 `星云备份\星云白泽备份`，每个都含全部 commits + 基线 tag。

Clone the newest bundle to restore the repo at any rollback point (commits + tags):
克隆最新 bundle 即可在任意回滚点还原仓库（commits + tags）：

```bat
:: 取最新 bundle 克隆还原（含全部 tag 回滚点），再 checkout 目标 tag
for /f "delims=" %%F in ('dir /b /o-d "E:\星云备份\星云白泽备份\*.bundle" ^| more +0') do (
  git clone "E:\星云备份\星云白泽备份\%%F" restore_dir
  git -C restore_dir checkout v-baseline-2026-11-21-h
  goto :done
)
:done
```

Current newest sample: `strata-bundle-20261121-182344.bundle` (HEAD 48c7338, baseline tag v-baseline-2026-11-21-j).
当前最新样本见上；回滚点示例 tag `v-baseline-2026-11-21-j`。

Rehearsed clone drill · 实测克隆演练（备查）
坐实于 2026-11-21：克隆 bundle `182344` → checkout `v-baseline-2026-11-21-j` → 还原 HEAD `48c7338`（干净回滚点，账本清理块在还原树中可读），逐步 rc 均 0：

```bat
git clone "E:\星云备份\星云白泽备份\strata-bundle-20261121-182344.bundle" restore_dir
git -C restore_dir checkout v-baseline-2026-11-21-j
git -C restore_dir rev-parse HEAD   ·· 应得 48c7338935399a3bd4d7eef13a2524706d45802b
```

---

*Original application layer © 2026 时空象容 · AGPL-3.0 (dual-licensed). Powered by Strata.*
