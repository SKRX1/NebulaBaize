@echo off
REM ============================================================================
REM  Deploy workspace frontend to Strata-main (parasite mode)
REM  Mirror serve/web/ from the workspace to a Strata serve/web/ target.
REM  Run this after each Strata upgrade to restore the enhanced frontend.
REM  Accepts optional argument: path to target serve\web\ folder.
REM  Default target: E:\Program Files\Strata-main\serve\web
REM ============================================================================

chcp 65001 >nul
set PYTHON=E:\WorkBuddy\星云智能体\strata-agent\.venv\Scripts\python.exe
set DEPLOY_SCRIPT=%~dp0tools\deploy_frontend.py
set TARGET=E:\Program Files\Strata-main\serve\web
if not "%~1"=="" set TARGET=%~1

echo ========================================
echo  Deploy frontend -> Strata
echo  Target: %TARGET%
echo ========================================

if not exist "%TARGET%" (
    echo [FAIL] Target directory not found.
    goto :end
)

"%PYTHON%" "%DEPLOY_SCRIPT%" "%TARGET%"

:end
pause
