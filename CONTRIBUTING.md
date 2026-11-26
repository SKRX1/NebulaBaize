# 贡献指南 / CONTRIBUTING

> **简体中文** | [English](CONTRIBUTING.en.md)

感谢你对星云白泽（Nebula Baize）的关注！本指南说明贡献流程、许可证前提、与代码/文档规范。

---

## 1. 许可证前提（必读）

星云白泽采用 **AGPL-3.0 开源 + 商业双许可（Dual Licensing）**：

- **公众轨**：`LICENSE`（AGPL-3.0-only）授权给公众与个人自托管用户。
- **企业轨**：`COMMERCIAL-LICENSE.md` 给企业发放免除 AGPL 传染义务的付费商业授权。

要让著作权人（时空象容）能继续向你购买者发放商业授权、维持项目变现，
**所有贡献必须配套签署 CLA**。这是双许可模式的唯一硬前提。

→ 请阅读并签署 [`CLA.md`](CLA.md)（宽松 permissive CLA 模板）。

贡献者保留其贡献的版权，著作权人获得在 AGPL 之外再授权（含商用）的**非独占**权利——
不强制转让版权，对**个人贡献者摩擦最小**，符合开源惯例（Kernel / jQuery / Angular 等
采用类似 permissive CLA 模型）。

---

## 2. 贡献流程

1. **先开 issue**：新功能、bug 修复、文档改进，请先开 issue 简述动机，与作者对齐范围，避免做无用功。
2. **分支与 commit**：从 `main` 切分支，提交前在本地跑全套回归（见 §5）。commit message 用英文，描述 + 正文（中文允许作背景说明）。
3. **CLA 签署**：首次贡献请在 PR 描述中确认 "I have read and agree to the CLA"（一次性，覆盖你后续所有贡献；若代码归属变化需重签）。
4. **PR 评审**：作者 48h 内响应；评审通过 squash merge 进 main。
5. **回滚点**：基线 tag 命名 `v-baseline-YYYY-MM-DD-字母`（仓库现行约定）。

---

## 3. 代码与前端规范

### 3.1 后端（Python）
- 标准库优先，硬依赖仅 pillow / psutil / PySocks（见 `requirements.txt`）。
- 任何 Windows 专属调用必须包 `sys.platform == "win32"` 卫语句，POSIX 走降级路径。
- `except` 体**禁止**只 `pass`/`continue`（会被 `tests/test_code_hygiene.py` 计入 silent-swallow 棘轮）。
- 新增路由加测试时用 `STRATA_*` 环境变量隔离数据文件（照 `STRATA_INTERRUPT_LOG` 惯例）。

### 3.2 前端 `serve/web/`
- **唯一权威源**：`serve/web/` 是权威；不要碰 Strata-main 镜像副本。
- 改动 `app.js` / `i18n.js` 用**锚点编辑脚本**（命中数 ≠ 1 即报错退出）。
- `app.js` 是 CRLF；改完必归一 CRLF；`node --check` 验语法。
- 新增 `data-i18n` 键：**中英成对**（`tests/test_i18n.mjs` 强制键数一致）。
- CSS 只用 `var(--st-*)` token，禁止硬编码颜色（暗/亮双主题免维护）。
- 全局零 inline handler（`onerror=`/`onclick=`），降级路径走纯 CSS。
- 表单弹窗（含正在填的输入）**禁止** backdrop「遮罩即关」：`.st-modal` 是 `fixed inset:0` 全视口遮罩，卡片外任意一点都属于 modal 本身，一次误点会丢掉正在填的整张表单。关闭只走显式路径（完成 / 取消 / ×）**+ Esc**；新建表单弹窗若没有 Esc 必须补上（删遮罩即关后否则无任何键盘出口）。纯查看器（如 `#img-modal` 灯箱）仍可遮罩即关——它没有丢数据风险。该约定由静态门禁 `tests/test_form_modal_close.mjs`（含 decoy）锁定。
- 每个弹窗都必须有**可见的关闭按钮**（右上角 ×，`id="<modal>-close"`，`aria-label`）。其 `<use href>` 图标 **必须在 `sprite.svg` 中真实存在**——引用不存在的 id（如 `i-xmark`）会让 `<use>` 解析不到、按钮渲染成空白、视觉上"没有关闭按钮"。关闭图标统一用项目既有 `i-chevron`（`.st-modal__head .st-icon` 已 rotate 成关闭叉），勿另造 sprite 里没有的图标名。弹窗还须做**焦点陷阱**（打开后 Tab 只在弹窗内循环；勿用 `offsetParent` 过滤——jsdom 下恒为真，应改 `!closest('[hidden]')`）+ **关闭后把焦点归还触发它的按钮**（开弹窗前记 `document.activeElement`，关时若其仍在文档内则 `.focus()`），保证键盘/读屏用户不被丢到页首。

### 3.3 i18n
- 文案：中文 + 英文两侧 + 静态 HTML 兜底文本三处同步。
- `data-i18n-attr` 多属性分隔符是逗号（`"placeholder:key,title:key"`），不是竖线。

### 3.4 测试
- 全套回归：`python tools\run_tests.py`，约 190 项，ALL GREEN 才可 commit。
- 新增测试：登记进 `Nebula-agent/tools/run_tests.py` 的 `SUITES` 列表，写明锁什么。

---

### 3.5 改动生效方式

一段代码改动能不能免重启生效，取决于它跑在哪个进程、是不是常驻：

- **前端** `serve/web/*`：静态每次请求读盘，**硬刷浏览器即可**，不必重启。
- **MCP 子进程** `servers/*.py` 或 `mcp_servers.json` 的 env/args：点 MCP 面板「重载子进程」（= `_reload_executor` 重读 json + 重新 spawn 全部子进程）**免重启**生效；子进程 env 在 spawn 时一次性注入。
- **后端网关进程** `runtime/*.py`、`serve/*.py` 的新路由/新逻辑：网关进程 import 时已编进内存，**必须重启 8099**，「重载子进程」救不了它。

**贡献取向（主人拍板，plan A）**：易变的业务逻辑优先写成 `servers/` 里的 **MCP server 工具**（住 `servers/`，改后 reload 即热生效、不碰网关）；只有不得不进网关进程的核心（路由骨架 / 鉴权 / 流式转发骨架）才接受重启 8099。

「重载子进程只换子进程、不换网关进程」这条事实由前端门禁 `tests/test_mcp_reload_jsdom.mjs` 锁定（reload 只 POST 子进程端点 `api/servers/reload`、成功后不整页导航）。

---

## 4. 提交范围

只 add 本轮相关代码/文档/测试；以下**不裹入** commit：

- 运行态漂移：`config/image_gallery.json`、`fs_allowed_roots.txt` 等。
- 别工作线成果：RULES.md 等共享文件用 `git add -p` 拆分 hunk。
- 脚手架脚本：用完送 Windows 回收站（绝不物理删）。
- `.gitignore` 已忽略项（`data/`、`.venv/`、`node_modules/` 等）不动。

---

## 5. 测试入口

```bat
:: 全套回归（约 190 项 ALL GREEN 才可 commit）
python Nebula-agent\tools\run_tests.py

:: 单跑某测试
python Nebula-agent\tools\run_tests.py --only test_xxx.py
node Nebula-agent\tests\test_xxx.mjs
```

---

## 6. 联系

- Issue / PR 在本仓库；商业授权合作请走 `COMMERCIAL-LICENSE.md`。
- 行为准则：Contributor Covenant v2.1（简明版：尊重、建设性、不人身攻击）。
- sk0327@qq.com

---

*Original application layer © 2026 时空象容 · AGPL-3.0 (dual-licensed). Powered by Strata.*
