@echo off
chcp 65001 >nul
set "ROOT=%~dp0"
set "AGENT=%ROOT%Nebula-agent"
set "SETUP_PY=%AGENT%\setup_env.py"
set "PY_BASE="

echo ========================================
echo  Nebula Agent - Environment Setup
echo  detect python, build project venv, rewrite config
echo ========================================

REM --- 1) detect an already-installed supported python (>=3.10) ---
REM try the py launcher first (finds any registered python, any path)
for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY_BASE=%%i"
REM try python on PATH
if not defined PY_BASE (
  for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY_BASE set "PY_BASE=%%i"
)
REM scan common install locations
if not defined PY_BASE (
  for %%D in (
    "%LOCALAPPDATA%\Programs\Python"
    "C:\Program Files\Python"
    "D:\Program Files\Python"
    "E:\Program Files\Python"
    "C:\Users\sk\.workbuddy\binaries\python\versions"
  ) do (
    if exist "%%~D" (
      for /f "delims=" %%i in ('dir /b /s /a-d "%%~D\python.exe" 2^>nul') do if not defined PY_BASE set "PY_BASE=%%i"
    )
  )
)

REM --- 2) require version >= 3.10 ---
if defined PY_BASE (
  "%PY_BASE%" -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" 2>nul
  if errorlevel 1 (
    echo [warn] found python but version is below 3.10, ignoring: %PY_BASE%
    set "PY_BASE="
  )
)

REM --- 3) if nothing found, download and silently install Python 3.14 ---
if not defined PY_BASE (
  echo [info] no supported python found, downloading latest Python 3.14 ...
  set "INST=%TEMP%\nebula-python-3.14.exe"
  REM resolve the latest 3.14 patch from endoflife.date (fallback 3.14.10) so a delisted
  REM point release can no longer break the download with a 404; then fetch + silently install.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue';try{$d=Invoke-RestMethod 'https://endoflife.date/api/python.json';$v=($d|?{$_.cycle -eq '3.14'}|Select-Object -First 1).latest}catch{$v=$null};if([string]::IsNullOrWhiteSpace($v)){$v='3.14.10'};$u='https://www.python.org/ftp/python/'+$v+'/python-'+$v+'-amd64.exe';Write-Host ('downloading ' + $u);Invoke-WebRequest -UseBasicParsing $u -OutFile '%INST%'"
  if exist "%INST%" (
    echo [info] installing python (silent, user-level, add to PATH) ...
    "%INST%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0
    for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY_BASE set "PY_BASE=%%i"
  )
)

if not defined PY_BASE (
  echo [ERROR] could not obtain a Python >= 3.10.
  echo          Please install Python 3.10+ manually (tick "Add to PATH"), then re-run setup.bat.
  pause
  exit /b 1
)

echo [info] using python: %PY_BASE%
"%PY_BASE%" --version

REM --- 4) build venv + rewrite config ---
"%PY_BASE%" "%SETUP_PY%"
echo.
echo [done] setup complete. You can now run 星云白泽.bat
pause
