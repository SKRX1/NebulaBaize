@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
title Nebula Agent - 一键启动
setlocal

REM ============================================================
REM  Nebula Agent one-click launcher  (改为只起看门狗 2026-11-22)
REM  一步：起网关看门狗 gw_watchdog.bat。它会在 8099 缺失时自动拉起
REM  run_standalone.bat（其内带崩溃自愈重启循环），所以本启动器不再直接
REM  起 run_standalone——交给看门狗按需拉起，避免双份启动逻辑。
REM  - 不再起 8080 推理引擎：本机可能用在线 API / 其他本地服务。
REM  - 看门狗单实例，重复启动自动跳过；已运行的网关也会被它跳过。
REM  - 启动完成后本启动器窗口自动关闭（不 pause）；看门狗/网关在各自窗口。
REM ============================================================

set WATCHDOG="%~dp0Nebula-agent\gw_watchdog.bat"

echo ===================================================
echo  Nebula Agent 一键启动（看门狗守护 8099）
echo ===================================================

REM ---------- 起网关看门狗（它已自行后台化；8099 缺失时自动拉起 run_standalone；单实例）----------
if not exist %WATCHDOG% (
    echo 错误: 未找到看门狗脚本 %WATCHDOG%
    echo       它是网关缺失时的拉起者，缺失则无网关、无自愈。
    pause
    exit /b 1
)
echo 启动网关看门狗（它会在 8099 缺失时自动拉起网关，并持续自愈）...
call %WATCHDOG%

echo ===================================================
echo  完成。看门狗已运行；8099 网关将由它在需要时自动拉起。
echo  停止: 在 Nebula-agent 下建 .gw_stop.flag 软停，或结束看门狗/网关进程。
echo  本地推理如需: 请另行自行启动引擎（本脚本不再自动起 8080）。
echo ===================================================
REM 启动完成后自动关闭本窗（不 pause）。
endlocal
exit
