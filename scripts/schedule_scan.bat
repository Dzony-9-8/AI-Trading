@echo off
echo.
echo  ==========================================
echo   Scheduling Daily Options Scan
echo  ==========================================
echo.
echo  This will schedule the options scanner to run
echo  every weekday at 8:30 AM automatically.
echo.
echo  Requirements:
echo   - Run this file as Administrator
echo   - Python must be installed and in PATH
echo.
pause

:: Delete existing task if present
schtasks /delete /tn "LocalTrader-OptionsScan" /f >nul 2>&1

:: Create new task — weekdays at 8:30 AM
schtasks /create ^
  /tn "LocalTrader-OptionsScan" ^
  /tr "\"D:\AI\AI Trading\scripts\run_scan.bat\"" ^
  /sc WEEKLY ^
  /d MON,TUE,WED,THU,FRI ^
  /st 08:30 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% == 0 (
  echo.
  echo  [SUCCESS] Options scan scheduled for 8:30 AM, Mon-Fri
  echo  Results will appear in: scripts\output\
  echo  Telegram summary sent automatically after each scan
  echo.
) else (
  echo.
  echo  [ERROR] Failed to create task. Try right-clicking and
  echo  selecting "Run as administrator"
  echo.
)
pause
