# 星云白泽 · Nebula Baize

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
|  gateway · runtime · skills · scheduler · memory · tools   |      (MIT, (c) 2026 时空象容)
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
  **[MIT License](LICENSE)**, Copyright (c) 2026 **时空象容**.
- Bundled third-party runtime dependencies and their permissive licenses are listed in
  **[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)**.
- The **Strata** engine is **not bundled** and is **not** covered by this repository's license.
  It is a separate, independently-licensed project used as a runtime dependency; "Strata" is a
  name owned by its authors — this project is *powered by* Strata, not an official Strata product.

本仓库的原创应用层代码以 **[MIT 许可](LICENSE)** 发布，版权所有 时空象容。
随包的第三方宽松许可依赖见 **[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)**。
**Strata** 引擎**不随包发布**，也不在本仓库许可覆盖范围内——它是作为运行依赖的独立项目；
"Strata" 归其原作者所有，本项目是 *powered by Strata*，非 Strata 官方产品。

## Getting started · 开始使用

1. Install and run a **Strata** engine (the runtime prerequisite), serving an OpenAI-compatible
   endpoint, e.g. `http://127.0.0.1:8080/v1`.
2. Point this app layer at it via `--url` (see `run_standalone.bat`) and set your model.
3. Start it; open the local frontend in your browser.

1. 先安装并运行一个 **Strata** 引擎（运行前置），提供 OpenAI 兼容端点，如 `http://127.0.0.1:8080/v1`。
2. 通过 `--url`（见 `run_standalone.bat`）把本应用层指向它并配置模型。
3. 启动后在浏览器打开本地前端。

---

*Original application layer © 2026 时空象容 · MIT. Powered by Strata.*
