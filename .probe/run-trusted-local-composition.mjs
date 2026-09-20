/**
 * Run the trusted-local composition probe against a REAL boot of THIS worktree.
 *
 * WHY A DRIVER AND NOT A HAND-ROLLED BOOT. `boot-harness.mjs` picks a genuinely
 * free port by BINDING it (`--port 0` semantics, so writers cannot collide),
 * appends its own `webserver` overlay LAST with every key restated (a patch
 * REPLACES the whole `config` object), and VERIFIES the port is released. A
 * hand-rolled boot would have to reproduce all three, and the last one is the
 * one that matters: `EADDRINUSE` already produced one boot here that LOOKED like
 * a composition failure and cost an investigation.
 *
 * USAGE
 *   node .probe/run-trusted-local-composition.mjs <label>
 *
 * `<label>` names the run so the BEFORE and AFTER artifacts cannot be confused
 * for each other. `readResult()` then asserts the result names the home this
 * caller booted, which is what stops a shared output path from producing a false
 * PASS.
 */
import { bootAndWait, readResult } from '../qualification/runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const label = process.argv[2] ?? 'run'
const HOME = 'D:/DSH/home/r1'
const DIR = 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local'
const OUT = `${DIR}/composition-${label}.json`

mkdirSync(DIR, { recursive: true })

const boot = await bootAndWait({
  patches: ['D:/DSH/work/wt-r1/.probe/trusted-local-composition.patch.yml'],
  home: HOME,
  profile: 'daily',
  outPath: OUT,
  // A FOREIGN cwd, on purpose. The profile's own directory would hide a
  // cwd-relative defect, and the preset root was measured to be cwd-sensitive
  // once already (G-FIX-13). `C:/Windows/Temp` is on a different drive from the
  // worktree, so nothing resolves by accident of location.
  cwd: 'C:/Windows/Temp',
  timeoutMs: 180_000,
})

const { json, roots } = readResult(OUT, HOME)
writeFileSync(`${OUT}.boot.json`, JSON.stringify({ label, boot, roots }, null, 1))

const show = (k, v) => console.log(`  ${k.padEnd(34)} ${JSON.stringify(v)}`)
console.log(`=== ${label} ===`)
console.log(`port ${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)} exitCode=${String(boot.exitCode)}`)
show('presetDefaultId', json.presetDefaultId)
show('presetRoots', roots)
show('declared.rowPresent', json.declared?.rowPresent)
show('declared.configKeys', json.declared?.configKeys)
show('declared.configAsComposed', json.declared?.configAsComposed)
show('effective.defaultMode', json.effective?.defaultMode)
show('effective.workspaceRoot', json.effective?.workspaceRoot)
show('effective.resolveNoSession', json.effective?.resolveNoSession)
show('narration.contextNames', json.narration?.contextNames)
show('narration.saysWorkspaceWrite', json.narration?.saysWorkspaceWrite)
show('narration.saysDangerFullAccess', json.narration?.saysDangerFullAccess)
show('narration.sandboxPolicyContextText', json.narration?.sandboxPolicyContextText)
show('ptc.confineDecision', json.ptc?.confineDecision)
show('contract.ok', json.contract?.ok)
show('contract.violations', json.contract?.violations)
show('probe.error', json.error)
