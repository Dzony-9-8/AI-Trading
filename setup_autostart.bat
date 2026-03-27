@echo off
title LocalTrader — Autostart Setup
color 0A
cls
echo.
echo  ==========================================
echo   LocalTrader ^| Autostart Setup
echo  ==========================================
echo.
echo  This will configure LocalTrader to start
echo  automatically every time Windows starts.
echo.
echo  Run this file ONCE as Administrator.
echo  After that, the bot starts itself — no
echo  action needed from you.
echo.
pause

:: ── 1. Register crypto bot to start at Windows logon ──────────────────────────
schtasks /delete /tn "LocalTrader-CryptoBot" /f >nul 2>&1

schtasks /create ^
  /tn "LocalTrader-CryptoBot" ^
  /tr "\"D:\AI\AI Trading\start_silent.vbs\"" ^
  /sc ONLOGON ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /delay 0001:00 ^
  /f

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo  [ERROR] Failed to register crypto bot autostart.
  echo  Make sure you right-clicked and chose "Run as administrator".
  echo.
  goto :options_scan
)
echo  [OK] Crypto bot — starts at every Windows logon

:: ── 2. Register options scan at 16:00 local time (= 10:00 AM US Eastern) ──────
:: 10:00 AM EDT = 30 min after market open, options have real bid/ask by then
:options_scan
schtasks /delete /tn "LocalTrader-OptionsScan" /f >nul 2>&1

schtasks /create ^
  /tn "LocalTrader-OptionsScan" ^
  /tr "\"D:\AI\AI Trading\scripts\run_scan.bat\"" ^
  /sc WEEKLY ^
  /d MON,TUE,WED,THU,FRI ^
  /st 16:00 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% EQU 0 (
  echo  [OK] Options scan — runs 4:00 PM your time ^(10:00 AM US Eastern^)
) else (
  echo  [WARN] Options scan scheduling failed ^(non-critical^)
)

:: ── 3. Register crash recovery — restarts bot if it dies ──────────────────────
schtasks /delete /tn "LocalTrader-Watchdog" /f >nul 2>&1

schtasks /create ^
  /tn "LocalTrader-Watchdog" ^
  /tr "\"D:\AI\AI Trading\watchdog.vbs\"" ^
  /sc MINUTE ^
  /mo 5 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% EQU 0 (
  echo  [OK] Watchdog — checks every 5 min, restarts bot if crashed
) else (
  echo  [WARN] Watchdog scheduling failed ^(non-critical^)
)

echo.
echo  ==========================================
echo   Setup Complete
echo  ==========================================
echo.
echo  What happens now:
echo   - Bot starts automatically when you log into Windows
echo   - Options scan runs every weekday at 4:00 PM your time (10:00 AM US Eastern)
echo   - Watchdog checks every 5 min and restarts if crashed
echo   - Telegram alerts you if the bot restarts
echo.
echo  To keep the bot running 24/7 without logging in:
echo   1. Go to Settings ^> Accounts ^> Sign-in options
echo   2. Set "Require sign-in" to "Never"
echo   3. Enable auto-login (see instructions below)
echo.
echo  Auto-login setup (run in a NEW terminal as Admin):
echo   netplwiz
echo   ^> Uncheck "Users must enter a user name and password"
echo   ^> Click OK and enter your password once
echo.
pause
