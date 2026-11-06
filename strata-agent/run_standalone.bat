@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
setlocal EnableDelayedExpansion

REM ============================================================================
REM  Nebula Agent - Standalone mode launcher
REM  Starts the gateway HTTP server (serves its own frontend + API proxy).
REM  Frontend: serve/web/   API: proxied to --url upstream
REM
REM  2026-10-20 enhanced: auto-restart gateway on crash (backoff + max fails),
REM  to avoid "manual/kill close -> nobody relaunches -> frontend Failed to fetch".
REM  Stop: close the window (hard) or create stop-flag file .gw_stop.flag (soft, loop exits).
REM  2026-11-07: PYTHON 改为 %ROOT% 相对定位(原硬编码 E:\... 绝对路径,与
REM  gw_watchdog.bat 同类隐患); ROOT 已在下一行定义,整目录迁移不再断链。
REM ============================================================================

set ROOT=%~dp0
set PYTHON=%ROOT%.venv\Scripts\python.exe

REM --- Upstream API (change for remote endpoints) ---
set UPSTREAM_URL=http://127.0.0.1:8080/v1
set MODEL=strata
set API_KEY=
set PORT=8099
REM --- 2026-10-23: per-round output budget (see runtime/http_server.py L97/L107) ---
set STRATA_MAX_OUTPUT=16384
set STRATA_MAX_OUTPUT_CEILING=49152

REM --- Build args ---
set ARGS=--serve --url "%UPSTREAM_URL%" --model "%MODEL%" --port %PORT%
if not "%API_KEY%"=="" set ARGS=%ARGS% --api-key "%API_KEY%"

REM --- Agent mode ---
REM   1 = local agent loop: the standalone runs its OWN MCP tools (filesystem/shell/
REM       websearch/registry/skillhub/... from config/mcp_servers.json). Self-
REM       sufficient and immune to Strata-host upgrades that wipe the parasite patches.
REM   0 = transparent proxy: delegates ALL tools to upstream@8080. After a Strata
REM       upgrade the parasite loses our mcp_servers.json, so it exposes 0 tools
REM       (the "tools and services missing" bug). Default is 1.
set AGENT_MODE=1
if "%AGENT_MODE%"=="1" set ARGS=%ARGS% --agent

REM --- Auto-restart control ---
set STOP_FLAG=%ROOT%.gw_stop.flag
set MAX_FAILS=5
set DELAY=3
set FAILS=0
set GW_STARTED=

echo ========================================
echo  Nebula Agent - Standalone
echo  Frontend: http://127.0.0.1:%PORT%
echo  Upstream: %UPSTREAM_URL%
echo  Model: %MODEL%
echo  网关崩溃将自动重启(最多连续 %MAX_FAILS% 次); 创建 %STOP_FLAG% 可软停.
echo ========================================

REM [encoding canary] one-shot self-check at launcher start (writes logs\encoding_canary.jsonl)
if not defined _CANARY_RAN "%PYTHON%" "%ROOT%tools\encoding_canary.py"
set _CANARY_RAN=1
:loop
if exist "%STOP_FLAG%" (
    echo 检测到停止标志 %STOP_FLAG%, 退出重启循环.
    goto :eof
)

REM 仅在首次启动时打开浏览器，避免每次重启都弹新标签页
if not defined GW_STARTED (
    start /b cmd /c "ping -n 4 127.0.0.1 >nul & start http://127.0.0.1:%PORT%"
    set "GW_STARTED=1"
)

echo [%time%] 启动网关 (失败计数 %FAILS%/%MAX_FAILS%) ...
"%PYTHON%" "%ROOT%runtime\gateway.py" %ARGS%
set RC=!errorlevel!

if !RC!==0 (
    echo [%time%] 网关正常退出 (code 0), 停止重启循环.
    goto :eof
)

set /a FAILS+=1
echo [%time%] 网关异常退出 (code !RC!), 失败计数 !FAILS!/%MAX_FAILS%.

if !FAILS! geq %MAX_FAILS% (
    echo 连续失败 %MAX_FAILS% 次, 停止重启以防死循环(多为端口被占/依赖缺失).
    echo 排查后删除 %STOP_FLAG% 或修正依赖，再手动重跑本脚本.
    goto :eof
)

echo !DELAY! 秒后重启 ...
ping -n 3 127.0.0.1 >nul
goto loop
