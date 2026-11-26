@echo off
if not exist "%~dp0dist\payload-v3.1.1\app.asar" goto source
if not exist "%~dp0dist\payload-v3.1.1\DT-CLI.exe" goto source
"%~dp0dist\payload-v3.1.1\DT-CLI.exe" %*
exit /b %errorlevel%

:source
node "%~dp0cli.js" %*
