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

# ---------------------------------------------------------------------------
# BARE (non-@deepseek-ai) dependencies -- the second half of the same gap.
#
# `src/*.ts` imports `zod` (a runtime dependency: the record/observation schemas)
# and `vitest` (the test runner). Neither is created by this script, and neither
# is in the package's declared `dependencies` -- they exist in the main checkout
# only because they were linked by hand. A fresh worktree therefore fails the
# BUILD, not the link:
#
#     src/host.ts(28,19): error TS2307: Cannot find module 'zod'
#
# The set is DERIVED from what the sources actually import rather than listed
# here, for the same reason the @deepseek-ai set is: a hand-maintained list is
# what made the previous script wrong. Only `zod` and `vitest` are expected; any
# other bare name is REPORTED and left unresolved, because silently linking an
# arbitrary package would hide a real missing declaration.
$bare = @{}
Get-ChildItem -Path (Join-Path $pkg 'src') -Filter *.ts -File |
    ForEach-Object {
        $text = Get-Content -Raw $_.FullName
        # Static `from 'x'`, side-effect `import 'x'`, and dynamic `import('x')`.
        foreach ($m in [regex]::Matches($text, "(?:from|import)\s*\(?\s*'([^']+)'")) {
            $spec = $m.Groups[1].Value
            if ($spec.StartsWith('.') -or $spec.StartsWith('/')) { continue }
            if ($spec.StartsWith('@deepseek-ai/')) { continue }
            if ($spec.StartsWith('node:')) { continue }
            $root = if ($spec.StartsWith('@')) { ($spec -split '/')[0..1] -join '/' } else { ($spec -split '/')[0] }
            # A specifier that is really prose or a template fragment cannot be a
            # package name; require the npm charset.
            if ($root -match '^(@[a-z0-9-]+/)?[a-z0-9][a-z0-9._-]*$') { $bare[$root] = $true }
        }
    }

$bareLinked = 0; $bareMissing = @()
foreach ($n in ($bare.Keys | Sort-Object)) {
    # Resolve from the checkout's own install, which is where a real deployment
    # gets them from too.
    $cand = Get-ChildItem -Path (Join-Path $DshSrc 'node_modules\.pnpm') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$($n -replace '/','+')@*" } |
        Sort-Object Name -Descending
    $found = $null
    foreach ($c in $cand) {
        $inner = Join-Path $c.FullName "node_modules\$n"
        if (Test-Path $inner) { $found = $inner; break }
    }
    if (-not $found) { $bareMissing += $n; continue }
    $dest = Join-Path $pkg "node_modules\$n"
    $parent = Split-Path $dest -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (Test-Path $dest) { cmd /c rmdir /s /q "`"$dest`"" 2>$null | Out-Null }
    New-Item -ItemType Junction -Path $dest -Target $found | Out-Null
    $bareLinked++
}
if ($bareLinked -gt 0) { Write-Host "bare     : $bareLinked linked ($(($bare.Keys | Sort-Object) -join ', '))" }
if ($bareMissing.Count -gt 0) { Write-Host "bare unresolved: $($bareMissing -join ', ')" }

# ---------------------------------------------------------------------------
# `@types/node` -- the link this script used to NOT make.
#
# MEASURED GAP, and it made the documented recreation procedure produce an
# UNBUILDABLE install. `tsconfig.json` sets `"types": ["node"]`, so a build needs
# `node_modules/@types/node` to resolve. This script derived its link set from
# `@deepseek-ai/*` specifiers in `src/*.ts` and therefore never created it; in the
# main checkout the directory exists because someone added it by hand, so the gap
# was invisible there. A FRESH WORKTREE, where the farm is built only by this
# script, fails immediately with:
#
#     error TS2688: Cannot find type definition file for 'node'.
#
# The version is READ FROM THE CHECKOUT'S OWN MANIFEST rather than pinned here: a
# hardcoded 22.20.0 would silently outlive an upstream bump, which is the same
# class of drift that made `link-dsh.cmd`'s hand-maintained list wrong.
$typesDst = Join-Path $pkg 'node_modules\@types'
New-Item -ItemType Directory -Force -Path $typesDst | Out-Null
$nodeTypes = $null
$checkoutManifest = Join-Path $DshSrc 'package.json'
if (Test-Path $checkoutManifest) {
    $wanted = (Get-Content -Raw $checkoutManifest | ConvertFrom-Json).devDependencies.'@types/node'
    if ($wanted) {
        $bareVer = $wanted -replace '^[\^~]', ''
        # Prefer the exact declared version; fall back to any installed match so a
        # caret range whose exact build was pruned still resolves.
        $cands = Get-ChildItem -Path (Join-Path $DshSrc 'node_modules\.pnpm') -Directory -Filter '@types+node@*' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq "@types+node@$bareVer" -or $_.Name -like "@types+node@$bareVer-*" }
        if (-not $cands) {
            $cands = Get-ChildItem -Path (Join-Path $DshSrc 'node_modules\.pnpm') -Directory -Filter "@types+node@$bareVer*" -ErrorAction SilentlyContinue
        }
        if ($cands) {
            $nodeTypes = (Get-ChildItem -Path $cands[0].FullName -Recurse -Directory -Filter node -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -like '*@types\node' } | Select-Object -First 1).FullName
        }
    }
}
if ($nodeTypes -and (Test-Path $nodeTypes)) {
    $tlink = Join-Path $typesDst 'node'
    if (Test-Path $tlink) { cmd /c rmdir /s /q "`"$tlink`"" 2>$null | Out-Null }
    New-Item -ItemType Junction -Path $tlink -Target $nodeTypes | Out-Null
    Write-Host "types    : node -> $nodeTypes"
} else {
    # Loud, because a missing @types/node fails the BUILD, not the link, and the
    # build error (TS2688) does not mention this script.
    Write-Host "types    : @types/node NOT LINKED -- the build will fail with TS2688."
}
