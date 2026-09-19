/**
 * T2 control driver: run the SAME probe against the PRE-SWAP composition.
 *
 * WHY. The probe reports `hmr` in FiberState.LOADING and cannot tell whether the
 * fs swap caused it. This driver boots the identical profile with the swap
 * REVERTED (`verify-t2-fs-control.patch.yml`) and runs the identical probe, so
 * the only variable between the two runs is the provider row. The comparison is
 * then a measurement of the swap's effect rather than an argument about it.
 *
 * The result goes to a SEPARATE path, so it cannot overwrite the swap run's
 * evidence.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { bootAndWait, readResult } from './boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const RESULT_DIR = `${REPO}/qualification/results/T2-fs`
const HOME = 'D:/DSH/home/t2-fs-control'
const PROFILE = 'daily'
const OUT = `${RESULT_DIR}/control-boot.json`
const TRANSCRIPT = `${RESULT_DIR}/control-transcript.txt`

const digest = p => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null

const lines = []
const say = t => { lines.push(t); process.stdout.write(`${t}\n`) }

say('=== T2 CONTROL: the same probe against the PRE-SWAP composition ===')
say('')

// A separate home so the control cannot disturb the swap run's install. It is
// seeded from the SAME installed profile the swap run uses, then the control
// overlay flips the two rows back.
rmSync(HOME, { recursive: true, force: true })
mkdirSync(`${HOME}/profiles`, { recursive: true })
const seeded = `${HOME}/profiles/${PROFILE}`
mkdirSync(seeded, { recursive: true })
// Copy the resolved profile the swap run boots, so the ONLY difference is the
// overlay. `cp -r` semantics via node, bounded to this one directory.
const { cpSync } = await import('node:fs')
cpSync('D:/DSH/home/t2-fs/profiles/daily', seeded, { recursive: true })

say(`home:     ${HOME}`)
say(`seeded_from: D:/DSH/home/t2-fs/profiles/daily (the swap run's install)`)
say(`overlay:  ${REPO}/qualification/runners/verify-t2-fs-control.patch.yml`)
say(`probe_out: ${OUT}`)
say('')

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [
    `${REPO}/qualification/runners/verify-t2-fs-control.patch.yml`,
    `${REPO}/qualification/runners/verify-t2-fs.patch.yml`,
  ],
  outPath: OUT,
  cwd: 'D:/DSH/src/dsh-src',
})

say(`port: ${String(boot.port)}`)
say(`timed_out: ${String(boot.timedOut)}`)
say(`exit_code: ${String(boot.exitCode)}`)
say(`port_released_after_kill: ${String(boot.portReleased)}`)
say('')

let json
try {
  const read = readResult(OUT, HOME)
  json = read.json
  say(`result_names_this_home: true (presetRoots: ${read.roots.join(', ')})`)
} catch (error) {
  say(`result_names_this_home: FALSE -- ${error instanceof Error ? error.message : String(error)}`)
  say('--- host stderr (tail) ---')
  say(boot.stderr.split('\n').slice(-30).join('\n'))
  writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`, 'utf8')
  process.exit(2)
}
say('')

const warningLines = boot.stderr.split('\n').filter(l => l.includes('did not activate'))
say(`activation_warning_lines: ${JSON.stringify(warningLines)}`)
say('')

// THE COMPARISON. Both runs are read here so the delta is computed, not asserted.
const swapRun = JSON.parse(readFileSync(`${RESULT_DIR}/boot.json`, 'utf8'))
const comparison = {
  providerClassName: { swapped: swapRun.providerClassName ?? null, control: json.providerClassName ?? null },
  fsSandboxRowDisabled: { swapped: swapRun.fsSandboxRowDisabled ?? null, control: json.fsSandboxRowDisabled ?? null },
  fsLocalRowDisabled: { swapped: swapRun.fsLocalRowDisabled ?? null, control: json.fsLocalRowDisabled ?? null },
  fsLocalRowActive: { swapped: swapRun.fsLocalRowActive ?? null, control: json.fsLocalRowActive ?? null },
  sandboxClassInPrototypeChain: { swapped: swapRun.sandboxClassInPrototypeChain ?? null, control: json.sandboxClassInPrototypeChain ?? null },
  outsideWorkspaceWriteSucceeded: { swapped: swapRun.outsideWorkspaceWriteSucceeded ?? null, control: json.outsideWorkspaceWriteSucceeded ?? null },
  escalationFieldsAdvertised: { swapped: swapRun.escalationFieldsAdvertised ?? null, control: json.escalationFieldsAdvertised ?? null },
  nonActiveEntries: { swapped: swapRun.nonActiveEntries ?? null, control: json.nonActiveEntries ?? null },
  inactiveEntryIds: { swapped: swapRun.inactiveEntryIds ?? null, control: json.inactiveEntryIds ?? null },
  toolCount: { swapped: swapRun.toolCount ?? null, control: json.toolCount ?? null },
}
comparison.inactiveEntryIdsIdentical =
  JSON.stringify(comparison.inactiveEntryIds.swapped) === JSON.stringify(comparison.inactiveEntryIds.control)
comparison.providerActuallyDiffers =
  comparison.providerClassName.swapped !== comparison.providerClassName.control

say('--- the swap run vs the control run ---')
say(JSON.stringify(comparison, null, 2))
say('')

const verdict = {
  ok: true,
  purpose: 'control for the T2 fs-provider swap: the same probe against the pre-swap composition',
  home: HOME,
  overlay: `${REPO}/qualification/runners/verify-t2-fs-control.patch.yml`,
  compositionInstalled: digest(`${HOME}/profiles/${PROFILE}/cordis.patch.yml`),
  boot: { port: boot.port, timedOut: boot.timedOut, exitCode: boot.exitCode, portReleased: boot.portReleased },
  activationWarningLines: warningLines,
  comparison,
}
writeFileSync(`${RESULT_DIR}/CONTROL.json`, JSON.stringify(verdict, null, 2), 'utf8')
writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`, 'utf8')
say(`control verdict: ${RESULT_DIR}/CONTROL.json`)
process.exit(0)
