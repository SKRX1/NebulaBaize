@echo off
chcp 65001 >nul
mode con: cols=120 lines=3000
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
REM ============================================================
REM  Nebula Agent 网关看门狗启动器(与 run_standalone.bat 同目录)
REM  最小化运行 gw_watchdog.py：每 10s 探 8099，缺失且无 .gw_stop.flag 则
REM  拉起 run_standalone.bat(覆盖"整个网关窗口被关"的场景)。
REM  单实例由 gw_watchdog.py 内命名互斥体保证，重复启动会被自动跳过。
REM  停止：结束运行中的 gw_watchdog.py 进程即可(也可建 .gw_stop.flag)。
REM  2026-11-05 修复：原来硬编码 E:\WorkBuddy\... 旧路径(项目已迁移)，
REM  改为 %~dp0 相对本 bat 自身目录，迁移整目录不再断链。
REM ============================================================
set "ROOT=%~dp0"
start "" /min "%ROOT%.venv\Scripts\python.exe" "%ROOT%gw_watchdog.py"
