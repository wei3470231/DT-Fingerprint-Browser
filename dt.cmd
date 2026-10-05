@echo off
if exist "%~dp0dist\payload\DT-CLI.exe" (
    "%~dp0dist\payload\DT-CLI.exe" %*
) else (
    node "%~dp0cli.js" %*
)
