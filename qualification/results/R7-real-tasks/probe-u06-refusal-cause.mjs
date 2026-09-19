#!/usr/bin/env node
/**
 * R7 probe — WHY the rewound-ledger refusal in `M9.20-real-tasks/u06-rollback.json`
 * actually fires.
 *
 * THE CLAIM UNDER TEST
 * ====================
 * `u06-rollback.json` records step R8a as PASS with this detail:
 *
 *   "the facility refused to open: domain 'dsh_daily_effects': stored record
 *    'eff_...' in table 'operations' does not match its schema"
 *
 * and `u06-rollback.mjs` explains that refusal in its own comment as:
 *
 *   "The effect record lives in the state that was just rewound. Rewinding to
 *    the pre-upgrade snapshot therefore removes the record of an effect the
 *    WORLD still remembers -- and the domain facility then refuses to open."
 *
 * That explanation is checkable against the script's own code, and it does not
 * hold. In `u06-rollback.mjs`:
 *
 *   line 143  const stateRoot  = join(work, 'state')        <-- rewound at 300-302
 *   line 229  const effectStore = join(work, 'effect-store') <-- NEVER rewound
 *
 * The effect store is a SIBLING of the state directory. Lines 300-302 remove and
 * restore `stateRoot` only; `effectStore` is untouched. So the rewind cannot be
 * the cause of a refusal to read a record in `effectStore`.
 *
 * THE ACTUAL CAUSE
 * ================
 * `u06-rollback.mjs`'s remote adapter returns `{ kind: 'accepted', resultRef }`.
 * The ledger's contract (`src/effects.ts:253-256`) is
 * `EffectPerformResult = { status: 'confirmed' | 'not_started' | 'unknown', ... }`.
 * There is no `kind` field. So `result.status` is `undefined`, `send()` writes
 * `status: undefined` into the record (`effects.ts:868-877`), and on the next
 * open the zod schema (`status: z.enum(EFFECT_RECORD_STATUSES)`) rejects it.
 *
 * This probe separates the two hypotheses by running BOTH arms over stores that
 * are NEVER rewound:
 *
 *   ARM A  the u06 adapter shape  (`{ kind: 'accepted' }`)  -> expect a refusal
 *   ARM B  a contract-correct adapter (`{ status: 'confirmed' }`) -> expect a clean open
 *
 * If ARM A refuses with the same message while ARM B opens cleanly, and neither
 * store was rewound, then the refusal is caused by the malformed record and NOT
 * by any state rewind. ARM A and ARM B differ in exactly one thing -- the
 * adapter's return shape -- so the difference is attributable to it.
 *
 * USAGE
 * =====
 *   node qualification/results/R7-real-tasks/probe-u06-refusal-cause.mjs
 *
 * Exit 0 when the probe's predictions hold. Exit 1 when they do not, which would
 * mean the u06 explanation is right after all and this probe is wrong.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/DSH/work/dsh-native-daily'
const PKG = `${REPO}/packages/dsh-daily-work`
const OUT = `${REPO}/qualification/results/R7-real-tasks/probe-u06-refusal-cause.json`

const { createRequire } = await import('node:module')
const requireFromPackage = createRequire(join(PKG, 'package.json'))
const importPeer = async (name) => await import(pathToFileURL(requireFromPackage.resolve(name)).href)

const { Context } = await importPeer('@deepseek-ai/cordis')
const { EffectLedger, identify } = await import(pathToFileURL(join(PKG, 'src/effects.ts')).href)
const Storage = await importPeer('@deepseek-ai/dsh-storage')
const storageJsonPlugin = await importPeer('@deepseek-ai/dsh-storage-json')
const storageDomainPlugin = await importPeer('@deepseek-ai/dsh-storage-domain')

const INTENT = {
  kind: 'r7-probe-send',
  logicalKey: 'probe/arm/notify',
  parameters: { runId: 'probe', taskId: 'task-1', body: 'probe' },
}

/**
 * Run one arm: perform through an adapter, close, then re-open a FRESH ledger
 * over the SAME store. Nothing is ever rewound in either arm.
 *
 * @param label - arm name for the report.
 * @param makeResult - builds the adapter's `perform` return value.
 */
async function arm(label, makeResult) {
  const store = mkdtempSync(join(tmpdir(), `r7-probe-${label}-`))
  const adapter = {
    kind: INTENT.kind,
    capabilities: { idempotencyKey: true, queryable: true },
    perform: () => Promise.resolve(makeResult()),
    query: () => Promise.resolve({ status: 'confirmed', resultRef: 'probe-1' }),
  }

  // First process-half: perform the effect.
  const ctx1 = new Context()
  await ctx1.plugin(Storage.default ?? Storage)
  await ctx1.plugin(storageJsonPlugin.default ?? storageJsonPlugin, { root: store })
  await ctx1.plugin(storageDomainPlugin.default ?? storageDomainPlugin, { backend: 'json' })
  const ledger1 = new EffectLedger(ctx1)
  await ledger1.open()
  const attempt = await ledger1.perform(adapter, INTENT)
  const operationId = identify(INTENT).operationId
  const stored = ledger1.get(operationId)
  await ledger1.close()
  await ctx1.fiber.dispose()

  // What actually landed on disk. This is the decisive datum: the schema the
  // domain will validate against on the next open.
  const storeFile = join(store, 'dsh_daily_effects.json')
  const onDisk = existsSync(storeFile)
    ? JSON.parse(readFileSync(storeFile, 'utf8')).tables.operations[operationId]
    : null

  // Second process-half: re-open over the SAME store. NOTHING WAS REWOUND.
  const ctx2 = new Context()
  await ctx2.plugin(Storage.default ?? Storage)
  await ctx2.plugin(storageJsonPlugin.default ?? storageJsonPlugin, { root: store })
  await ctx2.plugin(storageDomainPlugin.default ?? storageDomainPlugin, { backend: 'json' })
  const ledger2 = new EffectLedger(ctx2)
  let reopened = true
  let refusal = null
  try {
    await ledger2.open()
  } catch (error) {
    reopened = false
    refusal = error instanceof Error ? error.message : String(error)
  }
  if (reopened) await ledger2.close()
  await ctx2.fiber.dispose()
  rmSync(store, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

  return {
    label,
    attemptedOutcome: attempt.outcome,
    attemptedPerformed: attempt.performed,
    storedStatus: stored?.status ?? null,
    storedStatusType: typeof stored?.status,
    onDiskStatus: onDisk?.status ?? null,
    onDiskStatusType: typeof onDisk?.status,
    reopened,
    refusal,
  }
}

process.stdout.write('ARM A: the u06 adapter shape, { kind: "accepted" }, store NEVER rewound\n')
const armA = await arm('u06-shape', () => ({ kind: 'accepted', resultRef: 'probe-1' }))
process.stdout.write(`  stored status: ${JSON.stringify(armA.storedStatus)} (typeof ${armA.storedStatusType})\n`)
process.stdout.write(`  on-disk status: ${JSON.stringify(armA.onDiskStatus)} (typeof ${armA.onDiskStatusType})\n`)
process.stdout.write(`  re-open over the SAME store succeeded: ${String(armA.reopened)}\n`)
process.stdout.write(`  refusal: ${armA.refusal === null ? 'none' : armA.refusal.slice(0, 200)}\n\n`)

process.stdout.write('ARM B: a contract-correct adapter, { status: "confirmed" }, store NEVER rewound\n')
const armB = await arm('correct-shape', () => ({ status: 'confirmed', resultRef: 'probe-1' }))
process.stdout.write(`  stored status: ${JSON.stringify(armB.storedStatus)} (typeof ${armB.storedStatusType})\n`)
process.stdout.write(`  on-disk status: ${JSON.stringify(armB.onDiskStatus)} (typeof ${armB.onDiskStatusType})\n`)
process.stdout.write(`  re-open over the SAME store succeeded: ${String(armB.reopened)}\n`)
process.stdout.write(`  refusal: ${armB.refusal === null ? 'none' : armB.refusal.slice(0, 200)}\n\n`)

// The predictions. ARM A must refuse with the SAME message u06 recorded, and
// ARM B must open cleanly. Both stores were untouched by any rewind, so a
// refusal in ARM A is attributable to the adapter shape alone.
const armARefusedLikeU06 = !armA.reopened && /does not match its schema/.test(armA.refusal ?? '')
const armBClean = armB.reopened
const predictionHolds = armARefusedLikeU06 && armBClean

const report = {
  probe: 'R7-u06-refusal-cause',
  question:
    'Is the rewound-ledger refusal recorded as u06 step R8a caused by the state rewind (as u06-rollback.mjs explains) '
    + 'or by the malformed effect record the u06 adapter writes?',
  design:
    'Two arms, identical except for the adapter return shape. NEITHER store is rewound, so the u06 explanation '
    + 'predicts no refusal in either arm. A refusal in ARM A and a clean open in ARM B isolates the cause.',
  armA,
  armB,
  findings: {
    armARefusedLikeU06,
    armBClean,
    predictionHolds,
  },
  conclusion: predictionHolds
    ? 'The refusal is caused by the ADAPTER RETURN SHAPE, not by the state rewind. u06\'s adapter returns '
      + '{ kind: "accepted" } where the contract (src/effects.ts:253-256) requires { status: "confirmed" }, so '
      + 'status is written as undefined and the zod enum rejects the record on the next open. u06 step R8a\'s '
      + 'narrative -- that the record "lives in the state that was just rewound" -- is not supported by '
      + 'u06-rollback.mjs\'s own code: its effect store is a SIBLING of the state directory and is never rewound.'
    : 'The probe did NOT reproduce the u06 refusal, so this probe is wrong or the environment differs. The u06 '
      + 'narrative must be re-examined against the actual cause before either is relied on.',
  u06CodeFacts: {
    stateRoot: 'u06-rollback.mjs:143 — join(work, "state")',
    effectStore: 'u06-rollback.mjs:229 — join(work, "effect-store"), a SIBLING of stateRoot',
    rewind: 'u06-rollback.mjs:300-302 — rmSync + cpSync on stateRoot ONLY; effectStore is untouched',
    adapter: 'u06-rollback.mjs remote.perform returns { kind: "accepted", resultRef }',
    contract: 'src/effects.ts:253-256 — EffectPerformResult carries `status`, not `kind`',
  },
}

const { writeFileSync } = await import('node:fs')
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`probe report: ${OUT}\n`)
process.stdout.write(`prediction holds: ${String(predictionHolds)}\n`)
process.exit(predictionHolds ? 0 : 1)
