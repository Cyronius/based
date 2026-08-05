# Cuts a release: bump -> verify -> build installer -> changelog -> tag -> GitHub release.
#
#   .\scripts\release.ps1 patch            # 0.1.0 -> 0.1.1, full release
#   .\scripts\release.ps1 minor
#   .\scripts\release.ps1 -Version 1.0.0
#   .\scripts\release.ps1 patch -DryRun    # everything local; no commit, tag, push, or upload
#
# Runs from the machine that builds the installer -- see docs/development.md for why this is not
# a GitHub Actions job yet (the Inno Setup / Rust toolchain).
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 decodes .ps1 as ANSI, so a UTF-8 dash
# or curly quote anywhere in it corrupts the parse of the whole script.

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("patch", "minor", "major")]
  [string]$Part = "patch",

  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  # Build and write everything locally, but make no commit, tag, push, or GitHub release.
  [switch]$DryRun,

  # Release from a dirty working tree (the version bump will sweep up whatever else is staged).
  [switch]$AllowDirty,

  # Accept the generated changelog section without opening an editor.
  [switch]$NoEdit,

  # Skip typecheck + tests. For re-cutting a build you have already verified.
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$changelogPath = Join-Path $repo "CHANGELOG.md"

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Run($what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

Push-Location $repo
try {
  # --- 1. preflight ---
  Step "1/7" "Preflight"
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -ne "main") {
    throw "On branch '$branch', not 'main'. Releases are cut from main."
  }
  $dirty = (git status --porcelain)
  if ($dirty -and -not $AllowDirty) {
    Write-Host ($dirty -join "`n")
    throw "Working tree is dirty. Commit or stash first, or pass -AllowDirty."
  }
  if (-not $DryRun) {
    # gh writes its status output to stderr; under EAP Stop, PS 5.1 turns redirected native
    # stderr into a terminating NativeCommandError, so relax EAP inside this block only.
    # --active: a stale secondary account in the keyring exits 1 without it.
    Run "gh auth status" {
      $ErrorActionPreference = "Continue"
      gh auth status --active 2>&1 | Out-Null
    }
  }
  Write-Host "  branch main, tree " -NoNewline; Write-Host $(if ($dirty) { "dirty (allowed)" } else { "clean" }) -ForegroundColor DarkGray

  # --- 2. verify ---
  if ($SkipTests) {
    Step "2/7" "Verify -- SKIPPED (-SkipTests)"
  } else {
    Step "2/7" "Typecheck + tests"
    Run "typecheck" { bun run typecheck }
    Run "tests" { bun test }
  }

  # --- 3. bump ---
  Step "3/7" "Bump version"
  $bump = Join-Path $PSScriptRoot "bump-version.ps1"
  # bump-version.ps1 prints progress via Write-Host and the new version as its only stdout line.
  $newVersion = if ($Version) { & $bump -Version $Version } else { & $bump $Part }
  $newVersion = ($newVersion | Select-Object -Last 1).ToString().Trim()
  if ($newVersion -notmatch '^\d+\.\d+\.\d+$') { throw "bump-version.ps1 returned '$newVersion'" }
  $tag = "v$newVersion"

  # --- 4. build installer ---
  Step "4/7" "Build Windows installer"
  & (Join-Path $PSScriptRoot "package-win.ps1")
  $exe = Join-Path $repo "dist\based-$newVersion-Setup.exe"
  if (-not (Test-Path $exe)) { throw "Expected installer at $exe" }
  $sha = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
  $sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
  Write-Host "  $exe ($sizeMb MB)" -ForegroundColor DarkGray
  Write-Host "  sha256 $sha" -ForegroundColor DarkGray

  # --- 5. changelog ---
  Step "5/7" "Changelog"
  $prevTag = (git tag --list "v*" --sort=-v:refname | Select-Object -First 1)
  $range = if ($prevTag) { "$prevTag..HEAD" } else { "HEAD" }
  $commits = git log $range --no-merges --pretty=format:"- %s"
  if (-not $commits) { $commits = "- (no commits since $prevTag)" }

  $today = (Get-Date -Format "yyyy-MM-dd")
  $section = @"
## [$newVersion] - $today

### Changed
$($commits -join "`n")

"@

  if (-not (Test-Path $changelogPath)) {
    Set-Content $changelogPath "# Changelog`n`nAll notable changes to based are documented here.`n`n" -Encoding utf8
  }
  $existing = [System.IO.File]::ReadAllText($changelogPath)
  # Insert the new section after the file's header block, above the previous release.
  $marker = [regex]::Match($existing, '(?m)^## \[')
  if ($marker.Success) {
    $updated = $existing.Insert($marker.Index, $section + "`n")
  } else {
    $updated = $existing.TrimEnd() + "`n`n" + $section
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($changelogPath, $updated, $utf8NoBom)
  Write-Host "  drafted section for $newVersion from $($commits.Count) commit(s)" -ForegroundColor DarkGray

  if (-not $NoEdit) {
    Write-Host "  Opening CHANGELOG.md -- these are raw commit subjects, not release notes." -ForegroundColor Yellow
    Start-Process $changelogPath | Out-Null
    Read-Host "  Edit the $newVersion section, save, then press Enter to continue (Ctrl-C to abort)"
  }

  # Pull the (possibly edited) section back out for the GitHub release body.
  $final = [System.IO.File]::ReadAllText($changelogPath)
  $secMatch = [regex]::Match(
    $final,
    "(?ms)^## \[$([regex]::Escape($newVersion))\].*?(?=^## \[|\z)"
  )
  $body = if ($secMatch.Success) { $secMatch.Value.Trim() } else { $section.Trim() }
  # Strip the leading "## [x.y.z] - date" line; the release page already shows both.
  $body = ($body -split "`n", 2)[1].Trim()

  $notes = @"
$body

### Install

Download ``based-$newVersion-Setup.exe`` below and run it. Per-user install, no admin required.

The installer is **not code-signed**, so Windows SmartScreen will show "Windows protected your PC"
on first run -- click **More info**, then **Run anyway**. Verify the download first if you like:

``````powershell
(Get-FileHash .\based-$newVersion-Setup.exe -Algorithm SHA256).Hash
# $sha
``````
"@
  $notesFile = Join-Path $env:TEMP "based-release-notes-$newVersion.md"
  [System.IO.File]::WriteAllText($notesFile, $notes, $utf8NoBom)

  # --- 6. commit + tag ---
  if ($DryRun) {
    Step "6/7" "Commit + tag -- SKIPPED (-DryRun)"
    Write-Host "  would: git commit -am 'release: $tag'" -ForegroundColor DarkGray
    Write-Host "  would: git tag -a $tag -m 'based $newVersion'" -ForegroundColor DarkGray
    Write-Host "  would: git push --follow-tags" -ForegroundColor DarkGray
  } else {
    Step "6/7" "Commit + tag"
    Run "git add" { git add -A }
    Run "git commit" { git commit -m "release: $tag" }
    Run "git tag" { git tag -a $tag -m "based $newVersion" }
    Run "git push" { git push --follow-tags }
  }

  # --- 7. GitHub release ---
  if ($DryRun) {
    Step "7/7" "GitHub release -- SKIPPED (-DryRun)"
    Write-Host "  would: gh release create $tag `"$exe`" --title `"based $newVersion`" --notes-file $notesFile" -ForegroundColor DarkGray
    Write-Host "`nNotes preview:`n" -ForegroundColor DarkGray
    Write-Host $notes
  } else {
    Step "7/7" "GitHub release"
    Run "gh release create" {
      gh release create $tag $exe --title "based $newVersion" --notes-file $notesFile
    }
  }

  Write-Host "`nDone: based $newVersion" -ForegroundColor Green
  if ($DryRun) {
    Write-Host "Dry run -- the version bump and CHANGELOG edit are still on disk. Revert with:" -ForegroundColor Yellow
    Write-Host "  git checkout -- shell-tauri/tauri.conf.json shell-tauri/Cargo.toml core/src/version.ts CHANGELOG.md" -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}
