@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
REM ============================================================
REM  Nebula Agent 网关看门狗启动器(与 run_standalone.bat 同目录)
REM  最小化运行 gw_watchdog.py：每 10s 探 8099，缺失且无 .gw_stop.flag 则
REM  拉起 run_standalone.bat(覆盖"整个网关窗口被关"的场景)。
REM  单实例由 gw_watchdog.py 内命名互斥体保证，重复启动会被自动跳过。
REM  停止：结束运行中的 gw_watchdog.py 进程即可(也可建 .gw_stop.flag)。
REM ============================================================
start "" /min "E:\WorkBuddy\星云智能体\strata-agent\.venv\Scripts\python.exe" "E:\WorkBuddy\星云智能体\strata-agent\gw_watchdog.py"
