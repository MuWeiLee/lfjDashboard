@echo off
setlocal

set "WORKBENCH_DIR=%~dp0"
set "NODE_EXE=C:\Users\fjliu.frank\Desktop\node-v22.18.0-win-x64\node.exe"
set "WORKBENCH_URL=http://127.0.0.1:4320"

if not exist "%NODE_EXE%" (
  echo ERROR: Node.js was not found.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%WORKBENCH_URL%/api/health' -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }"
if errorlevel 1 (
  echo Starting standalone AI emotion workbench...
  powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'server-emotion.mjs' -WorkingDirectory '%WORKBENCH_DIR%' -WindowStyle Hidden"
)

powershell.exe -NoProfile -Command "$ready=$false; for($i=0;$i -lt 40;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%WORKBENCH_URL%/api/health' -TimeoutSec 2; if($r.StatusCode -eq 200){$ready=$true;break} } catch {}; Start-Sleep -Milliseconds 500 }; if($ready){exit 0}else{exit 1}"
if errorlevel 1 (
  echo ERROR: AI emotion workbench startup timed out.
  pause
  exit /b 1
)

echo AI emotion workbench is ready: %WORKBENCH_URL%
if /i "%~1"=="--no-browser" exit /b 0
start "" "%WORKBENCH_URL%"
exit /b 0
