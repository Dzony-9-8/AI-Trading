@echo off
title LocalTrader — IBKR Bot
color 0B
cls

echo.
echo  ==========================================
echo   IBKR Options Bot ^| Paper Mode
echo  ==========================================
echo.

cd /d "D:\AI\AI Trading"

:: Check .env exists
if not exist ".env" (
    echo  [ERROR] .env file not found.
    echo.
    pause
    exit /b 1
)

:: Check IB Gateway is likely running (port 4002)
netstat -an | find "4002" | find "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo  [WARN] IB Gateway not detected on port 4002.
    echo  Start IB Gateway and log in before running the bot.
    echo.
)

:: Start dashboard server in a minimised background window
start /min "IBKR Dashboard" cmd /c ^
  ""C:\Users\dzoni\AppData\Local\nvm\v20.20.2\node.exe" node_modules/tsx/dist/cli.mjs src/dashboard-only.ts"

:: Open browser to options page after 8 seconds (background)
start "" cmd /c "timeout /t 8 /nobreak >nul && start http://127.0.0.1:3000/ibkr"

echo  Dashboard starting in background...
echo  Browser will open to http://127.0.0.1:3000/ibkr
echo.
echo  ==========================================
echo   IBKR Bot running — press Ctrl+C to stop
echo  ==========================================
echo.
echo  Scan schedule : 10:00 AM ET  (30 min post-open)
echo  Exit rules    : 50%% profit / 21 DTE / 2x loss stop
echo  Position poll : every 5 minutes
echo  Auto shutdown : 3:45 PM ET
echo.

:: Run the IBKR bot (foreground — this terminal shows live bot logs)
"C:\Users\dzoni\AppData\Local\Programs\Python\Python312\python.exe" scripts/ibkr_bot.py %*

echo.
echo  ==========================================
echo   IBKR Bot stopped.
echo  ==========================================
echo.
pause
