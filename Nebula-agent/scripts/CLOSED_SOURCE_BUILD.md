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

### 4.5 servers/ 各 MCP 子进程在闭源产物里的分发形态（待拍板，附实测依据）

实测三条硬事实（不是估计）：

1. **形态**：`config/mcp_servers.json` 里 9 个条目（filesystem/shell/websearch/memory/browser/schedule/skillhub/registry + skills/example_server）全部是
   `command=<绝对路径>\.venv\Scripts\python.exe`、`args=<绝对路径>servers\xxx_server.py`——即每个 server 都是 gateway 运行时 **spawn 的独立子进程**，不在 gateway 进程内，所以 Nuitka 编译 gateway **不会**把它们带进二进制。
2. **依赖**：逐个 AST 扫描，8 个 `servers/*.py` 的第三方依赖 = **0**（只有 stdlib + 项目自身模块 `_mcp_base` 等；唯一外部 `socks` 来自已 pin 的 PySocks）。→ 编译它们不需要额外 native 依赖，成本低。
3. **体积基准**：CI 实跑的 macOS 产物 = **20.6 MB**（已含一份 Python 运行时 + 混淆前端 + PIL/psutil native）。

三个形态的取舍：

| 形态 | 做法 | 源码保护 | 体积 | 复杂度 |
|---|---|---|---|---|
| A 各编独立 exe | 每个 server 各跑一次 `nuitka --standalone` | 最强（9 份原生码） | **最差：9 × ≈20 MB ≈ 180 MB**（每个 standalone 都自带完整 Python 运行时） | 高（9 次编译、CI 时间×9） |
| B 随源码带 `.py` | 产物内附 `servers/*.py` + 一份嵌入式 Python 运行时，json 改指产物内相对路径 | 最弱（**server 源码明文可见**） | 好：≈20 MB + 9 个脚本（共约 200 KB） | 低 |
| C **模块编译 `.pyd`**（推荐） | `nuitka --mode=module`（原 `--module`）把每个 `servers/*.py` 编成平台原生 `.pyd/.so`，产物带**一份**嵌入式 Python 运行时，json 的 command 指该运行时、args 指 `.pyd` | 好：`.pyd` 是原生码，等同 gateway 的保护级别，不可反编译回源码 | 好：≈20 MB 运行时 + 9 个几百 KB 的 `.pyd`（总增量约几 MB，远小于 A） | 中：一次 CI 里 9 次 module 编译（module 模式远快于 standalone，不复制运行时） |

**推荐 C**，理由：A 的 180 MB 与 9 倍 CI 时间换来的增量保护≈0（B/C 已不暴露源码）；B 最省事但违背"禁止反编译源码"的初衷——server 层虽薄，也是源码。C 用"一份运行时 + N 个 `.pyd`"同时拿到保护与体积。

落地要点（选 C 后我来做）：
- CI 增加一步：对 `servers/*.py` 批量 `python -m nuitka --mode=module --output-dir=dist/modules`；
- 产物内 `mcp_servers.json` 不能再带绝对路径：改为**首启动生成**（现 `setup_env.py` 已在做"把 command 重写为 venv python"，同一逻辑改成产物内的相对/自定位路径即可，天然可移植）；
- `pagesim/`、`skillhub_catalog.json`、`skills/*.yaml` 等数据目录继续走 `--include-data-dir`；
- 若将来允许"用户自己加 MCP server"，则 `.pyd` 形态会挡住第三方 .py 插件——届时保留 B 作为逃生开关（`--servers=source` 模式产物）。

### 4.6 三平台编译提速（已落地，附前后实测）

编译占闭源 CI 的 95%+ 时长，所以提速只针对两步：`Compile with Nuitka`（gateway）与
`Compile MCP servers to native modules`（3b）。其余步骤（混淆/冒烟/装依赖/打包/上传）合计 <50s。

**改了什么**
- `scripts/build_modules.sh`：3b 的 18 次 `--mode=module` 调用由 for 串行改为分批并发。
  清单只在这一个脚本里维护（`_closed_source_gate.py` 的 G11 锁死这点）；每次 nuitka
  调用的参数语义不变 —— `--mode=module` 一次只吃一个 positional 是 CI 实测的硬约束。
  每路日志各自落 `.build-logs/<path>.log`、退出码落同名 `.rc`，结束后按清单顺序回放并
  点名失败模块：并发不牺牲可诊断性。
- 显式 `--jobs`：分配规则见下。
- `actions/cache` 持久化 `CCACHE_DIR`/`CLCACHE_DIR`/`NUITKA_CACHE_DIR` 三目录（钉到
  `$RUNNER_TEMP/build-cache`）。注入点读 Nuitka 源码 `nuitka/build/SconsCaching.py` 坐实：
  两处都是 `if "…_DIR" not in os.environ` 才自选目录，导出即照用。Windows 走的是 Nuitka
  自带的 **clcache**（不是 ccache），所以两个变量都必须钉。

**实测三轮对照（同仓库、同配方，只有并行度不同；单位秒。基线 run 44755424385 →
第一轮 44772654417 = 统一超发 → 第二轮 44780930155 = 现行的按平台分配）**

| 平台（核数） | 基线（3b 串行、无缓存） | 第一轮：统一超发 3×min(nproc,4) | 第二轮：按平台分配（现行） |
|---|---|---|---|
| Windows（2 核） | gateway 882 / 3b 216 | 1263 / **350（退化）** | 769 / **205** |
| Linux（4 核） | 623 / 519 | 457 / **87** | 57 / **24** |
| macOS（4 核 arm） | 309 / 90 | 223 / 35 | 146 / **22** |
| 该 job 结论 | Win failure(4a)、Linux/macOS failure(3b) | Linux/macOS success | Linux/macOS success |

**怎么读这张表（归因边界要写清，别把缓存的功劳记到并发上）**
- **3b 这一列才是并发的直接效果**，三轮都是同一段代码只改并发：Windows 216→350（超发把
  2 核挤爆）→ 205（按核数封顶后**消除了退化**，且略优于串行基线）；Linux 519→87→24、
  macOS 90→35→22 走的是保留超发那一支，未受影响。
- **gateway 那一列不能整列记给并发**：那一步的参数三轮未变，其升降里混着缓存命中与 runner
  负载噪声（Linux 57s、macOS 146s 同时受第二轮暖缓存影响——见下条的 cache hit 证据）。
  能确定的是"三平台 3b 都优于基线"这一条。
- 第一轮是**建缓存的首跑**，所以它的 gateway 数仍是冷缓存值；第二轮才有 hit 可吃。

**从这三轮坐实的三件事（都已写进 build_modules.sh 的注释与 _closed_source_gate 的 G12）**
1. **runner 规格不对称**：Windows 侧 probe 步打印 `cores=2`、`MemTotal 8.3GB`；Linux/macOS
   是 4 核以上。所以"一个并发度打天下"必然错 —— 同一组 3 路 × min(nproc,4) 在 2 核
   Windows 上变成 4 个 cl.exe 挤 2 核，3b 反而 216→350s；在 4 核 Linux 上是 519→87s。
2. **分配规则改为按平台**：MSVC（`uname -s` 为 MINGW*/MSYS*/CYGWIN*）上
   `jobs = cores // conc`（总 C 编译进程数 ≤ 核数）；gcc/clang 上保留
   `jobs = min(nproc, BUILD_JOBS_MAX)` 的超发，因为实测它是净收益。判据用 `uname -s`
   而不是 `$OS`/`$OSNAME` —— 后者在 Git-bash 里恒为 `Windows_NT`，会让本地验证与真实
   Linux 分支不可分（本轮先判错过一次，靠"四组合 × 桩 getconf/uname"的差分测出）。
3. **ccache/clcache 确实接上了**：第一轮 Windows 日志就出现 `clcache with 2 cache hits`
   （基线从未出现 hit），macOS 出现 `Cached C files (using ccache) … cache hit`；Linux 侧
   基线曾报 `You are not using ccache`，现由 probe 步 best-effort 安装补上。这条收益只在
   **第二次及以后的构建**体现：第一轮是建缓存（所以它的 gateway 反而比基线慢），第二轮才
   吃到 hit —— 这正是表里 Linux 457→57、macOS 223→146 的另一半成因，也是为什么读表要把
   3b 列与 gateway 列分开归因。**Windows 当时不在其列**：下面那次 run 44829615496 查明它的
   `actions/cache` 从未保存成功，所以它每次都是冷编译；表里 Windows 1263→769 那段此后
   只能记作 runner 负载噪声，不是缓存收益（这段归因是 run 44829615496 之后纠正的，原先写错了）。

**再一轮实测：run 44829615496（@SELF 修复 cea0d65 之后；配方零改动，目的就是去验那个修复）**

（上面那张表按"改配方的次数"编号；44829615496 没改配方，所以不参与那个编号，本节下文一律用 run 号称呼它。）

上一段那个"三个 run 全灭在 4a"的问题已被 cea0d65（registry 把 `@SELF` 解析成磁盘上真实
存在的程序）收口，44829615496 就是它的验收跑。顺带第一次拿到了**跨 run 暖缓存**的真数据。时长口径
同前表：runner 自己记的 started_at/completed_at，不是猜的。

| 平台 | gateway / 3b（44829615496） | actions/cache 那一侧发生了什么 | 该 job 结论 |
|---|---|---|---|
| Linux | 74s / **24s** | **HIT**：`Cache restored from key: build-cache-Linux-py3.13-44780930155`，post 保存 `Cache saved with key …44829615496` | success |
| macOS | 160s / **27s** | **HIT**：`… build-cache-macOS-py3.13-44780930155`，同样保存成功 | success |
| Windows | **1187s / 304s** | `Cache not found`（连续第 7 次），且 post 保存步整排 `skipped` | failure（换了一步） |

**这一轮坐实的三件事**
1. **`@SELF` 修复确实起效**（那次 run 的主目的，判据是"以前全灭的那一步现在逐项绿"）：同一个
   Windows job 里 `ENTRIES: GREEN 9 servers -> entries.dist (all command/cwd as @SELF/@ROOT)`、
   `VERIFY: GREEN … 匹配 @SELF/@ROOT 形态`、`compiled *_server.pyd present: 9 (want 9)`、
   `== 1. CLI parses == OK`，六个 run 都出现的 `[WinError 2]` 不再出现。失败点整体**前移**
   到了此前根本执行不到的地方——修复有效的最强证据不是"绿了"，而是"错误换了"。
2. **下一层根因是控制台编码，与产物无关**：冒烟在 44829615496 里真把 gateway 拉起来了，它却在
   `http_server.py` 往 stderr 写含 `→` 的日志时抛
   `UnicodeEncodeError: 'charmap' codec can't encode character '\u2192'`（Windows runner 的
   控制台是 cp1252），进程随即退出、从未监听端口。即 .pyd 齐、config 形态对、入口解析通
   三层都已打通，卡在"往被接管的管道写非 ASCII"。修法：启动期把 stdout/stderr 兜成
   UTF-8 + `errors='replace'`，让编码永远不该掀翻服务（下一轮做）。
3. **Windows 的构建缓存从来没保存成功过，跨 run 对它无效**：仓库现存 5 个缓存条目，键名
   清一色 `build-cache-Linux-*` / `build-cache-macOS-*`，**一个 `build-cache-Windows-*` 都没
   有**。机制在日志里读实：保存动作发生在 job 结束后的 post 步，而 Windows job 一旦以
   exit 1 失败，post 保存步就整排被 `skipped`（44829615496 的 step 27–30 即如此）——于是"建不起缓存
   → 下一次必然冷 → 更容易被判失败"自成闭环。44829615496 的 Windows 1187s 比上一个 run（44780930155）的 769s 还慢，也印证了
   它没有 hit 可吃。**顺序结论：先修失败步，Windows 才会第一次真正用上缓存**，别反过来
   为了提速去调缓存参数。顺带记下产物里还有 19 个 `*.build/scons-debug.py` 混进 .py 清单
   （WARN "should be zero"），属打包排除项，与该 run 的失败无关。

**没做的**：GPU 加速方向已排除 —— cl.exe/gcc/clang 的编译过程不使用 GPU，且 GitHub hosted
runner 没有 GPU；三平台发布要的是三台不同 CPU 架构的机器，不是显卡。
## 五、产物边界

`dist/`、`gateway.build/`、`gateway.dist/` 都是**构建期再生型临时产物**，已在仓库根 `.gitignore` 忽略，绝不入库、也不代表源码。

## 六、发布到 GitHub 并触发三平台 CI（首选：一条命令，无需打开网页）

本机实测：无 gh CLI、Windows 凭据管理器里 GitHub 条目为 0、无 GH_TOKEN、工具侧无头
浏览器无登录态——**但 api.github.com 从本机可达**。因此不必去网页点 Create：只要一个
PAT，`tools/_gh_publish.py` 就能经 REST API 全程代办（建仓 → remote → push → 打 tag 触发 CI）。

```bash
# 一次性：设好凭据（classic PAT，scope 勾 repo + workflow）
set GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# 预览要做什么（不联网写、不改 git 配置）——已实测可用
python Nebula-agent\tools\_gh_publish.py --owner <你的GitHub登录名> --dry-run --tag v0.1.0 --private

# 真发布：建【空】仓库 NebulaBaize(auto_init:false，故不会生成 README/.gitignore/LICENSE，
# 也就不会 push 冲突；LICENSE 由仓库自带) → 加/改 remote → push master → push tags(v* 即触发 CI)
python Nebula-agent\tools\_gh_publish.py --owner <你的GitHub登录名> --tag v0.1.0 --private
```

脚本性质（已 py_compile + dry-run + 无 token 守门 三项实测）：**幂等**（仓库已存在则跳过
创建）、**日志绝不回显 token 本体**、无 token 时以 rc=2 守门退出、可反复重跑。

### 怎么拿到 owner 与 PAT

- **owner**：你 GitHub 账号的登录名，就是浏览器地址栏 `https://github.com/<这一段>` 里那一段。
- **PAT**：GitHub → Settings → Developer settings → **Fine-grained / Personal tokens** →
  Personal traditional (classic) → 勾 scope **`repo` + `workflow`** → 生成后复制（只显示一次）。
  直达：<https://github.com/settings/tokens/new?scopes=repo,workflow>

CI 跑完后去 `https://github.com/<owner>/NebulaBaize/actions` 看三平台日志；按某平台的
Nuitka stderr 回到本文件第四节校准 `--include-package` / `--include-data-dir`，再重跑同一
条命令即可（幂等，只 push 增量）。

<details><summary>手工替代路径（无 PAT 时）</summary>

```bash
# 网页建一个【空】仓库（README/.gitignore/license 三项都不勾，否则 push 冲突），然后：
git remote add origin https://github.com/<owner>/NebulaBaize.git
git push -u origin master
git tag v0.1.0 && git push origin v0.1.0      # 推 v* tag 即触发 build-release.yml
```
或已装 gh 时手动触发：`gh workflow run build-release.yml`。
</details>
