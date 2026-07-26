# Traces: BASED-INSTALLER-WIN, BASED-PACKAGE-WIN
# Builds the Windows installer: dist\based-<version>-Setup.exe
#
#   1. bun run build:ui                      -> ui\dist (shipped inside the bundle, BASED-PACKAGE-WIN)
#   2. electrobun build --env=stable         -> shell\build\stable-win-x64\<app>\
#   3. csc scripts\win\based-open.cs         -> <bundle>\bin\based-open.exe (.sql association stub)
#   4. copy shell\assets\icon.ico            -> <bundle>\icon.ico (ProgID DefaultIcon + shortcuts)
#   5. ISCC scripts\installer.iss            -> dist\based-<version>-Setup.exe
#
# Requires Inno Setup 6:  winget install JRSoftware.InnoSetup
#
# electrobun's icon embed into launcher.exe is broken upstream (rcedit resolution bug -- see
# shell\README.md for the full diagnosis). Ensure-RceditShim below applies the workaround
# automatically, so a release build gets the right exe icon without anyone remembering a manual
# step. If the shim can't be mounted the build still succeeds; only launcher.exe's own icon falls
# back, and the installer, shortcuts, and .sql association still use icon.ico.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

# The absolute path electrobun's compiled CLI has baked in from its own upstream CI build. We
# recreate it on a substed D: so its broken require.resolve finds a real rcedit.
$RCEDIT_BAKED_SUBPATH = "a\electrobun\electrobun\package\node_modules\rcedit"

function Ensure-RceditShim {
  $shimRoot = Join-Path $env:USERPROFILE ".electrobun-rcedit-shim"
  $target = Join-Path $shimRoot $RCEDIT_BAKED_SUBPATH
  $probe = Join-Path "D:\" "$RCEDIT_BAKED_SUBPATH\package.json"

  # Populate (or refresh) the shim from the real rcedit in the workspace bun store. electrobun only
  # shells out to the binary, so package.json + the exes are the whole dependency.
  $storeDir = Get-ChildItem (Join-Path $repo "node_modules\.bun") -Directory -Filter "rcedit@*" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $storeDir) {
    Write-Warning "rcedit not found in node_modules\.bun -- skipping icon shim (run 'bun install'?)"
    return
  }
  $src = Join-Path $storeDir.FullName "node_modules\rcedit"
  New-Item -ItemType Directory -Force -Path (Join-Path $target "bin") | Out-Null
  Copy-Item (Join-Path $src "package.json") (Join-Path $target "package.json") -Force
  Copy-Item (Join-Path $src "bin\*.exe") (Join-Path $target "bin") -Force

  if (Test-Path $probe) {
    Write-Host "  rcedit shim already mounted on D:" -ForegroundColor DarkGray
    return
  }
  if (Test-Path "D:\") {
    Write-Warning "D: is already in use by something other than the rcedit shim -- launcher.exe will keep electrobun's default icon. See shell\README.md."
    return
  }
  & "$env:WINDIR\System32\subst.exe" D: $shimRoot
  if (Test-Path $probe) {
    Write-Host "  mounted rcedit shim: D: -> $shimRoot" -ForegroundColor DarkGray
  } else {
    Write-Warning "subst D: did not take -- launcher.exe will keep electrobun's default icon."
  }
}

# --- version from shell/electrobun.config.ts ---
$config = Get-Content (Join-Path $repo "shell\electrobun.config.ts") -Raw
if ($config -notmatch 'version:\s*"([^"]+)"') { throw "Could not read app.version from shell\electrobun.config.ts" }
$version = $Matches[1]
Write-Host "Packaging based $version" -ForegroundColor Cyan

# --- 1. UI build ---
Write-Host "`n[1/5] Building UI..." -ForegroundColor Cyan
Push-Location $repo
try { bun run build:ui; if ($LASTEXITCODE -ne 0) { throw "UI build failed" } }
finally { Pop-Location }

# --- 2. electrobun stable bundle ---
Write-Host "`n[2/5] Building electrobun stable bundle..." -ForegroundColor Cyan
Ensure-RceditShim
Push-Location (Join-Path $repo "shell")
try {
  & (Join-Path $repo "shell\node_modules\.bin\electrobun.exe") build --env=stable
  if ($LASTEXITCODE -ne 0) { throw "electrobun build failed" }
}
finally { Pop-Location }

$stableRoot = Join-Path $repo "shell\build\stable-win-x64"
# The stable build emits a self-extractor package; the runnable app tree lives inside its
# tar.zst. Extract it (Windows bsdtar handles zstd) and hand that tree to Inno Setup.
$tarZst = Join-Path $stableRoot "based-Setup.tar.zst"
if (-not (Test-Path $tarZst)) { throw "Expected $tarZst from electrobun build" }
$staging = Join-Path $stableRoot "installer-staging"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
& "$env:WINDIR\System32\tar.exe" -xf $tarZst -C $staging
if ($LASTEXITCODE -ne 0) { throw "Extracting $tarZst failed" }

$bundle = Get-ChildItem $staging -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName "bin\launcher.exe") } |
  Select-Object -First 1
if (-not $bundle) { throw "No app bundle (containing bin\launcher.exe) found under $staging" }
Write-Host "Bundle: $($bundle.FullName)"
if (-not (Test-Path (Join-Path $bundle.FullName "Resources\app\ui\dist\index.html"))) {
  throw "Bundle is missing Resources\app\ui\dist -- ui build didn't get copied (check electrobun.config.ts build.copy)"
}

# --- 3. association stub ---
Write-Host "`n[3/5] Compiling based-open.exe (file-association stub)..." -ForegroundColor Cyan
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc (.NET Framework 4.x required)" }
$ico = Join-Path $repo "shell\assets\icon.ico"
$stubOut = Join-Path $bundle.FullName "bin\based-open.exe"
& $csc /nologo /target:winexe /optimize+ "/win32icon:$ico" "/out:$stubOut" (Join-Path $repo "scripts\win\based-open.cs")
if ($LASTEXITCODE -ne 0) { throw "stub compile failed" }

# --- 4. icon into bundle ---
Write-Host "`n[4/5] Staging icon..." -ForegroundColor Cyan
Copy-Item $ico (Join-Path $bundle.FullName "icon.ico") -Force

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
& $iscc "/DAppVersion=$version" "/DBundleDir=$($bundle.FullName)" "/DOutputDir=$dist" (Join-Path $repo "scripts\installer.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

Write-Host "`nDone: $dist\based-$version-Setup.exe" -ForegroundColor Green
