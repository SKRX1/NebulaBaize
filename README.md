# 星云白泽 · Nebula Baize
[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE) [![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-pink.svg)](https://github.com/sponsors/SKRX1)

> 一个原创的**应用层**智能体——网关、运行时、技能、记忆与 Web 前端，
> 底层 **powered by Strata** 推理引擎。

**作者：** 时空象容

> 语言 / Language：**简体中文**（本仓库默认语言，与软件默认语言一致） | [English](README.en.md)
>
> ℹ️ GitHub 仓库主页对所有访客都只渲染默认分支上的裸名 `README.md`，**不会**按浏览器语言自动切换；因此中文（zh-Hans）访客打开主页看到的就是本页中文默认版，需要英文请点上方 English。

---

## 架构

一张图说清楚"本仓库发布什么"与"它跑在什么之上"：

```
+--------------------------------------------------------+
|  星云白泽 / Nebula Baize   （本仓库）                    |   <- 原创应用层
|  网关 · 运行时 · 技能 · 调度 · 记忆 · 工具                 |      (AGPL-3.0, © 2026 时空象容)
|  Web 前端 (serve/web)                                   |
+--------------------------------------------------------+
                          |
                    --url （HTTP / OpenAI 兼容接口）
                          |
                          v
+--------------------------------------------------------+
|  Strata 推理引擎   （运行前置，不随包发布）               |   <- 运行依赖
|  原生后端：src · include · metal · sycl · third_party   |      （由其作者独立许可）
+--------------------------------------------------------+
```

箭头 `--url` 是两者之间**唯一**的连接。本仓库 = 只有上面那个框。

---

## 这是什么

星云白泽（Nebula Baize）是本项目的**原创应用层**：智能体网关、运行时、技能、调度、记忆子系统、
工具与 Web 前端。这部分代码是为星云白泽原创撰写，也正是本仓库所发布的内容。

它**不是**推理引擎。运行时它通过一个网络端点（`--url http://127.0.0.1:8080/v1`）接入一个独立安装的
**Strata** 引擎。Strata 引擎及其原生后端**不随本版本分发**——它们是运行前置，由你自备。

## 功能特点

一个完全在你自己机器上运行、且可自选模型的本地优先智能体：

- **本地优先的网关 + 智能体循环。** 一个 OpenAI 兼容的网关（`runtime/`）在本地跑完整的工具调用
  智能体循环。你的文件、命令与对话都留在本机。
- **适配任意模型。** 既可指向本地的 **Strata** 引擎（含视觉），也可在网页 UI 里添加任意
  OpenAI 兼容的云端端点（密钥只存服务端，即时生效无需重启）。只要云端模型支持 function-calling，
  它能调用同样的本地工具。
- **约 36 个本地工具（经 MCP）。** 文件、命令、浏览器、联网搜索、调度、记忆、技能注册表等——
  全部在本地执行，不在云端沙箱里。
- **无框架的 Web 界面。** 前端（`serve/web/`）是纯 HTML/JS，无外部网络依赖，直接由网关在
  `http://127.0.0.1:8099` 提供。
- **技能与可扩展的工具面。** 添加 MCP 服务器/技能，并让智能体提议新技能；一切都被登记、审计、可还原。
- **会累积的记忆。** 你越用，它越贴合你的工作流——见下方[越用越聪明](#越用越聪明)，
  机制细节见[完整记忆与经验指南](docs/MEMORY-GUIDE.md)。
- **自愈式启动器。** 双击即启动网关看门狗，持续保活 8099（崩溃自愈重启循环），且绝不强加一个
  你未必需要的推理引擎。
- **可复现、可审计。** 一整套回归（jsdom 门禁 + Python 测试）同时守护前端与后端；删除送系统回收站，
  且用滚动 git bundle 在打了 tag 的回滚点上备份整个仓库。

## 开始使用

1. **克隆后先引导一次 venv**（新克隆没有 `.venv`，不跑这步启动脚本会直接失败）：Windows 用
   `setup.bat`，Linux/macOS 用 `bash setup.sh`。它会创建 `.venv`、安装固定依赖（pillow/psutil/PySocks）、
   重写配置，并校验全部 servers + gateway 可导入。
2. 先安装并运行一个 **Strata** 引擎（运行前置），提供 OpenAI 兼容端点，如 `http://127.0.0.1:8080/v1`。
3. 通过 `--url` / 模型 / 端口把本应用层指向它（编辑 `run_standalone.bat`，或用
   `UPSTREAM_URL=... MODEL=... PORT=... bash Nebula-agent/run_standalone.sh`）。
4. 启动：Windows 双击 `星云白泽.bat` 会启动一个按需拉起网关的看门狗；或直接在 `Nebula-agent/` 下运行
   `run_standalone.bat` / `run_standalone.sh`。在浏览器打开本地前端（默认 http://127.0.0.1:8099）。

### 前置条件

- **Python 3.14（建议装最新补丁版；最低 3.10）** — 必需。Windows 上 `setup.bat` 会先探测本机已有的
  可用 Python（`py -3` / `where python` / 安装目录扫描）；**检测到 ≥3.10 就不再下载、也不安装**——
  只有完全找不到可用 Python 时，它才会静默下载并安装一个 Python 3.14。Linux/macOS 请自备 Python 3.14。
- **Node.js** — *运行本应用层不需要*，它只在你要跑 JS 测试套件（jsdom 门禁 / Playwright e2e）时才需要。
  星云白泽运行时是纯 Python，无 Node 依赖。
- **图像生成** — 由一个**外部 `sd-cli` 可执行文件**完成（运行时经 `subprocess` 调用）。它**不是 Python
  包、也不在 `requirements.txt` 里**；要使用出图功能请自备一个 Stable-Diffusion CLI。
- **Python 依赖** — 见 `Nebula-agent/requirements.txt`：运行时硬依赖仅 `pillow / psutil / PySocks`
  （均为预编译 wheel，无需本机编译器）。`PyYAML / send2trash / strata_tokenizer` 属可选依赖，代码用
  `try` / `find_spec` 优雅降级，故有意不列入 requirements。

## 越用越聪明

星云白泽持有一份**由你拥有、可审计的记忆**——它不藏在模型的权重里。每次对话都可能把可复用的知识
沉淀进三个相互独立、由用户门控的库，并在后续轮次里被注入上下文，于是智能体会逐步学会你的文件布局、
构建命令、命名规则与已知易错点：

- **工作规则（Rules）**——你确认过的稳定操作约定（目录/文件布局、构建部署命令、审批模型、反复出现的坑）。
- **知识库（Knowledge）**——已确认的事实、接口怪癖、环境结论（工具链行为、版本）。
- **经验库（Experience）**——简短的任务复盘（"上下文 → 决策 → 结果 → 复盘"）。

**机制（与实现逐字一致）：**

- 一个记忆 MCP 服务器（`servers/memory_server.py`）暴露 `recall`（按关键词检索跨会话记忆）、
  `ingest` / `forget` / `sources` / `read_source`（学习并管理参考文档）。检索跑在一个**情节存储**
  （`data/episodic.jsonl`）与一个**语义存储**（`data/semantic.db`）之上，两者均为纯标准库实现。
- 写入**刻意由用户门控**。模型不能把事实直接写进数据库；每一次沉淀都要经 `propose-*` 围栏进入
  分域、可审计的三库系统，作为新条目写入且你可**一键撤销**，并尊重你的自动记忆开关。自动沉淀也可能
  在任务后向语义存储回灌——仍可被检索，仍由你审阅。
- 净效果：确认过的约定在之后每次对话都生效，走错的方向一键即可还原，没有任何东西被悄悄固化。

完整机制、三库生命周期，以及如何做策展，见**[完整记忆与经验指南](docs/MEMORY-GUIDE.md)**。

## 许可

- 本仓库的原创应用层代码以 **[AGPL-3.0 许可](LICENSE)** 发布，并配套**商业双轨授权**（详见
  `COMMERCIAL-LICENSE.md`），版权所有 2026 **时空象容**。
- 随包的第三方运行时依赖及其宽松许可列于 **[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)**。
- **Strata** 引擎**不随包发布**，也**不**在本仓库许可覆盖范围内。它是作为运行依赖的独立许可项目；
  "Strata" 名称归其作者所有——本项目 *powered by* Strata，并非 Strata 官方产品。

## 备份恢复

- 备份是滚动的 git bundle（`--keep 14`），落在 E:（主盘）与 F:（镜像）的 `星云备份\星云白泽备份`，
  每个都含全部 commits + 基线 tag。

克隆最新的 bundle 即可在任意回滚点还原仓库（commits + tags）：

```bat
:: 取最新 bundle 克隆还原（含全部 tag 回滚点），再 checkout 目标 tag
for /f "delims=" %%F in ('dir /b /o-d "E:\星云备份\星云白泽备份\*.bundle" ^| more +0') do (
  git clone "E:\星云备份\星云白泽备份\%%F" restore_dir
  git -C restore_dir checkout v-baseline-2026-11-21-h
  goto :done
)
:done
```

当前最新样本：`strata-bundle-20261121-182344.bundle`（HEAD 48c7338，基线 tag v-baseline-2026-11-21-j）。

实测克隆演练（备查）
坐实于 2026-11-21：克隆 bundle `182344` → checkout `v-baseline-2026-11-21-j` → 还原 HEAD `48c7338`
（一个干净回滚点；账本清理块在还原树中可读），每一步 rc 均为 0：

```bat
git clone "E:\星云备份\星云白泽备份\strata-bundle-20261121-182344.bundle" restore_dir
git -C restore_dir checkout v-baseline-2026-11-21-j
git -C restore_dir rev-parse HEAD   :: 应得 48c7338935399a3bd4d7eef13a2524706d45802b
```

---

*原创应用层 © 2026 时空象容 · AGPL-3.0（双许可）。Powered by Strata。*
