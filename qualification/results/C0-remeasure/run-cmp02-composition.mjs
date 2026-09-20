/**
 * Re-measure CMP-02 on worktree wt-c7: boot the REAL profile and read the
 * resolved `sandbox-policy` row.
 *
 * THIS IS THE ORIGINAL INSTRUMENT, RE-POINTED, NOT A NEW ORACLE.
 *
 * The recorded FAIL cites two independent instruments. The first is this boot
 * probe (`verify-trusted-local-composition.mjs`, preserved verbatim in this
 * worktree at `.probe/`), which produced
 * `qualification/results/R1-trusted-local/composition-after-fixed.json` on
 * worktree wt-r1. The probe file is byte-identical here apart from nothing at
 * all -- it is the same file, and it reads `DSH_PROBE_OUT` from the environment
 * (`.probe/verify-trusted-local-composition.mjs:46`), so the only thing a
 * re-run needs is a driver that names THIS worktree's home and output path.
 *
 * WHY THE DRIVER HAD TO CHANGE. `run-trusted-local-composition.mjs` hardcodes
 * `D:/DSH/home/r1` and `D:/DSH/work/wt-r1/...`. Running it unchanged would boot
 * the WRONG home -- one whose profile resolves the MAIN tree, not this one --
 * and the measurement would describe a different composition than the one under
 * test. That is the G-SEAM-29/G-SEAM-36/G-SEAM-61 trap (a writer believing it
 * measured its own tree while resolving the main one), so the paths are the one
 * thing restated.
 *
 * WHAT IS MEASURED, and why a real boot is required rather than reading the
 * patch file: the patch stating `mode: danger-full-access` is the DECLARED fact.
 * The oracle is about the EFFECTIVE one. A patch row can be overridden by a
 * later overlay, dropped by the loader, or resolve through an expression. Only
 * the live composed graph distinguishes those.
 *
 * USAGE
 *   node qualification/results/C7-remeasure/run-cmp02-composition.mjs <label>
 */
import { bootAndWait, readResult } from '../../runners/boot-harness.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const label = process.argv[2] ?? 'run'
const HOME = 'D:/DSH/home/c7'
const DIR = 'D:/DSH/work/wt-c7/qualification/results/C7-remeasure'
const OUT = `${DIR}/cmp02-composition-${label}.json`

mkdirSync(DIR, { recursive: true })

const boot = await bootAndWait({
  patches: ['D:/DSH/work/wt-c7/qualification/results/C7-remeasure/cmp02-composition.patch.yml'],
  home: HOME,
  profile: 'daily',
  outPath: OUT,
  // A FOREIGN cwd, on purpose, matching the original run. The profile's own
  // directory would hide a cwd-relative defect, and `workspaceRoot` is
  // `!!js process.cwd()` -- so the cwd is part of what is being measured.
  // `C:/Windows/Temp` is on a different drive from the worktree.
  cwd: 'C:/Windows/Temp',
  timeoutMs: 180_000,
})

const { json, roots } = readResult(OUT, HOME)
writeFileSync(`${OUT}.boot.json`, JSON.stringify({ label, boot, roots }, null, 1))

const show = (k, v) => console.log(`  ${k.padEnd(34)} ${JSON.stringify(v)}`)
console.log(`=== CMP-02 / ${label} (wt-c7) ===`)
console.log(`port ${String(boot.port)} released=${String(boot.portReleased)} timedOut=${String(boot.timedOut)} exitCode=${String(boot.exitCode)}`)
show('presetDefaultId', json.presetDefaultId)
show('presetRoots', roots)
show('declared.rowPresent', json.declared?.rowPresent)
show('declared.rowFiberState', json.declared?.rowFiberState)
show('declared.configKeys', json.declared?.configKeys)
show('declared.configAsComposed', json.declared?.configAsComposed)
show('effective.policyServicePresent', json.effective?.policyServicePresent)
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

// ── The CMP-02 oracle, evaluated against the LIVE graph, clause by clause ────
//
// The spec's oracle has three clauses:
//   (a) a row with `id: sandbox-policy` is PRESENT (not deleted)
//   (b) its configured mode is `danger-full-access`
//   (c) its `workspaceRoot` resolves to an ABSOLUTE path
//
// Each is computed from the probe's own reading rather than restated, and the
// clause that fails (if any) is named.
const mode = json.effective?.defaultMode ?? null
const root = json.effective?.workspaceRoot ?? null
const isAbsolute = typeof root === 'string' && /^[A-Za-z]:[\\/]/.test(root)
const clauseA = json.declared?.rowPresent === true && json.declared?.rowDisabled !== true
const clauseB = mode === 'danger-full-access'
const clauseC = isAbsolute
console.log('--- CMP-02 oracle, clause by clause ---')
show('clauseA.rowPresent', clauseA)
show('clauseB.modeIsDangerFullAccess', clauseB)
show('clauseC.workspaceRootAbsolute', clauseC)
console.log(`VERDICT: ${clauseA && clauseB && clauseC ? 'HOLDS' : 'STILL FAILS'}`
  + `${clauseA && clauseB && clauseC ? '' : ` (failing clause(s): ${[!clauseA && 'a', !clauseB && 'b', !clauseC && 'c'].filter(Boolean).join(',')})`}`)

writeFileSync(`${OUT}.verdict.json`, JSON.stringify({
  case: 'CMP-02',
  worktree: 'D:/DSH/work/wt-c7',
  home: HOME,
  clauseA_rowPresentAndNotDisabled: clauseA,
  clauseB_configuredModeIsDangerFullAccess: clauseB,
  clauseC_workspaceRootIsAbsolute: clauseC,
  measured: {
    rowPresent: json.declared?.rowPresent,
    rowFiberState: json.declared?.rowFiberState,
    rowDisabled: json.declared?.rowDisabled,
    configAsComposed: json.declared?.configAsComposed,
    effectiveDefaultMode: mode,
    effectiveWorkspaceRoot: root,
    resolveNoSession: json.effective?.resolveNoSession,
    narrationText: json.narration?.sandboxPolicyContextText,
    ptcConfineDecision: json.ptc?.confineDecision,
  },
  verdict: clauseA && clauseB && clauseC ? 'HOLDS' : 'STILL FAILS',
  probeError: json.error,
}, null, 2))
