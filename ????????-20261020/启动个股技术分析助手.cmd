@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File %~dp0start_technical_analysis_local.ps1 %*
if errorlevel 1 (
  echo.
  echo Startup failed. Please keep this window open and check the error above.
  pause
)
endlocal
