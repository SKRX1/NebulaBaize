@echo off
REM ============================================================================
REM  Strata host multimodal patch replay (parasite-mode image viewing)
REM  Re-applies the anchored patch to Strata-main serve/mcp.py + serve/server.py
REM  Strata-main is NOT a git clone: every upgrade rewrites serve/ and wipes the
REM  patch, so re-run this after each Strata upgrade. ASCII-only to dodge the
REM  Chinese-path code-page issue (see RULES).
REM  Also re-applies the workspace browser_server resolve-page patch (idempotent).
REM ============================================================================

chcp 65001 >nul
set ROOT=E:\Program Files\Strata-main
set PATCH=%~dp0tools\apply_host_patch.py
set PYEXE=%~dp0.venv\Scripts\python.exe

echo ========================================
echo  Re-applying host patch to Strata-main
echo  root : %ROOT%
echo  patch: %PATCH%
echo ========================================

if not exist "%ROOT%" (
    echo [WARN] Strata-main not found, skip.
    goto :end
)
if not exist "%PATCH%" (
    echo [FAIL] patch script not found: %PATCH%
    goto :end
)

"E:\WorkBuddy\星云智能体\strata-agent\.venv\Scripts\python.exe" "%PATCH%" --root "%ROOT%"
"%PYEXE%" "%~dp0tools\_patch_browser_resolve.py"

echo.
echo syntax check ...
"E:\WorkBuddy\星云智能体\strata-agent\.venv\Scripts\python.exe" -m py_compile "%ROOT%\serve\mcp.py" "%ROOT%\serve\server.py" && echo [OK] py_compile passed || echo [FAIL] py_compile error

:end
pause
