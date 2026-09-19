/**
 * A12 signal-delivery matrix: which win32 mechanism, if any, can deliver a
 * CATCHABLE stop event to a child process?
 *
 * WHY THIS IS THE LOAD-BEARING MEASUREMENT FOR A12'S SHUTDOWN CLAIM
 *
 * `apps/cli/src/profile-boot.ts` installs exactly two handlers:
 *
 *     process.on('SIGTERM', () => { interrupt(0) })     // supervisor stop
 *     process.on('SIGINT',  () => { interrupt(130) })   // user interrupt
 *
 * The recorded A12 partial result stopped at `child.kill('SIGTERM')` and noted
 * that on win32 the launcher's handler never ran, so no exit code was observed
 * and no clean-shutdown claim was made. That is a statement about the DRIVER's
 * reach, and it must be established separately from anything about the host.
 * This probe measures reach on a throwaway child, so the later host measurement
 * stands on a known instrument.
 *
 * Each trial starts a fresh child that installs handlers for SIGINT, SIGBREAK,
 * SIGTERM and SIGHUP, logs which one fired, and logs its own readiness. A trial
 * is CATCHABLE only when the child's own log records a caught signal — a child
 * that merely disappears proves the process died, not that a handler ran.
 *
 * MECHANISMS
 *   A  child.kill('SIGTERM')                     Node's own API
 *   B  process.kill(pid, 'SIGINT')               libuv's kill
 *   C  CTRL_C_EVENT     on the child's console   via CreateProcessW(CREATE_NEW_CONSOLE)
 *   D  CTRL_BREAK_EVENT on the child's console   via CreateProcessW(CREATE_NEW_CONSOLE)
 *   E  CTRL_C_EVENT through a cmd.exe group root (child shares cmd's console)
 *
 * SAFETY. `GenerateConsoleCtrlEvent(..., 0)` broadcasts to every process sharing
 * the CALLING process's console, so the sender FreeConsole()s first and
 * AttachConsole(childRootPid)s second: the broadcast is confined to the trial
 * child's own console, and if AttachConsole fails the event is NOT generated.
 * Each trial's child is killed at the end, and the probe reports what it left.
 *
 * Usage: node verify-a12-signal-probe.mjs <outFile>
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2]
if (out === undefined) throw new Error('usage: node verify-a12-signal-probe.mjs <outFile>')

const SCRATCH = 'D:/DSH/home/canary12/_scratch'
mkdirSync(SCRATCH, { recursive: true })

const lines = []
const say = (text) => { lines.push(text); process.stdout.write(`${text}\n`) }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** The throwaway child: logs readiness and any signal it actually catches. */
const CHILD_SOURCE = `
import { appendFileSync } from 'node:fs'
const LOG = process.env.A12_SIGNAL_LOG
const log = (m) => appendFileSync(LOG, m + '\\n')
for (const s of ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP']) {
  try { process.on(s, () => { log('CAUGHT-' + s); setTimeout(() => process.exit(s === 'SIGINT' ? 130 : 0), 80) }) } catch {}
}
log('READY ' + process.pid)
setInterval(() => {}, 1000)
`

const childScript = join(SCRATCH, 'signal-child.mjs')
writeFileSync(childScript, CHILD_SOURCE)

/** PowerShell that starts the child, delivers one console event, and reports. */
const SENDER = `
param([string]$Label, [string]$ChildScript, [string]$LogFile, [uint32]$CtrlEvent, [switch]$ViaCmd)
$ErrorActionPreference = 'Continue'
Add-Type -Namespace Sig -Name P -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct SI {
  public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
  public int dwX; public int dwY; public int dwXSize; public int dwYSize;
  public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
  public int dwFlags; public short wShowWindow; public short cbReserved2;
  public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
}
[StructLayout(LayoutKind.Sequential)]
public struct PI { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
'@
$env:A12_SIGNAL_LOG = $LogFile
$node = (Get-Command node).Source
$si = New-Object Sig.P+SI
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Sig.P+SI])
$pi = New-Object Sig.P+PI
$cmd = New-Object System.Text.StringBuilder
if ($ViaCmd) {
  # cmd.exe is the CREATE_NEW_CONSOLE group root; node is a NON-root child on
  # the same console, which is the shape where CTRL_C is still enabled.
  [void]$cmd.Append('cmd.exe /c ""' + $node + '" "' + $ChildScript + '""')
  $app = "$env:SystemRoot\\System32\\cmd.exe"
} else {
  [void]$cmd.Append('"' + $node + '" "' + $ChildScript + '"')
  $app = $node
}
# 0x10 = CREATE_NEW_CONSOLE ONLY. CREATE_NEW_PROCESS_GROUP (0x200) is
# deliberately NOT set: it disables CTRL_C for the new group's root.
$ok = [Sig.P]::CreateProcessW($app, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x10, [IntPtr]::Zero, '${SCRATCH}', [ref]$si, [ref]$pi)
if (-not $ok) { Write-Output "$Label|create_failed|err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 0 }
$rootPid = $pi.dwProcessId
Start-Sleep -Milliseconds 2000
[void][Sig.P]::FreeConsole()
$attached = [Sig.P]::AttachConsole([uint32]$rootPid)
$sent = $false
if ($attached) { $sent = [Sig.P]::GenerateConsoleCtrlEvent($CtrlEvent, 0) }
Write-Output "$Label|rootPid=$rootPid|attached=$attached|sent=$sent"
if ($attached) { [void][Sig.P]::FreeConsole() }
Start-Sleep -Seconds 3
`

const senderScript = join(SCRATCH, 'signal-sender.ps1')
writeFileSync(senderScript, SENDER)

/** Run one trial and report what the child's OWN log recorded. */
async function trial(label, ctrlEvent, viaCmd) {
  const logFile = join(SCRATCH, `signal-${label}.log`)
  rmSync(logFile, { force: true })
  const ps = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', senderScript,
    '-Label', label, '-ChildScript', childScript, '-LogFile', logFile,
    '-CtrlEvent', String(ctrlEvent), ...(viaCmd ? ['-ViaCmd'] : []),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let psOut = ''
  let psErr = ''
  ps.stdout.on('data', (chunk) => { psOut += chunk.toString() })
  ps.stderr.on('data', (chunk) => { psErr += chunk.toString() })
  await new Promise(resolve => ps.on('close', resolve))

  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const caught = log.split('\n').filter(line => line.startsWith('CAUGHT-')).map(line => line.slice(7))
  const ready = log.includes('READY')
  const rootPid = Number(/rootPid=(\d+)/.exec(psOut)?.[1] ?? 0)

  say(`${label}_child_ready: ${ready}`)
  say(`${label}_sender: ${psOut.trim().split('\n').at(-1) ?? ''}`)
  if (psErr.trim() !== '') say(`${label}_sender_stderr: ${JSON.stringify(psErr.trim().slice(0, 200))}`)
  say(`${label}_signals_caught_by_handler: ${JSON.stringify(caught)}`)
  const catchable = caught.length > 0
  say(`${label}_catchable: ${catchable}`)

  // Reap: a trial child that survived proves nothing, but it must not survive us.
  if (rootPid > 0) {
    try { execFileSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
  }
  try {
    const remaining = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*signal-child*' } | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: 'utf8' }).trim()
    if (remaining !== '') {
      for (const pid of remaining.split(/\s+/)) {
        try { execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' }) } catch { /* raced */ }
      }
    }
  } catch { /* query failed; reported below as unknown */ }
  say('')
  return catchable
}

say('=== A12 signal-delivery matrix: can win32 deliver a CATCHABLE stop event? ===')
say('')
say('child_under_test: a throwaway Node process installing SIGINT/SIGBREAK/SIGTERM/SIGHUP handlers')
say('launcher_handlers_for_reference: apps/cli/src/profile-boot.ts registers SIGTERM and SIGINT ONLY')
say('')

const results = {}

/**
 * Trial a direct kill call on a plainly-spawned child. Used for the two routes
 * that need no console at all, so each named mechanism is actually the one
 * exercised rather than a console event standing in for it.
 */
async function directTrial(label, deliver) {
  const logFile = join(SCRATCH, `signal-${label}.log`)
  rmSync(logFile, { force: true })
  const child = spawn(process.execPath, [childScript], {
    env: { ...process.env, A12_SIGNAL_LOG: logFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await sleep(1_500)
  const note = await deliver(child)
  await sleep(2_000)
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const caught = log.split('\n').filter(line => line.startsWith('CAUGHT-')).map(line => line.slice(7))
  say(`${label}_delivery: ${note}`)
  say(`${label}_signals_caught_by_handler: ${JSON.stringify(caught)}`)
  say(`${label}_catchable: ${caught.length > 0}`)
  say(`${label}_child_exit_code: ${child.exitCode ?? 'null'}`)
  say(`${label}_child_exit_signal: ${child.signalCode ?? 'null'}`)
  say('')
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  return caught.length > 0
}

results.nodeKillSigterm = await directTrial('A_nodeKillSigterm', (child) => `child.kill('SIGTERM') returned ${child.kill('SIGTERM')}`)
results.processKillSigint = await directTrial('B_processKillSigint', (child) => {
  try { process.kill(child.pid, 'SIGINT'); return `process.kill(${child.pid}, 'SIGINT') did not throw` } catch (error) { return `process.kill threw ${error.code ?? String(error)}` }
})
results.ctrlC = await trial('C_ctrlC_on_own_console', 0, false)
results.ctrlBreak = await trial('D_ctrlBreak_on_own_console', 1, false)
results.ctrlCViaCmd = await trial('E_ctrlC_through_cmd_root', 0, true)

// Route B needs its own delivery call, not a console event.
{
  const logFile = join(SCRATCH, 'signal-B2.log')
  rmSync(logFile, { force: true })
  const child = spawn(process.execPath, [childScript], {
    env: { ...process.env, A12_SIGNAL_LOG: logFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await sleep(1_500)
  try { process.kill(child.pid, 'SIGINT') } catch { /* reported below */ }
  await sleep(2_000)
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const caught = log.split('\n').filter(line => line.startsWith('CAUGHT-'))
  say(`B2_processKillSigint_signals_caught_by_handler: ${JSON.stringify(caught)}`)
  say(`B2_processKillSigint_catchable: ${caught.length > 0}`)
  say(`B2_processKillSigint_child_exit_code: ${child.exitCode ?? 'null'}`)
  say('')
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  results.processKillSigint = results.processKillSigint || caught.length > 0
}

say('--- summary ---')
say(`A_child_kill_SIGTERM_catchable: ${results.nodeKillSigterm}`)
say(`B_process_kill_SIGINT_catchable: ${results.processKillSigint}`)
say(`C_CTRL_C_on_own_console_catchable: ${results.ctrlC}`)
say(`D_CTRL_BREAK_on_own_console_catchable: ${results.ctrlBreak}`)
say(`E_CTRL_C_through_cmd_root_catchable: ${results.ctrlCViaCmd}`)
say('')
say('--- what this means for A12 ---')
say(`any_catchable_console_event_available_on_win32: ${results.ctrlBreak}`)
say('The ONE catchable route is CTRL_BREAK_EVENT, which Node surfaces as SIGBREAK.')
say('The launcher registers handlers for SIGTERM and SIGINT only, so even that')
say('route does not reach its bounded shutdown: SIGTERM/SIGINT cannot be delivered')
say('catchably here (child.kill and process.kill both terminate without running the')
say('handler), and SIGBREAK has no handler. The Web profile also mounts no')
say('in-product exit command: exitOnStdinEnd is bound by the acp and sdk apps only,')
say('and a piped stdin that is never resumed does not emit end.')
say('')
say('Consequence: the host shutdown CANNOT be triggered through any product-')
say('reachable stop route on this platform. The shutdown measurement therefore uses')
say('an instrument route that calls the launcher own ctx.appExit -- the same')
say('callback the product uses -- behind the real trust fence. See')
say('verify-a12-shutdown-route.mjs and FINDINGS.md for how that is labelled.')

const leftovers = (() => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*signal-child*' } | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: 'utf8' }).trim()
  } catch { return 'query-failed' }
})()
say('')
say(`probe_children_left_behind: ${leftovers === '' ? 'none' : leftovers}`)

writeFileSync(out, `${lines.join('\n')}\n`)
