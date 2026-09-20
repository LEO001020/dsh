# Provision ONE isolated writer: worktree + branch + junction farm + build + DSH_HOME + profile.
#
# WHY THIS EXISTS. The previous round ran ten writers in ONE shared worktree and
# produced five real git accidents (G-SEAM-35, G-SEAM-42): a `reset --hard`
# orphaned a commit, a `commit -a` swept a sibling's fix, an `--amend` raced, a
# broad `git add` pulled in in-progress work, and an uncommitted filing was
# reverted. V3 section T/R9 makes worktree isolation mandatory, and this script is
# what makes that discipline cheap enough to actually follow.
#
# THE TRAP THIS SCRIPT EXISTS TO CLOSE. A profile's `link:` dependencies are
# ABSOLUTE (docs/DELIVERY.md Trap 5). A writer who creates a worktree and installs
# the STOCK profile therefore resolves `dsh-daily-work` and `dsh-ipython` to the
# MAIN checkout, not to its own worktree -- so it edits one tree and measures
# another. That is the stale-artifact trap (G-SEAM-29/36) in a new costume: an
# installed artifact is not the repository until proven built from it. The
# generated profile below rewrites both `link:` targets at the worktree, so the
# boot under test is provably the writer's own code.
#
# WHAT IT DOES NOT DO. It does not judge anything and it does not commit. It
# prints the three coordinates the writer must use (worktree, branch, home) and
# exits non-zero if the provisioned boot does not resolve the writer's own tree.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Base = 'HEAD',
    [string]$Repo = 'D:\DSH\work\dsh-native-daily',
    [string]$DshSrc = 'D:\DSH\src\dsh-src'
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $DshSrc 'apps\cli\lib\bin.js'
$wt       = Join-Path 'D:\DSH\work' "wt-$Name"
# NOT `$home`: PowerShell's $HOME is read-only and assigning it aborts the script.
$dshHome  = Join-Path 'D:\DSH\home' $Name
$branch   = "wt/$Name"

function Step($m) { Write-Host "==> $m" }
function Die($m) { Write-Error $m; exit 1 }

# --- 1. worktree ------------------------------------------------------------
# A PREVIOUS FAILED RUN can leave the directory behind with no registered
# worktree: this script builds AFTER `worktree add`, so a build failure exits
# leaving a real directory that `git worktree list` no longer names (the
# registration was rolled back, the files were not). `git worktree prune` does
# not remove it either, because it prunes metadata, not directories. Re-running
# then dies on "already exists" and the operator has to know to clean by hand --
# so the script prunes, removes a stale directory no worktree owns, and only then
# refuses.
git -C $Repo worktree prune
if (Test-Path $wt) {
    $registered = @(git -C $Repo worktree list --porcelain | Select-String -SimpleMatch "worktree $wt").Count -gt 0
    if ($registered) {
        Die "worktree already exists and is REGISTERED: $wt. Remove it first (git worktree remove --force)."
    }
    Write-Host "    stale directory from a failed run, not a registered worktree -- removing $wt"
    Remove-Item -Recurse -Force $wt
}
if (git -C $Repo branch --list $branch) {
    Write-Host "    stale branch $branch from a failed run -- deleting"
    git -C $Repo branch -D $branch | Out-Null
}
Step "worktree $wt on new branch $branch from $Base"
git -C $Repo worktree add -b $branch $wt $Base
if ($LASTEXITCODE -ne 0) { Die "git worktree add failed" }

# --- 2. junction farm + build ----------------------------------------------
# `packages/*/lib/` is gitignored, so a fresh worktree has NO built output. The
# profile loads `main: lib/host-plugin.js`, so a writer that skips the build boots
# a profile whose extension is absent -- which reads as a composition failure.
foreach ($pkg in 'dsh-daily-work', 'dsh-ipython') {
    $p = Join-Path $wt "packages\$pkg"
    Step "link $pkg"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $p 'link-all-dsh.ps1') | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "link-all-dsh.ps1 failed for $pkg" }
    Step "build $pkg"
    Push-Location $p
    & node (Join-Path $DshSrc 'node_modules\typescript\bin\tsc') -p tsconfig.json
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Die "tsc build failed for $pkg (exit $code)" }
    if (-not (Test-Path (Join-Path $p 'lib\host-plugin.js')) -and $pkg -eq 'dsh-daily-work') {
        Die "build produced no lib/host-plugin.js"
    }
}

# --- 3. DSH_HOME + a profile bound to THIS worktree -------------------------
Step "home $dshHome"
New-Item -ItemType Directory -Force -Path (Join-Path $dshHome 'profiles') | Out-Null
$profDest = Join-Path $dshHome 'profiles\daily'
if (Test-Path $profDest) { Remove-Item -Recurse -Force $profDest }
Copy-Item -Recurse (Join-Path $wt 'profiles\daily-candidate') $profDest

# Rewrite both `link:` targets at the worktree. This is the whole point: without
# it the boot resolves the main checkout and the writer measures someone else's
# code. Both packages are named because a profile that installs only one still
# boots, with the missing extension's rows silently absent.
$pkgJson = Join-Path $profDest 'package.json'
$text = Get-Content -Raw $pkgJson
$text = $text -replace [regex]::Escape('D:/DSH/work/dsh-native-daily'), ($wt -replace '\\', '/')
Set-Content -NoNewline -Path $pkgJson -Value $text

Step "install profile"
Push-Location $profDest
$env:DSH_HOME = $dshHome
& node $launcher plugin --profile daily install 2>&1 | Out-Null
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Die "profile install failed (exit $code)" }

# --- 4. PROVE the boot resolves THIS worktree ------------------------------
# A provisioning script that reports success without checking would be the exact
# "mechanism implemented, nothing calls it" defect this project keeps recording.
#
# WHAT IS ACTUALLY PROVEN, and why the first version of this check was WRONG. It
# originally asserted that `--dump-config` mentions the worktree path. That check
# failed for a CORRECT tree: once dsh-ipython stopped hardcoding absolute paths
# (96a0e35), no checkout path appears in the dump at all, because the extension
# now derives its own location from `import.meta.url`. Grepping the dump for a
# path therefore tested an implementation detail of the patch file rather than the
# property that matters.
#
# The property that matters is WHICH PHYSICAL PACKAGES THE PROFILE LOADS. Two
# assertions establish it, and neither can pass while the writer is bound
# elsewhere:
#   1. Node's own resolver, from the INSTALLED profile directory, resolves both
#      extension packages to this worktree.
#   2. The boot composes without naming a foreign checkout of this repository.
#      (Zero mentions is the correct outcome; a mention of a DIFFERENT
#      dsh-native-daily tree is the failure.)
Step "verify the boot resolves $wt"
$env:DSH_HOME = $dshHome

$resolveScript = @'
import { createRequire } from 'node:module'
const req = createRequire(process.argv[2])
for (const name of ['dsh-ipython', 'dsh-daily-work']) {
  try { console.log(name + '\t' + req.resolve(name + '/package.json')) }
  catch (e) { console.log(name + '\tUNRESOLVED: ' + e.message) }
}
'@
$resolveFile = Join-Path $env:TEMP "resolve-$Name.mjs"
Set-Content -Path $resolveFile -Value $resolveScript
$profilePkg = Join-Path $profDest 'package.json'
$resolved = & node $resolveFile $profilePkg 2>&1 | Out-String
Remove-Item $resolveFile -Force -ErrorAction SilentlyContinue

foreach ($pkgName in 'dsh-ipython', 'dsh-daily-work') {
    $line = ($resolved -split "`n" | Where-Object { $_ -like "$pkgName`t*" } | Select-Object -First 1)
    if (-not $line) { Die "could not resolve $pkgName from the installed profile" }
    $path = ($line -split "`t")[1].Trim()
    if ($path -like 'UNRESOLVED*') { Die "$pkgName did not resolve: $path" }
    $expectedPkg = Join-Path $wt "packages\$pkgName\package.json"
    if ($path -ne $expectedPkg) {
        Die "$pkgName resolves to '$path' but this writer owns '$expectedPkg'. The writer would measure another checkout."
    }
}

# A DIFFERENT checkout of this repository must not be named by the composition.
# The writer's own tree may legitimately appear; another one must not.
$dump = & node $launcher --profile daily --dump-config 2>&1 | Out-String
$foreign = [regex]::Matches($dump, '[A-Za-z]:[\\/][^\s"'',;)\]]*dsh-native-daily[^\s"'',;)\]]*') |
    ForEach-Object { $_.Value } |
    Where-Object { $_ -notlike "$($wt -replace '\\','/')*" -and $_ -notlike "$($wt -replace '/','\')*" } |
    Select-Object -Unique
if ($foreign.Count -gt 0) {
    Die "the boot names a FOREIGN checkout of this repo: $($foreign -join '; ')"
}

$verdict = Join-Path $wt '.writer-provision.json'
@{
    name        = $Name
    worktree    = $wt
    branch      = $branch
    dsh_home    = $dshHome
    dsh_src     = $DshSrc
    launcher    = $launcher
    provisioned = (Get-Date).ToString('s')
    ipython_resolves_to_own_tree    = $true
    dailywork_resolves_to_own_tree  = $true
    no_foreign_checkout_named       = $true
} | ConvertTo-Json | Set-Content -Path $verdict

Write-Host ""
Write-Host "PROVISIONED $Name"
Write-Host "  worktree : $wt"
Write-Host "  branch   : $branch"
Write-Host "  DSH_HOME : $dshHome"
Write-Host "  launcher : $launcher"
Write-Host "  proof    : node resolves both extension packages to this worktree"
Write-Host ""
Write-Host "Boot with:  `$env:DSH_HOME='$dshHome'; node $launcher --profile daily ..."
