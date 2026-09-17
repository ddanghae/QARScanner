@echo off
setlocal
cd /d "%~dp0"
node research\lab\cli.mjs %*
exit /b %ERRORLEVEL%
