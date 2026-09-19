# Rebuild every @deepseek-ai junction this package needs, derived from the pinned
# checkout rather than a hand-maintained list.
#
# WHY DERIVED. link-dsh.cmd enumerates 13 packages; the suite imports 57. The rest
# were added ad hoc as tests were written, so a bulk removal -- necessary when the
# install was renamed and every junction's ABSOLUTE target went stale -- silently
# dropped them and the extension stopped importing
# ("Cannot find package '@deepseek-ai/dsh-credentials'"). Deriving the set from the
# checkout's own manifests makes that class of loss impossible.
#
# WHY IT RE-DERIVES THE CHECKOUT ROOT. A junction stores an absolute target, so
# moving the install breaks all of them simultaneously. Hardcoding the path is
# what made the rename a silent, total failure instead of a clear one.
#
#   pwsh -File link-all-dsh.ps1
#   $env:DSH_SRC = 'D:\elsewhere\dsh-src'; pwsh -File link-all-dsh.ps1
[CmdletBinding()]
param(
    [string]$DshSrc = $env:DSH_SRC
)

$ErrorActionPreference = 'Stop'
$pkg = $PSScriptRoot
$repo = Split-Path (Split-Path $pkg -Parent) -Parent
if (-not $DshSrc) {
    $install = Split-Path (Split-Path $repo -Parent) -Parent
    $DshSrc = Join-Path $install 'src\dsh-src'
}

if (-not (Test-Path (Join-Path $DshSrc 'package.json'))) {
    Write-Error "no DSH checkout at '$DshSrc'. Set DSH_SRC to the pinned checkout."
    exit 1
}

$dst = Join-Path $pkg 'node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# Every @deepseek-ai package named anywhere in this package's sources.
$names = Get-ChildItem -Path (Join-Path $pkg 'src') -Filter *.ts -File |
    ForEach-Object { [regex]::Matches((Get-Content -Raw $_.FullName), '@deepseek-ai/[a-z0-9-]+') } |
    ForEach-Object { $_.Value } |
    Sort-Object -Unique

# name -> source directory, from the checkout's own manifests. First writer wins so
# a nested duplicate cannot shadow the canonical directory.
$map = @{}
Get-ChildItem -Path $DshSrc -Recurse -Filter package.json -File |
    Where-Object { $_.FullName -notmatch 'node_modules' } |
    ForEach-Object {
        try { $j = Get-Content -Raw $_.FullName | ConvertFrom-Json } catch { return }
        if ($j.name -and $j.name -like '@deepseek-ai/*' -and -not $map.ContainsKey($j.name)) {
            $map[$j.name] = $_.DirectoryName
        }
    }

$linked = 0; $missing = @()
foreach ($n in $names) {
    if (-not $n) { continue }
    $target = $map[$n]
    if (-not $target) { $missing += $n; continue }
    $link = Join-Path $dst ($n -replace '^@deepseek-ai/', '')
    # A junction whose target no longer exists cannot be removed by Remove-Item;
    # rmdir clears the reparse point itself without following it.
    if (Test-Path $link) { cmd /c rmdir /s /q "`"$link`"" 2>$null | Out-Null }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    $linked++
}

Write-Host "checkout : $DshSrc"
Write-Host "linked   : $linked of $($names.Count)"
if ($missing.Count -gt 0) {
    # A negative-test fixture deliberately names a package that must not resolve,
    # so an unresolved name is reported rather than treated as a hard failure.
    Write-Host "unresolved: $($missing -join ', ')"
}
