@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
title Nebula Agent - 一键启动
setlocal

REM ============================================================
REM  Nebula Agent one-click launcher  (启动顺序调整 2026-11)
REM  两步：
REM  [1] 先启动 gw_watchdog（单实例）——它内部每 10s 探 8099，缺失且无
REM      .gw_stop.flag 就自行拉起 run_standalone.bat，即看门狗顺带把 8099
REM      网关带起来（不再单独显式起网关）。
REM  [2] 再启动推理引擎：E:\Nebula\Strata模型安装\run-iq3_s_abliterated.bat
REM  - 已运行的组件会被跳过（重复运行安全）。
REM ============================================================

set WATCHDOG="E:\Nebula\NebulaBaize\Nebula-agent\gw_watchdog.bat"
set ENGINE_BAT="E:\Nebula\Strata模型安装\run-iq3_s_abliterated.bat"

echo ===================================================
echo  Nebula Agent 一键启动
echo ===================================================

REM ---------- 1) 看门狗（内部拉起并自愈 8099 网关；单实例，重复启动自动跳过）----------
if exist %WATCHDOG% (
    echo [1/2] 启动网关看门狗（它会自动拉起 8099 网关，已在运行则跳过）...
    start "Nebula Watchdog" cmd /c %WATCHDOG%
    echo       看门狗启动中, 网关将由其在数秒内拉起 http://127.0.0.1:8099
    echo       （此时 8080 引擎尚未就绪, 请求会 502, 引擎起来后自动恢复）
) else (
    echo [1/2] 错误: 未找到看门狗脚本 %WATCHDOG%
    echo       它是 8099 网关的拉起源, 缺少则无法启动, 已中止.
    pause
    exit /b 1
)

REM ---------- 2) 8080 推理引擎（run-iq3_s_abliterated）----------
netstat -ano | findstr /i ":8080" | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [2/2] 8080 已在运行, 跳过引擎启动.
    echo       注意: 当前 8080 上跑的模型可能与本脚本预期不一致;
    echo       若要切换模型, 请先手动停止当前引擎, 再运行本脚本.
    goto :done
)
echo [2/2] 8080 未运行, 启动引擎: %ENGINE_BAT%
if not exist %ENGINE_BAT% (
    echo   错误: 找不到引擎脚本 %ENGINE_BAT%
    echo   （不影响已启动的 8099 网关，仅本地推理不可用）
    pause
    goto :done
)
start "Strata Engine 8080" cmd /c %ENGINE_BAT%
echo       等待 8080 端口就绪 ...
set /a N=0
:wait8080
set /a N+=1
netstat -ano | findstr /i ":8080" | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 goto :engine_ok
if %N% geq 60 (
    echo   超时: 8080 未在 60 秒内就绪, 请检查引擎启动日志
    pause
    goto :done
)
timeout /t 1 >nul
goto :wait8080
:engine_ok
echo       8080 就绪.

:done
echo ===================================================
echo  完成. 看门狗(含 8099 网关) + 引擎@8080 均已尝试拉起.
echo  停止: 关闭对应的看门狗窗口、引擎窗口即可.
echo ===================================================
endlocal
