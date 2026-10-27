@echo off
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe call npm.cmd ci --no-fund --no-audit
if errorlevel 1 exit /b 1
call npm.cmd run build
if errorlevel 1 exit /b 1
start "RelayDesk" /b node_modules\electron\dist\electron.exe .
