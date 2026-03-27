@echo off
title Options Scanner
cd /d "D:\AI\AI Trading"

:: Use the Python that pip installed packages into
:: Try common locations
set PYTHON=python
where python >nul 2>&1 || set PYTHON=py

echo [%date% %time%] Starting options scan... >> scripts\output\scan.log
%PYTHON% scripts/options_scanner.py --telegram >> scripts\output\scan.log 2>&1
echo [%date% %time%] Scan complete. >> scripts\output\scan.log
