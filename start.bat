@echo off
title Cognitive Curator
color 0A
echo.
echo  ==========================================
echo    COGNITIVE CURATOR - Starting Server
echo  ==========================================
echo.

REM Kill ALL node.js processes to free any port
echo  Stopping any running Node.js servers...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 3 /nobreak >nul

echo  Starting backend server...
echo.
cd /d "%~dp0backend"
node server.js

REM If server crashes, pause so you can read the error
echo.
echo  Server stopped. Press any key to close.
pause >nul
