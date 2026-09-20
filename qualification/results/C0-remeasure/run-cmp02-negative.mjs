/**
 * NEGATIVE CONTROL for CMP-02: boot the SAME profile with `mode` reverted to the
 * recorded defect's value, and confirm the probe reports it.
 *
 * This is the arm that makes the positive arm a measurement rather than a
 * restatement. Everything else -- the probe, the harness, the home, the cwd --
 * is identical to `run-cmp02-composition.mjs`; the ONLY difference is one extra
 * overlay that restates `sandbox-policy.mode` as `workspace-write`, the exact
 * string the recorded FAIL names.
 *
 * EXPECTED: clause B reads false, verdict STILL FAILS. If this arm instead reads
 * `danger-full-access`, the instrument is not sensitive to the row's value and
 * the positive arm's green result means nothing.
 *
 * USAGE
 *   node qualification/results/C7-remeasure/run-cmp02-negative.mjs <label>
 */
import { bootAndWait, readResult } from '../../runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const label = process.argv[2] ?? 'negative'
const HOME = 'D:/DSH/home/c7'
const DIR = 'D:/DSH/work/wt-c7/qualification/results/C7-remeasure'
const OUT = `${DIR}/cmp02-negative-${label}.json`

mkdirSync(DIR, { recursive: true })

const boot = await bootAndWait({
  patches: [
    'D:/DSH/work/wt-c7/qualification/results/C7-remeasure/cmp02-composition.patch.yml',
    // LAST, so it wins: an overlay applied later replaces the row's config.
    'D:/DSH/work/wt-c7/qualification/results/C7-remeasure/cmp02-negative-reverted-mode.patch.yml',
  ],
  home: HOME,
  profile: 'daily',
  outPath: OUT,
  cwd: 'C:/Windows/Temp',
  timeoutMs: 180_000,
})

const { json, roots } = readResult(OUT, HOME)
writeFileSync(`${OUT}.boot.json`, JSON.stringify({ label, boot, roots }, null, 1))

const mode = json.effective?.defaultMode ?? null
const root = json.effective?.workspaceRoot ?? null
const isAbsolute = typeof root === 'string' && /^[A-Za-z]:[\\/]/.test(root)
const clauseA = json.declared?.rowPresent === true && json.declared?.rowDisabled !== true
const clauseB = mode === 'danger-full-access'
const clauseC = isAbsolute

console.log(`=== CMP-02 NEGATIVE CONTROL / ${label} (wt-c7) ===`)
console.log(`  effective.defaultMode            ${JSON.stringify(mode)}`)
console.log(`  effective.workspaceRoot          ${JSON.stringify(root)}`)
console.log(`  narration.saysWorkspaceWrite     ${JSON.stringify(json.narration?.saysWorkspaceWrite)}`)
console.log(`  narration.saysDangerFullAccess   ${JSON.stringify(json.narration?.saysDangerFullAccess)}`)
console.log(`  narration.text                   ${JSON.stringify(json.narration?.sandboxPolicyContextText)}`)
console.log(`  clauseA.rowPresent               ${String(clauseA)}`)
console.log(`  clauseB.modeIsDangerFullAccess   ${String(clauseB)}`)
console.log(`  clauseC.workspaceRootAbsolute    ${String(clauseC)}`)
console.log(`VERDICT: ${clauseA && clauseB && clauseC ? 'HOLDS' : 'STILL FAILS'}`)
console.log('')
console.log(`INSTRUMENT SENSITIVITY: ${clauseB === false
  ? 'CONFIRMED — reverting the row value flips clause B, so the positive arm is a measurement.'
  : 'NOT CONFIRMED — the instrument reported the same value with the row reverted, so it cannot distinguish the fixed composition from the broken one and the positive arm must NOT be cited.'}`)

writeFileSync(`${OUT}.verdict.json`, JSON.stringify({
  case: 'CMP-02',
  arm: 'NEGATIVE CONTROL (mode reverted to the recorded defect value)',
  worktree: 'D:/DSH/work/wt-c7',
  home: HOME,
  expected: 'clauseB false; verdict STILL FAILS',
  clauseA_rowPresentAndNotDisabled: clauseA,
  clauseB_configuredModeIsDangerFullAccess: clauseB,
  clauseC_workspaceRootIsAbsolute: clauseC,
  measured: {
    effectiveDefaultMode: mode,
    effectiveWorkspaceRoot: root,
    narrationText: json.narration?.sandboxPolicyContextText,
    saysWorkspaceWrite: json.narration?.saysWorkspaceWrite,
    saysDangerFullAccess: json.narration?.saysDangerFullAccess,
    ptcConfineDecision: json.ptc?.confineDecision,
  },
  verdict: clauseA && clauseB && clauseC ? 'HOLDS' : 'STILL FAILS',
  instrumentSensitivityConfirmed: clauseB === false,
  probeError: json.error,
}, null, 2))
