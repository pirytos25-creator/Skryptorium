@echo off
setlocal
cd /d "%~dp0\.."
chcp 65001 >nul

echo ============================================================
echo  Skryptorium Glosow - testy regresyjne
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo BLAD: nie znaleziono node.exe w PATH.
    pause
    exit /b 1
)

echo [1/5] Skladnia JavaScript
node --check skryptorium-core.js && echo    skryptorium-core.js OK

echo.
echo [2/5] Testy logiki core
node tests\frontend_test.js

echo.
echo [3/5] Porcjowanie renderowania kart
node tests\render_paging_test.js

echo.
echo [4/5] Architektura informacji UI
node tests\ux_structure_test.js

echo.
echo [5/5] Backend smoke suite
set "VENV=local-engine\.venv\Scripts\python.exe"
if exist "%VENV%" (
    pushd local-engine
    "..\%VENV%" -W ignore smoke_test.py
    popd
) else (
    echo    POMINIETO: brak local-engine\.venv
    echo    Uruchom najpierw local-engine\start_engine.bat
)

echo.
echo ============================================================
echo  Gotowe
echo ============================================================
echo.
echo Testy z realnym modelem (opcjonalne, wymagaja Ollamy i Local Engine):
echo    node tests\ai_e2e.js
echo    local-engine\.venv\Scripts\python.exe tests\whisper_e2e.py
echo.
pause
