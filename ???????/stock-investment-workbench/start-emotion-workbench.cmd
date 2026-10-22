@echo off
setlocal
set "NODE_EXE=C:\Users\fjliu.frank\Desktop\node-v22.18.0-win-x64\node.exe"
set "APP_DIR=D:\fjliu.frank\YUN\stock-investment-workbench"
cd /d "%APP_DIR%"
"%NODE_EXE%" server-emotion.mjs
endlocal
