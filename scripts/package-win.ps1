# Traces: BASED-INSTALLER-WIN, BASED-PACKAGE-WIN
# Builds the Windows installer: dist\based-<version>-Setup.exe
#
#   1. bun run build:ui                          -> ui\dist
#   2. bun shell-tauri\bundle-core.ts            -> shell-tauri\dist-core\{core,ui,bun}
#   3. tauri build --no-bundle                   -> shell-tauri\target\release\based-shell.exe
#                                                   (+ core\ ui\ bun\ resource dirs beside it,
#                                                   copied by tauri-build from dist-core)
#   4. stage exe + resources + icon.ico          -> shell-tauri\target\release\installer-staging\
#   5. ISCC scripts\installer.iss                -> dist\based-<version>-Setup.exe
#
# Requires Inno Setup 6:  winget install JRSoftware.InnoSetup
# Requires the Rust toolchain (cargo) for the Tauri build.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 decodes .ps1 as ANSI, so a UTF-8 dash
# or curly quote anywhere in it corrupts the parse of the whole script.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$shellDir = Join-Path $repo "shell-tauri"

# --- version from shell-tauri/tauri.conf.json (source of truth, see bump-version.ps1) ---
$conf = Get-Content (Join-Path $shellDir "tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Bad version '$version' in shell-tauri\tauri.conf.json" }
Write-Host "Packaging based $version" -ForegroundColor Cyan

# --- 1. UI build ---
Write-Host "`n[1/5] Building UI..." -ForegroundColor Cyan
Push-Location $repo
try { bun run build:ui; if ($LASTEXITCODE -ne 0) { throw "UI build failed" } }
finally { Pop-Location }

# --- 2. core bundle (must precede the cargo build: tauri-build validates bundle.resources) ---
Write-Host "`n[2/5] Bundling core..." -ForegroundColor Cyan
Push-Location $shellDir
try {
  bun bundle-core.ts
  if ($LASTEXITCODE -ne 0) { throw "bundle-core failed" }

  # --- 3. tauri release build (no NSIS bundle; Inno Setup is the installer) ---
  Write-Host "`n[3/5] Building Tauri shell..." -ForegroundColor Cyan
  bun x @tauri-apps/cli build --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}
finally { Pop-Location }

$release = Join-Path $shellDir "target\release"
$exe = Join-Path $release "based-shell.exe"
if (-not (Test-Path $exe)) { throw "Expected $exe from tauri build" }

# --- 4. staging: the exact tree the installed app runs from (resource_dir = exe dir) ---
Write-Host "`n[4/5] Staging bundle..." -ForegroundColor Cyan
$staging = Join-Path $release "installer-staging"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item $exe $staging
foreach ($dir in "core", "ui", "bun") {
  $src = Join-Path $release $dir
  if (-not (Test-Path $src)) { throw "Missing resource dir $src (tauri-build copies bundle.resources beside the exe)" }
  Copy-Item $src (Join-Path $staging $dir) -Recurse
}
Copy-Item (Join-Path $shellDir "icons\icon.ico") (Join-Path $staging "icon.ico")
if (-not (Test-Path (Join-Path $staging "ui\dist\index.html"))) { throw "Staged bundle is missing ui\dist\index.html" }
if (-not (Test-Path (Join-Path $staging "core\index.js"))) { throw "Staged bundle is missing core\index.js" }
if (-not (Test-Path (Join-Path $staging "bun\bun.exe"))) { throw "Staged bundle is missing bun\bun.exe" }
Write-Host "Bundle: $staging"

# --- 5. Inno Setup ---
Write-Host "`n[5/5] Building installer..." -ForegroundColor Cyan
$iscc = @(
  (Get-Command ISCC -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup not found. Install it with:  winget install JRSoftware.InnoSetup" }

$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
& $iscc "/DAppVersion=$version" "/DBundleDir=$staging" "/DOutputDir=$dist" (Join-Path $repo "scripts\installer.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

Write-Host "`nDone: $dist\based-$version-Setup.exe" -ForegroundColor Green
