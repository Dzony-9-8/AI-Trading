@echo off
title Clear Logs
echo.
echo  Deleting oversized log files...
if exist "logs\bot.log"   del /f /q "logs\bot.log"
if exist "logs\bot.log.1" del /f /q "logs\bot.log.1"
if exist "logs\bot.log.2" del /f /q "logs\bot.log.2"
if exist "logs\bot.log.3" del /f /q "logs\bot.log.3"
if exist "logs\bot.log.4" del /f /q "logs\bot.log.4"
if exist "logs\bot.log.5" del /f /q "logs\bot.log.5"
echo  Done. Logs cleared.
echo  You can now start the bot with start.bat
echo.
pause
