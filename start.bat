@echo off
title LocalTrader
color 0A
cls

echo.
echo  ==========================================
echo   LocalTrader ^| Paper Mode
echo  ==========================================
echo.

cd /d "D:\AI\AI Trading"

:: Check .env exists
if not exist ".env" (
    echo  [ERROR] .env file not found.
    echo  Run: copy config\.env.example .env
    echo  Then fill in your Binance API keys.
    echo.
    pause
    exit /b 1
)

:: Remove stale STOP file if present
if exist "STOP" (
    echo  [WARN] Removing leftover STOP file from last session...
    del "STOP"
    echo.
)

:: Open dashboard in browser after 6 seconds (runs in background)
start "" cmd /c "timeout /t 6 /nobreak >nul && start http://127.0.0.1:3000"

echo  Bot is starting. Dashboard will open automatically at http://127.0.0.1:3000
echo  Press Ctrl+C to stop gracefully.
echo.

:: Run the bot (blocking — terminal stays open while bot runs)
"C:\Users\dzoni\AppData\Local\nvm\v20.20.2\node.exe" node_modules/tsx/dist/cli.mjs src/main.ts

echo.
echo  ==========================================
echo   Bot stopped.
echo  ==========================================
echo.
pause
