# 星云白泽闭源三平台构建配方（草案）

把"工作区里能改源码的开源版"和"发给别人、禁止反编译源码的闭源版"在物理上分成两条线。
一句话原则：**所有闭源动作都发生在 `serve/web/` 与 `runtime/` 的一份【副本】上，权威源零改动。**

## 一、为什么闭源、用什么

| 部分 | 能否闭源到"禁止反编译源码" | 手段 | 结论 |
|---|---|---|---|
| Python 后端（gateway/serve/runtime/servers…） | ✅ 能 | **Nuitka** 编译成 C→原生机器码，产物无 `.pyc`，反编译还原源码极难 | 闭源主力，本配方编译它 |
| 前端 `serve/web/*.js` | ⚠️ 不能编译成二进制（浏览器必须读明文 JS） | **minify + 混淆**：可读性极低、反出可读源码代价高，但严格说不是"禁止查看" | 提高门槛，非密码级保护 |

> PyInstaller 不满足"禁止反编译"——它本质把 `.pyc` 字节码打进包，反编译容易。故选 Nuitka。

## 二、隔离架构（关键：源码版永不被污染）

```
开发/源码版（本工作区）
  serve/web/        ← 明文 app.js，可读可改，源码版实例直接 serve 这份。【权威源，闭源流程绝不写它】
  runtime/ ...      ← 明文 Python，可改可调试。【同样不被闭源流程改写】

闭源发布版（CI 里现场生成，用完即弃）
  1. 复制 serve/web/  →  dist/web/      （整体拷贝，目录结构不变）
  2. 只对 dist/web/ 内的 .js 跑混淆    （scripts/obfuscate_web.js，带 src==out 卫语句）
  3. Nuitka 编译 runtime/gateway.py，把【混淆后的 dist/web】作为 data 一起打包
  4. 产出 gateway.dist/ → 压成 nebula-baize-<os>.zip/tar.gz 作为 artifact
```

混淆脚本是"读入 → 写到另一个输出路径"的单向构建步骤，**不回头改源文件**；它自带卫语句拒绝 `src == out` 的就地误用。因此源码版前端自始至终是 `serve/web/` 那份明文。

## 三、为什么放在 CI 而不是本机

本机（Windows）实测：无任何 C 编译器（无 MSVC/MinGW），且网络下载常损坏（`--zig` 下载的 zig、`--onefile` 的 depends.exe 都下载失败，与 pip 超时同源）。
已坐实：Nuitka 4.3.5 在 **Python 3.14** 上能把 gateway 整棵导入图翻译成 46 个 `.c`、零 unsupported——**闭源不必为 3.14 降级 Python**。
缺的只是一台"自带 C 编译器 + 网络好"的机器：`windows-latest` 自带 MSVC，`ubuntu/macos` 自带 gcc/clang。GitHub Actions 三平台矩阵一次解决"装编译器"和"三平台产物"两件事，绕开本机网络。

## 四、已知坑 / 待 CI 实跑校准（诚实标注，CI 真绿前视为未验证）

- **Python 依赖不写死**：本仓库无 `requirements.txt`，且实测出现 `yaml` 是 gateway 硬 import、却未出现在本机 `pip freeze` 的矛盾。配方里依赖由 `setup_env.py`/冻结清单在 CI 内生成，`pip install` 行只兜底、不臆造新依赖。**建议补一份权威 requirements/依赖清单**以免 CI 漂移。
- **Nuitka 打包参数需首跑校准**：`--include-package` / `--include-data-dir` 的覆盖范围（MCP servers 子进程 `servers/` 是独立脚本、运行时拉起，当前配方未把它们编进 gateway 二进制）需按 CI stderr 报错微调。
- **入口是 gateway，不是整应用**：星云是多进程（gateway + 各 MCP server 子进程 + 外部 native 引擎）。当前只编译了 gateway 主进程；servers 子进程如何随产物分发（各自 also Nuitka 编译？还是随源码带？）**待你拍板后补**。
- **前端混淆后请人工冒烟**：app.js 700KB 单文件，minify 后建议 CI 加一步 smoke（加载页面断言无语法错），防混淆器对极端代码误处理。

## 五、产物边界

`dist/`、`gateway.build/`、`gateway.dist/` 都是**构建期再生型临时产物**，已在仓库根 `.gitignore` 忽略，绝不入库、也不代表源码。

## 六、拿到 GitHub 远端后的推送与触发（本机当前无 remote / 无 gh / 无 token，需主人提供其一）

workflow 触发方式是 `on: push tags v*` 或 `workflow_dispatch`（手动）。推送一次即触发，
或推一个 tag 触发：

```bash
# 0) 先在 GitHub 建一个【空】仓库（不要勾选自动初始化 README/.gitignore，否则 push 会冲突）
# 1) 绑定远端并推送当前分支（master）——首次 push 即触发 workflow_dispatch 之外的 tag 构建需另打 tag
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin master
# 2) 触发闭源三平台构建（打版本 tag）
git tag v0.1.0
git push origin v0.1.0
# 之后可在 GitHub → Actions → build-closed-source 看三平台日志；按某平台的 Nuitka
# stderr 回到本文件第四节校准 --include-package/--include-data-dir，再 push 更新 tag。
```

或用 `gh` 手动触发（免打 tag）：`gh workflow run build-release.yml`。
