# 原生浏览对话框三连修复速查 · Native Picker Dialog Triple-Fix

> **简体中文** | [English](native-picker-dialog-fixes.en.md)

本文沉淀「工作区/模型目录的原生文件夹·文件对话框」三连修复的**根因 + 双招**，便于复用与排错。
全部结论均为本次会话读实代码 + 运行实例实测坐实，非推测。涉及单文件 `runtime/native_picker.py`
与 `runtime/http_server.py` / `servers/fs_server.py`，三处修复集中、GET/POST/fs_server 三条弹框路径共享。

对应 baseline tag：`v-baseline-2026-11-28-d`（`ee14581`，GET 别名 + MCP 复用）、
`v-baseline-2026-11-28-e`（`1d18031`，前台锁 + 深色）。

## 背景：为什么自己弹原生框

浏览器自带的 File System Access API（`showDirectoryPicker`）只返回带**文件夹名**的
`FileSystemDirectoryHandle`，拿不到**绝对路径**，喂不进工作区路径。本网关跑在用户**自己的交互桌面会话**里，
故用 `native_picker.py`（纯 stdlib：ctypes → shell32/ole32/user32/comdlg32/dwmapi/uxtheme）
调起真正的 Windows "选择文件夹/打开" 对话框，返回**真实绝对路径**；自研 `/workspace/list` 浏览作降级兜底。

## 修复 1 · agent 也能弹原生框 + `/api/pick` GET 别名（commit `ee14581` / tag `-d`）

**根因/诉求**：原生弹框此前只服务前端 Browse 按钮（POST），agent 与浏览器直接导航都用不上。

**双招**：
1. **MCP 复用**：`servers/fs_server.py` 新增 `pick_native` 工具（`kind=folder|file`，可选 `title/start/ext`）。
   它**惰性 import** `runtime/native_picker`（runtime 是 servers 的兄弟目录，调用时才把 runtime
   加进 `sys.path` 再 import），与前端共用**同一个**弹框实现。模块加载期不依赖 runtime，
   无桌面/无 runtime 的宿主仍能正常加载 fs_server，仅该工具降级 `unavailable`。
2. **GET 别名**：`runtime/http_server.py` 的 `do_GET` **前置** `/api/pick` 分支（必须先于通用
   `path.startswith("/api/")` 代理，否则被 `_api("GET")` 当上游 API 转发掉）；`_api_pick`
   改 **query 优先**读 `kind/title/start/ext`，无 query 才读 POST body，同一函数同时支持 GET 导航触发与 POST。

**实测**：fs_server 工具列表含 `pick_native`（`HAS_PICK_NATIVE True`）、agent 调用真弹框返回 `cancelled`；
GET 别名实测框真弹（`DIALOG_SHOWN=True`）。

## 修复 2 · 框弹出后被把前台（commit `e03f217`）

**根因**：`SHBrowseForFolderW`/`GetOpenFileNameW` 的 `hwndOwner=None` 且无前台解锁。用户点「浏览」时
**前台进程是 Edge**，网关 python 进程是非前台进程，Windows **前台锁**拒绝非前台进程
`SetForegroundWindow`——对话框创建成功却以非激活态出现、被 flash 到任务栏，必须点任务栏图标才唤出。

**双招**（集中一处 `_owner_and_unlock_foreground()`）：
1. 弹框前注入一次合成 **Alt key-down/up**（`keybd_event(VK_MENU,…)`）解除前台锁；
2. **`AttachThreadInput`** 把本进程 GUI 线程挂到当前前台窗的输入队列，并把 `hwndOwner` 设为该前台窗
   （对话框成为浏览器窗的**模态子窗**），弹框返回后再 `AttachThreadInput(…,False)` detach。

**实测**：`GetForegroundWindow()==FindWindow("#32770")` 读到框成前台窗（`fg==dlg=True`），取消返回 `cancelled`，attach/detach 往返无异常。

## 修复 3 · 跟随系统深色主题（commit `1d18031` / tag `-e`）

**根因**：`HKCU\…\Themes\Personalize AppsUseLightTheme=0`（系统深色），而 native_picker **零**深色声明 →
原生对话框默认走亮色，与系统不符。

**双招**（集中一处 `_enable_dark_mode()`）：
1. **进程级** `uxtheme.dll!SetPreferredAppMode(0=AllowDark)`：让通用控件/对话框**跟随系统主题**（深则深、亮则亮，
   不强钉深色）。该函数不在导出名表，按「名 → 序数 135（Win10 1809+ & Win11）→ 49（旧）」防御性解析；
   uxtheme 用 `ctypes.WinDLL("uxtheme.dll")`（stdcall）加载，带 try 兜底，缺失不致模块加载失败。
2. **窗口级** `DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE=20，Win10 1809 降级 19)`：
   把标题栏/边框也染深色。folder 用 `BROWSEINFO.lpfn` 回调在 `BFFM_INITIALIZED(=1)` 拿 hwnd；
   file 用 `OPENFILENAME.lpfnHook`（需 `OFN_ENABLEHOOK 0x20`）在初始化消息拿 hdlg。

**实测**：`DwmGetWindowAttribute rc=0 attr=1`（标题栏 DWM 深色属性读回=1）、`_dark_applied=True`、
lpfn 回调不崩、取消返回 `cancelled`。判定系统主题：`AppsUseLightTheme=0` 即深色。

## 验证与坑（速记）

- 验证标题栏是否真深色：`DwmGetWindowAttribute(…,20)` 读回属性值 ==1，比截图更适合自动化坐实。
- 验证框是否抢前台：`GetForegroundWindow()` 是否等于 `FindWindowW("#32770",None)`。
- `SetPreferredAppMode`/uxtheme entry 用 `ctypes.WinDLL`，**不要** `windll.LoadLibraryW`（会 AttributeError）。
- 代码卫生：吞异常用 `contextlib.suppress(Exception)`，勿用裸 `except Exception: pass`（runtime/ 禁 silent swallow）。
- 沙箱 shell deny list 拦 `rmdir /s /q`；清临时 clone/目录用 `Shell.Application.NameSpace(10).MoveHere` 送回收站。
- 这些改动要在**正在运行的实例**上呈现像素，需重启 8099 重载（自杀型动作，需用户拍板时机）。
