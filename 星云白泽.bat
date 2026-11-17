@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
title Nebula Agent - 一键启动
setlocal

REM ============================================================
REM  Nebula Agent one-click launcher
REM  - start 8099 gateway FIRST (boot does not depend on 8080; dead upstream
REM    only yields 502 until engine is ready; see gateway.py:497)
REM  - then start 8080 engine (Strata-main, s or xxs)
REM  - already-running components are skipped (safe to re-run)
REM  - also launches gw_watchdog.bat (single-instance) for window-closed recovery
REM  - switch model: change MODEL below to s or xxs
REM ============================================================

set MODEL=s

set ENGINE_BAT="E:\Program Files\Strata-main\run-swift-iq3_%MODEL%.bat"
set STANDALONE="E:\Nebula\NebulaBaize\strata-agent\run_standalone.bat"

echo ===================================================
echo  Nebula Agent 一键启动  [model=%MODEL%]
echo ===================================================

REM ---------- 1) 8099 独立版网关 ----------
netstat -ano | findstr /i ":8099" | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [1/2] 8099 已在运行, 跳过网关启动.
) else (
    echo [1/2] 8099 未运行, 启动网关: %STANDALONE%
    if not exist %STANDALONE% (
        echo   错误: 找不到 %STANDALONE%
        pause
        exit /b 1
    )
    start "Nebula Gateway 8099" cmd /c %STANDALONE%
    echo       网关启动中, 浏览器将在数秒后打开 http://127.0.0.1:8099
    echo       （此时 8080 尚未就绪, 请求会 502, 引擎起来后自动恢复）
)

REM ---------- 2) 8080 推理引擎 ----------
netstat -ano | findstr /i ":8080" | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [2/2] 8080 已在运行, 跳过引擎启动.
    echo       注意: 当前 8080 上跑的模型可能与本脚本 MODEL=%MODEL% 不一致.
    echo       s 与 xxs 互斥（共用单卡 + 8080 端口）; 若要切换模型, 请先手动停止当前引擎,
    echo       再运行本脚本, 或改 MODEL 后重启引擎, 并在前端「模型」下拉里改选对应项.
    goto :done
)
echo [2/2] 8080 未运行, 启动引擎: %ENGINE_BAT%
if not exist %ENGINE_BAT% (
    echo   错误: 找不到 %ENGINE_BAT%
    pause
    exit /b 1
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
    exit /b 1
)
timeout /t 1 >nul
goto :wait8080
:engine_ok
echo       8080 就绪.

REM ---------- 3) 8099 网关看门狗（单实例，重复启动自动跳过） ----------
set WATCHDOG="E:\Nebula\NebulaBaize\strata-agent\gw_watchdog.bat"
if exist %WATCHDOG% (
    echo [3/3] 启动网关看门狗（崩溃/关窗自愈，已在运行则跳过）...
    start "Nebula Watchdog" cmd /c %WATCHDOG%
) else (
    echo [3/3] 未找到看门狗脚本 %WATCHDOG%, 跳过.
)

:done
echo ===================================================
echo  完成. 引擎@8080 + 网关@8099 + 看门狗 均已在线.
echo  停止: 关闭对应的引擎窗口、网关窗口、看门狗窗口即可.
echo ===================================================
endlocal
