@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Blanq Worksheet - Obsidian Plugin Installer

echo.
echo   ========================================
echo        Blanq Worksheet Installer
echo     Offline PDF blank detection for
echo              Obsidian
echo   ========================================
echo.

:: ── Step 1: Check prerequisites ──
echo   [1/4] Checking prerequisites
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   [X] Node.js not found - install from https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   [OK] Node.js %%v

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo   [X] npm not found
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm --version') do echo   [OK] npm %%v

:: Check for model file
set "MODEL_PATH="
if exist "%~dp0FFDNet-S.onnx" (
    set "MODEL_PATH=%~dp0FFDNet-S.onnx"
    echo   [OK] Model found: FFDNet-S.onnx
) else if exist "%~dp0..\FFDNet-S.onnx" (
    set "MODEL_PATH=%~dp0..\FFDNet-S.onnx"
    echo   [OK] Model found: ..\FFDNet-S.onnx
) else (
    echo   [X] FFDNet-S.onnx not found!
    echo       Place it in this folder or the parent folder.
    echo.
    pause
    exit /b 1
)

:: ── Step 2: Build plugin ──
echo.
echo   [2/4] Building plugin
echo.

cd /d "%~dp0"

if not exist "node_modules" (
    echo   Installing dependencies...
    call npm install --silent >nul 2>&1
    echo   [OK] Dependencies installed
) else (
    echo   [OK] Dependencies already installed
)

echo   Building...
call npm run build --silent >nul 2>&1

if not exist "%~dp0main.js" (
    echo   [X] Build failed - main.js not found
    pause
    exit /b 1
)
echo   [OK] Plugin built successfully

:: ── Step 3: Find Obsidian vaults ──
echo.
echo   [3/4] Finding Obsidian vaults
echo.

set "VAULT_COUNT=0"
set "OBSIDIAN_CONFIG=%APPDATA%\obsidian\obsidian.json"

if not exist "%OBSIDIAN_CONFIG%" (
    echo   [!] Obsidian config not found at %OBSIDIAN_CONFIG%
    echo.
    echo   Enter the full path to your Obsidian vault:
    set /p "MANUAL_VAULT=  > "
    if exist "!MANUAL_VAULT!" (
        set /a VAULT_COUNT+=1
        set "VAULT_1=!MANUAL_VAULT!"
        set "VNAME_1=!MANUAL_VAULT!"
    ) else (
        echo   [X] Directory not found
        pause
        exit /b 1
    )
    goto :select_vaults
)

:: Parse vaults from obsidian.json using Node.js
set "TEMPJS=%TEMP%\blanq_parse_vaults.js"
(
echo const fs = require('fs'^);
echo const path = require('path'^);
echo try {
echo   const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'^)^);
echo   const vaults = data.vaults ^|^| {};
echo   Object.values(vaults^).forEach(v =^> {
echo     if (v.path ^&^& fs.existsSync(v.path^)^) console.log(v.path^);
echo   }^);
echo } catch(e^) {}
) > "%TEMPJS%"

for /f "tokens=* delims=" %%p in ('node "%TEMPJS%" "%OBSIDIAN_CONFIG%" 2^>nul') do (
    set /a VAULT_COUNT+=1
    set "VAULT_!VAULT_COUNT!=%%p"
    for %%n in ("%%p") do set "VNAME_!VAULT_COUNT!=%%~nxn"
)
del "%TEMPJS%" >nul 2>&1

if %VAULT_COUNT% equ 0 (
    echo   [!] No vaults found in Obsidian config.
    echo.
    echo   Enter the full path to your Obsidian vault:
    set /p "MANUAL_VAULT=  > "
    if exist "!MANUAL_VAULT!" (
        set /a VAULT_COUNT+=1
        set "VAULT_1=!MANUAL_VAULT!"
        for %%n in ("!MANUAL_VAULT!") do set "VNAME_1=%%~nxn"
    ) else (
        echo   [X] Directory not found
        pause
        exit /b 1
    )
)

:select_vaults
echo   Found %VAULT_COUNT% vault(s):
echo.

for /l %%i in (1,1,%VAULT_COUNT%) do (
    set "installed="
    if exist "!VAULT_%%i!\.obsidian\plugins\blanq-worksheet" set "installed= (installed - will update)"
    echo     %%i^) !VNAME_%%i!!installed!
    echo        !VAULT_%%i!
)

echo.
echo   Select vaults to install to:
echo   Enter numbers separated by spaces, 'a' for all, or 'q' to quit
set /p "SELECTION=  > "

if /i "%SELECTION%"=="q" (
    echo   Cancelled.
    exit /b 0
)

:: ── Step 4: Install ──
echo.
echo   [4/4] Installing plugin
echo.

if /i "%SELECTION%"=="a" (
    for /l %%i in (1,1,%VAULT_COUNT%) do (
        call :install_to_vault "!VAULT_%%i!" "!VNAME_%%i!"
    )
) else (
    for %%s in (%SELECTION%) do (
        if %%s geq 1 if %%s leq %VAULT_COUNT% (
            call :install_to_vault "!VAULT_%%s!" "!VNAME_%%s!"
        ) else (
            echo   [!] Skipping invalid selection: %%s
        )
    )
)

:: ── Done ──
echo.
echo   ========================================
echo        Installation Complete!
echo   ========================================
echo.
echo   Next steps:
echo.
echo     1. Open Obsidian
echo     2. Go to Settings ^> Community Plugins
echo     3. Make sure Restricted mode is turned OFF
echo     4. Find "Blanq Worksheet" in the installed plugins
echo     5. Click the toggle to enable it
echo.
echo   Usage:
echo.
echo     * Click any PDF in your vault to open in Blanq
echo     * Right-click a PDF ^> "Open in Blanq"
echo     * Command palette ^> "Open Blanq Worksheet"
echo     * Click detected blanks to type answers
echo     * Click "Save" to write answers into the PDF
echo.
echo   Optional - AI Fill:
echo.
echo     * Go to Settings ^> Blanq Worksheet
echo     * Add your Anthropic or OpenAI API key
echo     * Click "AI Fill" to auto-fill worksheet answers
echo.
echo   Blank detection works fully offline.
echo   AI Fill is optional and requires an API key.
echo.
pause
exit /b 0

:: ── Subroutine: install to a vault ──
:install_to_vault
set "DEST=%~1\.obsidian\plugins\blanq-worksheet"
set "VNAME=%~2"

echo   Installing to %VNAME%...
if not exist "%DEST%" mkdir "%DEST%"

copy /y "%~dp0main.js" "%DEST%\" >nul 2>&1
copy /y "%~dp0manifest.json" "%DEST%\" >nul 2>&1
copy /y "%MODEL_PATH%" "%DEST%\FFDNet-S.onnx" >nul 2>&1

:: Copy WASM and MJS files
for %%f in ("%~dp0*.wasm") do copy /y "%%f" "%DEST%\" >nul 2>&1
for %%f in ("%~dp0*.mjs") do copy /y "%%f" "%DEST%\" >nul 2>&1

echo   [OK] Installed to %VNAME%
exit /b 0
