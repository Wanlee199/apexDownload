@echo off
title ApexTube - Premium YouTube Downloader Launcher
color 0A
cls

echo =====================================================================
echo                 ApexTube Downloader System Launcher
echo =====================================================================
echo.

:: 1. Check if Node.js is installed
node -v >nul 2>&1
if not errorlevel 1 goto node_ok

echo [!] Node.js is not found on your system.
echo [i] Attempting to install Node.js automatically using Windows Package Manager (winget)...
echo.
winget install OpenJS.NodeJS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto node_install_fail

echo.
echo [V] Node.js was successfully installed!
echo [i] Please CLOSE this window and double-click Start.bat again to run.
echo.
pause
exit /b

:node_install_fail
echo.
echo [X] Automatic installation failed or was cancelled.
echo [i] Please download and install Node.js manually from: https://nodejs.org/
echo.
pause
exit /b

:node_ok

:: 2. Check if node_modules are configured
if exist node_modules goto modules_ok

echo [i] First time launch detected. Installing package dependencies...
echo [i] Please wait a moment...
echo.
call npm install
if errorlevel 1 goto install_fail

echo.
echo [V] Setup completed successfully!
echo.
goto modules_ok

:install_fail
echo.
echo [X] Failed to install package dependencies. Please check your internet connection.
echo.
pause
exit /b

:modules_ok

:: 3. Launch the browser tab
echo [i] Starting server and opening ApexTube web interface...
ping 127.0.0.1 -n 3 >nul
start "" http://localhost:3000

:: 4. Start the Node server
call npm start

echo.
echo [i] Server stopped.
pause
