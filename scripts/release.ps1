# Cuts a release: bump -> changelog -> commit -> tag -> push. The tag push triggers
# .github/workflows/release.yml, which typechecks, tests, builds BOTH platforms (Windows installer
# via Inno Setup, macOS .dmg), and publishes the GitHub release with both artifacts plus the
# Homebrew cask bump. This script owns only the local, human-in-the-loop half.
#
#   .\scripts\release.ps1 patch            # 0.1.0 -> 0.1.1
#   .\scripts\release.ps1 minor
#   .\scripts\release.ps1 -Version 1.0.0
#   .\scripts\release.ps1 patch -DryRun    # bump + changelog only; no commit, tag, or push
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

  # Bump and draft everything locally, but make no commit, tag, or push.
  [switch]$DryRun,

  # Release from a dirty working tree (the version bump will sweep up whatever else is staged).
  [switch]$AllowDirty,

  # Accept the generated changelog section without opening an editor.
  [switch]$NoEdit
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
  Step "1/4" "Preflight"
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -ne "main") {
    throw "On branch '$branch', not 'main'. Releases are cut from main."
  }
  $dirty = (git status --porcelain)
  if ($dirty -and -not $AllowDirty) {
    Write-Host ($dirty -join "`n")
    throw "Working tree is dirty. Commit or stash first, or pass -AllowDirty."
  }
  Write-Host "  branch main, tree " -NoNewline; Write-Host $(if ($dirty) { "dirty (allowed)" } else { "clean" }) -ForegroundColor DarkGray

  # --- 2. bump ---
  Step "2/4" "Bump version"
  $bump = Join-Path $PSScriptRoot "bump-version.ps1"
  # bump-version.ps1 prints progress via Write-Host and the new version as its only stdout line.
  $newVersion = if ($Version) { & $bump -Version $Version } else { & $bump $Part }
  $newVersion = ($newVersion | Select-Object -Last 1).ToString().Trim()
  if ($newVersion -notmatch '^\d+\.\d+\.\d+$') { throw "bump-version.ps1 returned '$newVersion'" }
  $tag = "v$newVersion"

  # --- 3. changelog ---
  # The CI publish job extracts this exact section for the release notes (and appends the
  # per-platform install instructions itself), so the section must exist before the tag is pushed.
  Step "3/4" "Changelog"
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

  # --- 4. commit + tag + push (the tag triggers the release workflow) ---
  if ($DryRun) {
    Step "4/4" "Commit + tag + push -- SKIPPED (-DryRun)"
    Write-Host "  would: git commit -am 'release: $tag'" -ForegroundColor DarkGray
    Write-Host "  would: git tag -a $tag -m 'based $newVersion'" -ForegroundColor DarkGray
    Write-Host "  would: git push --follow-tags" -ForegroundColor DarkGray
    Write-Host "`nDry run -- the version bump and CHANGELOG edit are still on disk. Revert with:" -ForegroundColor Yellow
    Write-Host "  git checkout -- shell-tauri/tauri.conf.json shell-tauri/Cargo.toml core/src/version.ts CHANGELOG.md" -ForegroundColor Yellow
  } else {
    Step "4/4" "Commit + tag + push"
    Run "git add" { git add -A }
    Run "git commit" { git commit -m "release: $tag" }
    Run "git tag" { git tag -a $tag -m "based $newVersion" }
    Run "git push" { git push --follow-tags }
    Write-Host "`nDone: based $newVersion tagged." -ForegroundColor Green
    Write-Host "The release workflow is now building both platforms:" -ForegroundColor DarkGray
    Write-Host "  gh run watch --repo Cyronius/based" -ForegroundColor DarkGray
  }
} finally {
  Pop-Location
}
