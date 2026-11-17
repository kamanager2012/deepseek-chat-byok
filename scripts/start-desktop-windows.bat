@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0scripts\start-desktop.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-desktop.ps1"
)
if errorlevel 1 pause
