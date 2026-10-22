@echo off
rem ShortEmotion Workbench launcher (double-click / desktop shortcut)
rem If the server is already running, just opens the dashboard.
setlocal
cd /d "d:\fjliu.frank\YUN\短线情绪工作台"
set "SHORT_EMOTION_DATA_DIR=d:\fjliu.frank\YUN\短线情绪工作台\short-emotion-data"
set "NODE=C:\Users\fjliu.frank\.local\lib\nodejs\node-v22.23.3-win-x64\node.exe"
if not exist "%NODE%" set "NODE=node"
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do set "FOUND=1"
if defined FOUND goto open
start "ShortEmotion Server" "%NODE%" scripts\dev-server.mjs
:open
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000/cn"
endlocal