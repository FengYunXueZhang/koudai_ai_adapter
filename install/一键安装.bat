@echo off
chcp 65001 >nul
title 口袋求索 · 一键安装
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
