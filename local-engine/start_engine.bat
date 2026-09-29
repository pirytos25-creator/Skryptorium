@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo  Skryptorium Local Whisper Engine v4
echo ==========================================
echo.

REM --- Domyslna konfiguracja (odkomentuj/zmien aby nadpisac) ---
if not defined ENGINE_MODEL set ENGINE_MODEL=turbo
if not defined ENGINE_BEAM set ENGINE_BEAM=2
if not defined ENGINE_BATCH_SIZE set ENGINE_BATCH_SIZE=8
if not defined ENGINE_DEVICE set ENGINE_DEVICE=auto
if not defined ENGINE_LANG set ENGINE_LANG=pl
REM set ENGINE_CPU_THREADS=8
REM set ENGINE_MAX_UPLOAD_MB=2048
REM set ENGINE_WORD_TIMESTAMPS=0
REM set ENGINE_LOG_PROGRESS=0
REM set ENGINE_PREPROCESS_AUDIO=0
REM Model laduje sie od razu po starcie, wiec pierwsza transkrypcja rusza szybciej.
if not defined ENGINE_WARMUP set ENGINE_WARMUP=1
REM --- v4: jakosc i odpornosc GPU (1 = wlaczone, 0 = wylaczone) ---
REM set ENGINE_FINE_SEGMENTS=1          & REM zdaniowe segmenty zamiast 30-sekundowych blokow
REM set ENGINE_HALLUCINATION_FILTER=1   & REM usuwa "Napisy... Amara.org", petle powtorzen
REM set ENGINE_REPAIR_PASS=1            & REM ponowne dekodowanie zapetlonych fragmentow
REM set ENGINE_FREE_OLLAMA_VRAM=1       & REM przed transkrypcja na GPU odladowuje modele Ollamy
REM set ENGINE_GPU_RETRY_COOLDOWN_SEC=900
REM set ENGINE_ALLOWED_MODELS=turbo,large-v3,medium,small,base
REM Opcjonalna ochrona endpointow (wpisz ten sam token w UI Skryptorium):
REM set ENGINE_API_TOKEN=tu-wstaw-dlugi-losowy-token
REM set OLLAMA_MODEL=qwen2.5:7b
REM set OLLAMA_NUM_CTX=8192

REM Find Python launcher first, then python.exe.
where py >nul 2>nul
if %errorlevel%==0 (
    set "PY=py"
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        set "PY=python"
    ) else (
        echo ERROR: Python was not found.
        echo Install Python 3.10/3.11/3.12 and select "Add Python to PATH".
        echo.
        pause
        exit /b 1
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creating virtual environment...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo ERROR: Could not create .venv.
        echo.
        pause
        exit /b 1
    )
)

REM Zaleznosci instalujemy tylko, gdy zmienil sie requirements.txt.
REM (v3 aktualizowal pip i pakiety przy KAZDYM starcie - kilkanascie sekund i wymog internetu.)
set "NEEDS_INSTALL=1"
if exist ".venv\requirements.installed" (
    fc /b requirements.txt ".venv\requirements.installed" >nul 2>nul
    if not errorlevel 1 set "NEEDS_INSTALL=0"
)
if "%NEEDS_INSTALL%"=="0" (
    echo [2/3] Zaleznosci aktualne - pomijam instalacje.
    goto :deps_ready
)

echo [2/3] Installing dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
    echo ERROR: pip upgrade failed.
    echo.
    pause
    exit /b 1
)

".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: dependency installation failed.
    echo.
    pause
    exit /b 1
)
copy /y requirements.txt ".venv\requirements.installed" >nul

:deps_ready
echo.
echo [3/3] Starting server: http://127.0.0.1:8765
echo Model %ENGINE_MODEL% (warmup=%ENGINE_WARMUP%). Zmiana modelu: Ustawienia w aplikacji.
echo Fast profile: beam=%ENGINE_BEAM%, batch=%ENGINE_BATCH_SIZE%, device=%ENGINE_DEVICE%.
echo Keep this window open while using Skryptorium.
echo Stop server: Ctrl+C
echo.
".venv\Scripts\python.exe" server.py

echo.
echo Server stopped or crashed.
pause
