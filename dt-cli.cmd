@echo off
if not exist "%~dp0dist\payload-v3.0\app.asar" goto source
if not exist "%~dp0dist\payload-v3.0\DT-CLI.exe" goto source
"%~dp0dist\payload-v3.0\DT-CLI.exe" %*
exit /b %errorlevel%

:source
node "%~dp0cli.js" %*
