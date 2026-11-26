# 代理端口一致性（websearch STRATA_PROXY）

> **简体中文** | [English](proxy-port-consistency.en.md)

锁定的事实：**`config/mcp_servers.json` 里 websearch 的 `env.STRATA_PROXY` 端口，必须等于
本机代理软件实际监听的端口**。换机器或换代理端口时，这一处对齐即可定位搜索/下载的回退链路问题。

## 为什么单独成页

代理端口是**三处各存一份**的交叉配置，历史上多次因此踩坑（7897 失效 vs 7890 实际监听）：

| 处 | 位置 | 说明 |
|---|---|---|
| **websearch 回退代理** | `config/mcp_servers.json` → `mcpServers.websearch.env.STRATA_PROXY` | 前端 Tools 页代理卡写入；executor spawn 子进程时固化进 env |
| **git 代理** | `git config http.proxy` / `https.proxy` | git 自己独立一层，与系统/mcp 代理不同源 |
| **系统代理** | WinINET / 代理软件 mixed-port | 浏览器与系统级流量走这条 |

三处彼此独立，改其一不会自动带动其余——这是「端口看着是 7890 但 git/搜索仍撞旧端口」的根因。

## 当前真值（实测坐实）

- 本机代理软件实际监听 **`127.0.0.1:7890`**（`Test-NetConnection -Port 7890` 坐实 `TcpTestSucceeded=True`；7897 已不监听）。
- `mcp_servers.json` 的 `env.STRATA_PROXY = http://127.0.0.1:7890`，与之对齐。

## 启动自检怎么帮你定位

`runtime/selfcheck.py` 的 `check_proxy_config` 在网关启动时：

1. 读 `mcp_servers.json` 的 websearch `env.STRATA_PROXY`（无则回落进程 env），按其 scheme 解析 host:port（裸 `host:port` 按 socks5，与 `websearch_server._proxy_parts` 同口径）；
2. 对该端口做 3 秒 TCP 探测：
   - **通** → `INFO tcp ok <host>:<port>`；
   - **不通** → `WARN proxy <host>:<port> unreachable`，**但不阻断启动**（websearch 主路径直连 Bing 不依赖代理，代理只是回退）。

于是换机器/换端口后，端口不一致会在启动自检报告里**一处**显形，而不是等搜索/下载失败才发现。

## 代理不通时的下载回退日志

`servers/websearch_server.py` 的 `_fetch_bytes`（下载落盘通道）现在是**代理优先、不可达自动直连重试**：
代理连不上或后端不可用（socks scheme 缺 PySocks）时，打一行 stderr 日志再退回直连：

```
[websearch] download: proxy http://127.0.0.1:7890 unreachable (ConnectionRefusedError: ...), retrying direct
```

日后排障时，看有没有这行即可区分「代理通 / 代理不通」，不再静默吞。

## 改了代理端口之后怎么做

1. 改 `config/mcp_servers.json` 的 `websearch.env.STRATA_PROXY`（或前端 Tools 页代理卡保存）；
2. 点 MCP 面板「**重载子进程**」免重启生效（子进程 env 在 spawn 时固化，重载 = 重读 json + 重新 spawn）；
3. 若还要 git 操作走新端口，**别忘了单独改** `git config http.proxy/https.proxy`（独立一层）。

## 相关门禁

- `tests/test_startup_selfcheck.py` 的 proxy_reach 三条断言（无配置 skip / 不可达 WARN-not-fail / 可达 INFO）。
- `tests/test_websearch_proxy_retry.py`（R1 不可达直连重试+日志 / R2 后端不可用 / R3 代理通不回落 / R4 无代理直连）。
