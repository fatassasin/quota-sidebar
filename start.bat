@echo off
set "LOGDIR=%APPDATA%\quota-sidebar"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" --no-sandbox . >> "%LOGDIR%\launcher.log" 2>&1
