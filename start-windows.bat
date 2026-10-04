@echo off
rem IFR Go/No-Go: double-click to start. Close this window to stop.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (py -3 server.py) else (python server.py)
if errorlevel 1 (echo. & echo Python 3 is needed: https://www.python.org/downloads/ & pause)
