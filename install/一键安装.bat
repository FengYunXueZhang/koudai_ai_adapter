@echo off
chcp 65001 >nul
title Koudai AI Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
