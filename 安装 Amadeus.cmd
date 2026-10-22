@echo off
setlocal
cd /d "%~dp0"
if not exist "scripts\desktop-install.ps1" (
  echo This package is incomplete. Extract the entire ZIP first.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\desktop-install.ps1"
set "install_result=%errorlevel%"
echo.
if not "%install_result%"=="0" (
  echo Installation did not finish. Read the error above, then try again.
) else (
  echo Installation finished. Restart Codex Desktop to load the new connector.
)
echo Press any key to close this window.
pause >nul
exit /b %install_result%
