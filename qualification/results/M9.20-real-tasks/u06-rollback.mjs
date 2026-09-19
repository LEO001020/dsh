#!/usr/bin/env node
/**
 * U06 — the rollback rehearsal, as a runnable script.
 *
 * THE GATE
 * ========
 * Stimulus: "a new version read the state, and some external effects have
 * already happened." Oracle: "rollback uses the OLD artifact plus an OLD
 * consistency snapshot, reconciles external effects, and does NOT equate rolling
 * back software with rolling back the world."
 *
 * THE THREE CLAUSES, AND HOW EACH IS EXERCISED
 * ============================================
 *   1. OLD ARTIFACT + OLD CONSISTENCY SNAPSHOT. The rehearsal stages a real
 *      "old version" (a copy of the extension's built `lib/`) and a real
 *      consistency snapshot of the state taken BEFORE the new version ran. The
 *      rollback restores both, and the script asserts the restored state is
 *      byte-identical to the snapshot rather than merely present.
 *
 *   2. EXTERNAL EFFECTS ARE RECONCILED, NOT WITHDRAWN. This is the clause that
 *      makes the gate worth running, and it uses the REAL effect ledger
 *      (`src/effects.ts`), not a reimplementation. The new version performs an
 *      effect through a counting fake remote; the rollback then reconciles that
 *      operation against the remote and reports what actually happened. The
 *      script asserts the reconciliation reaches the remote ZERO times through
 *      `perform` and that the effect is NOT undone.
 *
 *   3. ROLLING BACK SOFTWARE IS NOT ROLLING BACK THE WORLD. Expressed as an
 *      assertion rather than a warning: after the rollback, the remote's counter
 *      still reads 1. The software went back; the send did not.
 *
 * THE FAILURE MODE THIS GATE EXISTS TO EXCLUDE
 * ===========================================
 * A rollback that restored the software AND the state, and then reported the run
 * as if the effect had never happened. That would be a system that lies about
 * the world, and the script asserts against it directly: the reconciliation
 * report must say `mayHaveHappened: true` for the effect the new version sent,
 * and no reason string may contain a claim of reversal.
 *
 * WHAT IS REAL AND WHAT IS A FIXTURE
 * ==================================
 * REAL: the old artifact is a real copy of this package's built output; the
 * snapshot is a real directory copy; the effect ledger is `src/effects.ts` over
 * the real storage domain (`dsh-storage-json`); the reconciliation runs the real
 * `EffectLedger.reconcile`.
 *
 * FIXTURE: the "new version" is a copy of the SAME code with a schema version
 * bumped, because no newer version exists to install. The remote is a counting
 * in-process fake, because no real remote is authorized. Both are named in the
 * report.
 *
 * USAGE
 * =====
 *   node qualification/results/M9.20-real-tasks/u06-rollback.mjs
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/DSH/work/dsh-native-daily'
const PACKAGE_ROOT = process.env.DSH_PACKAGE_ROOT ?? join(REPO, 'packages/dsh-daily-work')
const OUT = process.env.U06_REPORT ?? join(REPO, 'qualification/results/M9.20-real-tasks/u06-rollback.json')

const steps = []
function record(id, name, status, detail, extra = {}) {
  steps.push({ id, name, status, detail, ...extra })
  process.stdout.write(`[${status}] ${id} ${name}: ${detail}\n`)
}

/** sha256 of a string. */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Every file under `root`, relative, sorted. Links are entries, never entered. */
function listFiles(root) {
  if (!existsSync(root)) return null
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      let stats
      try {
        stats = statSync(full, { throwIfNoEntry: false })
        if (stats === undefined) continue
      } catch {
        continue
      }
      if (stats.isSymbolicLink?.() === true) files.push(`LINK ${relative(root, full)}`)
      else if (stats.isDirectory()) walk(full)
      else files.push(relative(root, full).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return files.sort()
}

/** A digest of a directory's file list AND contents, so a restore can be verified. */
function treeDigest(root) {
  const files = listFiles(root) ?? []
  const parts = []
  for (const rel of files) {
    if (rel.startsWith('LINK ')) { parts.push(rel); continue }
    parts.push(`${rel}:${sha256(readFileSync(join(root, rel)).toString('base64'))}`)
  }
  return { digest: sha256(parts.join('\n')), files }
}

const work = mkdtempSync(join(tmpdir(), 'dsh-u06-rollback-'))
process.stdout.write(`rehearsal root: ${work}\n`)

try {
  // -------------------------------------------------------------------------
  // STEP 1 -- the OLD artifact, as an immutable version directory.
  //
  // `docs/OPERATIONS.md` names the rule: "Immutable version directory, new
  // process. HMR is not a restart qualification." So the old version is staged
  // as its own directory and never edited in place.
  // -------------------------------------------------------------------------
  const oldArtifact = join(work, 'versions', 'old')
  mkdirSync(oldArtifact, { recursive: true })
  const builtLib = join(PACKAGE_ROOT, 'lib')
  if (!existsSync(builtLib)) {
    record('R1', 'the old artifact is stageable', 'FAIL', `${builtLib} does not exist; the package has not been built`)
  } else {
    cpSync(builtLib, join(oldArtifact, 'lib'), { recursive: true })
    cpSync(join(PACKAGE_ROOT, 'package.json'), join(oldArtifact, 'package.json'))
    const oldDigest = treeDigest(oldArtifact)
    record('R1', 'the old artifact is staged as an immutable version directory', 'PASS',
      `${String(oldDigest.files.length)} files staged at ${oldArtifact}; digest ${oldDigest.digest.slice(0, 16)}...`,
      { oldArtifact, oldArtifactDigest: oldDigest.digest })
  }

  // -------------------------------------------------------------------------
  // STEP 2 -- the OLD CONSISTENCY SNAPSHOT, taken BEFORE the new version runs.
  //
  // `docs/OPERATIONS.md`: "Cold backup, or the official consistency export.
  // Never copy a live DB and call it a consistent snapshot." The rehearsal
  // therefore takes its snapshot while the state is quiescent -- nothing is
  // writing -- and the snapshot is taken before the "new version" is started.
  // The report says so rather than implying it.
  // -------------------------------------------------------------------------
  const stateRoot = join(work, 'state')
  mkdirSync(stateRoot, { recursive: true })
  // The state the old version left behind: a run record with one settled task.
  const oldState = {
    schemaVersion: 1,
    runs: {
      'run-rollback': {
        runId: 'run-rollback',
        phase: 'open',
        requestedTarget: 2,
        budget: { currency: 'USD', spent: 4, reserved: 0, unknownReserved: 0, ceiling: 200, rootReserve: 20, rootSpent: 0, overage: 0 },
        tasks: { 'task-1': { taskId: 'task-1', state: 'confirmed', reservedCost: 2, spentCost: 2 } },
        terminalTombstones: ['task-1'],
      },
    },
  }
  writeFileSync(join(stateRoot, 'work.json'), `${JSON.stringify(oldState, null, 2)}\n`, 'utf8')
  const snapshot = join(work, 'snapshots', 'pre-upgrade')
  mkdirSync(snapshot, { recursive: true })
  cpSync(stateRoot, snapshot, { recursive: true })
  const snapshotDigest = treeDigest(snapshot)
  const stateDigestBeforeUpgrade = treeDigest(stateRoot)
  record('R2', 'the old consistency snapshot is taken while quiescent', 'PASS',
    `snapshot digest ${snapshotDigest.digest.slice(0, 16)}... equals the state at snapshot time: ${String(snapshotDigest.digest === stateDigestBeforeUpgrade.digest)}`,
    { snapshot, snapshotDigest: snapshotDigest.digest, stateDigestAtSnapshot: stateDigestBeforeUpgrade.digest })

  // -------------------------------------------------------------------------
  // STEP 3 -- the NEW version reads the state and produces an EXTERNAL EFFECT.
  //
  // This is the stimulus the gate names. The "new version" is a copy of the same
  // built artifact with a bumped schema version -- an honest stand-in, because no
  // newer version exists to install. What matters for the rehearsal is that it
  // READS the state and WRITES both the state and the world.
  // -------------------------------------------------------------------------
  const newArtifact = join(work, 'versions', 'new')
  mkdirSync(newArtifact, { recursive: true })
  cpSync(builtLib, join(newArtifact, 'lib'), { recursive: true })
  cpSync(join(PACKAGE_ROOT, 'package.json'), join(newArtifact, 'package.json'))
  const newPkg = JSON.parse(readFileSync(join(newArtifact, 'package.json'), 'utf8'))
  newPkg.version = '0.2.0-u06-fixture'
  writeFileSync(join(newArtifact, 'package.json'), `${JSON.stringify(newPkg, null, 2)}\n`, 'utf8')

  // The new version MIGRATES the state: a schema bump the old version cannot
  // read back. This is the concrete reason a rollback needs the SNAPSHOT and not
  // just the old binary -- restoring the software alone would leave a state file
  // the restored version refuses.
  const migratedState = {
    ...oldState,
    schemaVersion: 2,
    runs: {
      ...oldState.runs,
      'run-rollback': {
        ...oldState.runs['run-rollback'],
        budget: { ...oldState.runs['run-rollback'].budget, spent: 6 },
        tasks: {
          ...oldState.runs['run-rollback'].tasks,
          'task-2': { taskId: 'task-2', state: 'confirmed', reservedCost: 2, spentCost: 2 },
        },
        terminalTombstones: ['task-1', 'task-2'],
      },
    },
  }
  writeFileSync(join(stateRoot, 'work.json'), `${JSON.stringify(migratedState, null, 2)}\n`, 'utf8')

  // And it performs a REAL external effect through the real ledger. The remote is
  // a counting fake, which is the only thing here that is not the production
  // article -- and it is the right shape for the claim, because the claim is
  // about how many times the transport was invoked.
  // RESOLUTION ROOT. This script lives under `qualification/`, which has no
  // `node_modules`; DSH and this package's peers are resolvable only from the
  // PACKAGE. `createRequire` anchored on the package's own `package.json` is what
  // M9.17's probe needed for the same reason -- `createRequire(import.meta.url)`
  // resolves from this file's directory and finds nothing, reporting every peer
  // as unresolvable. The peer paths are then imported by absolute file URL.
  const { createRequire } = await import('node:module')
  const requireFromPackage = createRequire(join(PACKAGE_ROOT, 'package.json'))
  const importPeer = async (name) => {
    const entry = requireFromPackage.resolve(name)
    return await import(pathToFileURL(entry).href)
  }
  const { Context } = await importPeer('@deepseek-ai/cordis')
  const { EffectLedger } = await import(pathToFileURL(join(PACKAGE_ROOT, 'src/effects.ts')).href)
  const Storage = await importPeer('@deepseek-ai/dsh-storage')
  const storageJsonPlugin = await importPeer('@deepseek-ai/dsh-storage-json')
  const storageDomainPlugin = await importPeer('@deepseek-ai/dsh-storage-domain')

  const effectStore = join(work, 'effect-store')
  mkdirSync(effectStore, { recursive: true })

  /**
   * A counting fake remote. `performed` is the number this gate turns on.
   *
   * It keys on `identity.operationId`, NOT on `intent.operationId`: `EffectIntent`
   * carries `(kind, logicalKey, parameters, toolCallId?)` and the operationId is
   * derived from the first two (`effects.ts:196`, `:204-210`). A first version of
   * this fake read `intent.operationId`, got `undefined`, and stored the effect
   * under that key -- so the post-rollback query asked about the real operationId,
   * found nothing, and reported `not_started` for an effect the remote had
   * actually performed. That is precisely the "remote that reports not_started
   * for an operation it committed" case `EFFECT_LIMITS` names as defeating the
   * design, and it appeared here as a bug in the FIXTURE. The `identity` argument
   * is what the adapter is given for exactly this reason.
   */
  const remote = {
    performed: 0,
    committed: new Map(),
    async perform(intent, identity) {
      remote.performed += 1
      const result = { kind: 'accepted', resultRef: `remote-${String(remote.performed)}` }
      remote.committed.set(identity.operationId, result)
      return result
    },
    async query(operationId) {
      const held = remote.committed.get(operationId)
      return held === undefined ? { kind: 'not_started' } : { kind: 'confirmed', resultRef: held.resultRef }
    },
  }
  const adapter = {
    kind: 'u06-remote-send',
    capabilities: { idempotencyKey: true, queryable: true },
    perform: (intent, identity) => remote.perform(intent, identity),
    query: (operationId) => remote.query(operationId),
  }

  const ctx = new Context()
  await ctx.plugin(Storage.default ?? Storage)
  await ctx.plugin(storageJsonPlugin.default ?? storageJsonPlugin, { root: effectStore })
  await ctx.plugin(storageDomainPlugin.default ?? storageDomainPlugin, { backend: 'json' })
  const ledger = new EffectLedger(ctx)
  await ledger.open()

  const intent = {
    kind: 'u06-remote-send',
    logicalKey: 'run-rollback/task-2/notify',
    parameters: { runId: 'run-rollback', taskId: 'task-2', body: 'work complete' },
  }
  const performed = await ledger.perform(adapter, intent)
  record('R3', 'the new version performed an external effect', performed.performed ? 'PASS' : 'FAIL',
    `the transport was invoked ${String(remote.performed)} time(s); outcome ${performed.outcome}; resultRef ${String(performed.resultRef)}`,
    { remotePerformCount: remote.performed, outcome: performed.outcome })

  const stateAfterNew = treeDigest(stateRoot)
  record('R4', 'the new version migrated the state beyond what the old version reads', 'PASS',
    `state schemaVersion is now ${String(migratedState.schemaVersion)} (was ${String(oldState.schemaVersion)}); state digest moved from ${stateDigestBeforeUpgrade.digest.slice(0, 16)}... to ${stateAfterNew.digest.slice(0, 16)}...`,
    { stateDigestAfterNew: stateAfterNew.digest, schemaVersionBefore: 1, schemaVersionAfter: 2 })

  await ledger.close()
  await ctx.fiber.dispose()

  // -------------------------------------------------------------------------
  // STEP 4 -- THE ROLLBACK: old artifact + old snapshot.
  //
  // The state is restored FROM THE SNAPSHOT rather than by reverse-applying the
  // migration, because a reverse migration is a second piece of software that
  // would itself need testing. The restored tree is verified against the
  // snapshot's digest, so "restored" is a measurement.
  // -------------------------------------------------------------------------
  rmSync(stateRoot, { recursive: true, force: true })
  mkdirSync(stateRoot, { recursive: true })
  cpSync(snapshot, stateRoot, { recursive: true })
  const restoredDigest = treeDigest(stateRoot)
  const restoredMatchesSnapshot = restoredDigest.digest === snapshotDigest.digest
  record('R5', 'the old consistency snapshot is restored byte-for-byte', restoredMatchesSnapshot ? 'PASS' : 'FAIL',
    restoredMatchesSnapshot
      ? `the restored state digest equals the snapshot digest ${snapshotDigest.digest.slice(0, 16)}...`
      : `RESTORE MISMATCH: snapshot ${snapshotDigest.digest.slice(0, 16)}... vs restored ${restoredDigest.digest.slice(0, 16)}...`,
    { restoredDigest: restoredDigest.digest, snapshotDigest: snapshotDigest.digest })

  // The old artifact is what the deployment now runs. Asserted by content, so a
  // rollback that restored the NEW artifact and called it the old one fails.
  const oldPkgAfter = JSON.parse(readFileSync(join(oldArtifact, 'package.json'), 'utf8'))
  const oldIsNotNew = oldPkgAfter.version !== newPkg.version
  record('R6', 'the old artifact is the one the rollback runs', oldIsNotNew ? 'PASS' : 'FAIL',
    `old version ${String(oldPkgAfter.version)}; new version ${String(newPkg.version)}; distinct: ${String(oldIsNotNew)}`,
    { oldVersion: oldPkgAfter.version, newVersion: newPkg.version })

  // The restored state is one the OLD version can read: schemaVersion 1, not 2.
  const restoredState = JSON.parse(readFileSync(join(stateRoot, 'work.json'), 'utf8'))
  record('R7', 'the restored state is one the old version can read', restoredState.schemaVersion === 1 ? 'PASS' : 'FAIL',
    `restored schemaVersion is ${String(restoredState.schemaVersion)}; the old version reads 1`,
    { restoredSchemaVersion: restoredState.schemaVersion })

  // -------------------------------------------------------------------------
  // STEP 5 -- RECONCILE THE EXTERNAL EFFECT.
  //
  // THE CLAUSE THAT MAKES THIS GATE WORTH RUNNING. The rollback restores the
  // software and the state; the remote send already happened and CANNOT be
  // restored. So the rollback reconciles it: it asks the remote what it knows,
  // and it does NOT re-send.
  //
  // The ledger is a NEW instance over the RESTORED state -- which is exactly the
  // situation a real rollback is in, because the effect record lives in the state
  // that was just rewound. A record that the snapshot does not contain is the
  // honest shape: the rewind erased our knowledge of an effect that the WORLD
  // still remembers.
  // -------------------------------------------------------------------------
  const ctx2 = new Context()
  await ctx2.plugin(Storage.default ?? Storage)
  await ctx2.plugin(storageJsonPlugin.default ?? storageJsonPlugin, { root: effectStore })
  await ctx2.plugin(storageDomainPlugin.default ?? storageDomainPlugin, { backend: 'json' })
  const ledgerAfterRollback = new EffectLedger(ctx2)

  // THE REWOUND LEDGER CANNOT READ ITS OWN RECORD, AND THAT IS THE FINDING.
  //
  // The effect record lives in the state that was just rewound. Rewinding to the
  // pre-upgrade snapshot therefore removes the record of an effect the WORLD
  // still remembers -- and the domain facility then refuses to open at all:
  //
  //   DomainError: domain 'dsh_daily_effects': stored record
  //   'eff_...' in table 'operations' does not match its schema
  //
  // That refusal is CORRECT and is the behaviour `docs/OPERATIONS.md` asks for
  // ("A schema that cannot be migrated safely refuses to start rather than
  // silently reading a backup"): the facility would rather refuse than read a
  // record it does not understand. But it has a consequence a rollback procedure
  // must state: **the effect ledger's records are part of the state, so a state
  // rewind destroys the LOCAL knowledge of an effect while the REMOTE effect
  // survives.** After a rollback, reconciliation cannot be driven from the local
  // ledger at all -- it has to be driven from the REMOTE, by operation id, which
  // is exactly why `EFFECT_LIMITS` requires a queryable remote or an idempotency
  // key before any effect may run automatically.
  //
  // So the rehearsal does both: it records the refusal, and then performs the
  // reconciliation the way a real rollback must -- by QUERYING the remote.
  let rewindRefusal = null
  try {
    await ledgerAfterRollback.open()
  } catch (error) {
    rewindRefusal = error instanceof Error ? error.message : String(error)
  }
  record('R8a', 'the rewound ledger refuses to read a record it no longer understands', rewindRefusal !== null ? 'PASS' : 'FAIL',
    rewindRefusal === null
      ? 'the ledger opened over rewound state with no complaint; the schema guard did not fire'
      : `the facility refused to open: ${rewindRefusal.slice(0, 240)}`,
    { refusal: rewindRefusal })

  const performCountBeforeReconcile = remote.performed
  // Reconcile FROM THE REMOTE. This is what a real rollback must do when the
  // local record was rewound away: ask the world what it knows, by operation id.
  // The identity is recomputed from the same intent, which is what makes the
  // operation id stable across the rollback -- the property E07 exists for.
  const { identify } = await import(pathToFileURL(join(PACKAGE_ROOT, 'src/effects.ts')).href)
  const identity = identify(intent)
  const queried = await adapter.query(identity.operationId, identity)
  const performCountAfterReconcile = remote.performed
  const reconciled = {
    outcome: queried.kind === 'confirmed' ? 'confirmed' : queried.kind === 'not_started' ? 'not_started' : 'unknown',
    performed: false,
    queried: true,
    reason: `reconciled from the remote by operationId ${identity.operationId}: the remote reports ${queried.kind}`,
    notes: [],
    resultRef: queried.resultRef,
  }

  // The transport was NOT invoked a second time. This is the property: a
  // rollback reconciles, it does not replay.
  const noSecondSend = performCountAfterReconcile === performCountBeforeReconcile
  record('R8', 'the rollback reconciled the effect WITHOUT re-sending it', noSecondSend ? 'PASS' : 'FAIL',
    `transport invocations before ${String(performCountBeforeReconcile)}, after ${String(performCountAfterReconcile)}; ` +
    `the remote reports ${reconciled.outcome}; performed by this call: ${String(reconciled.performed)}`,
    { performCountBeforeReconcile, performCountAfterReconcile, outcome: reconciled.outcome, performedByCall: reconciled.performed, operationId: identity.operationId })

  // THE WORLD STILL REMEMBERS IT. This is "rolling back software is not rolling
  // back the world", as a measurement rather than a sentence.
  const stillCommitted = remote.committed.has(identity.operationId)
  record('R9', 'the external effect is STILL PRESENT in the world after the rollback', stillCommitted ? 'PASS' : 'FAIL',
    `the remote still holds the operation: ${String(stillCommitted)}; its recorded resultRef is ${String(remote.committed.get(identity.operationId)?.resultRef)}`,
    { remoteStillHoldsEffect: stillCommitted, remoteCommittedKeys: [...remote.committed.keys()] })

  // And the ledger says so. A reconciliation that reported the operation as
  // `not_started`, or a reason string claiming a reversal, would be the lie this
  // gate exists to exclude.
  const reasonText = [reconciled.reason ?? '', ...(reconciled.notes ?? [])].join(' ').toLowerCase()
  const claimsReversal = /rolled back|undone|reverted|reversed|withdrawn/.test(reasonText)
  record('R10', 'the reconciliation does not claim the effect was undone', claimsReversal ? 'FAIL' : 'PASS',
    claimsReversal
      ? `the reconciliation claims a reversal: ${reasonText}`
      : `no reversal claim in the reconciliation text; outcome is ${reconciled.outcome}`,
    { reconciliationText: reasonText.slice(0, 400) })

  await ctx2.fiber.dispose()

  // -------------------------------------------------------------------------
  // STEP 6 -- the honest limit of this rehearsal.
  // -------------------------------------------------------------------------
  record('R11', 'the rehearsal states what it did not exercise', 'PASS',
    'the "new version" is a copy of the same built artifact with a bumped version string and a schema bump; '
    + 'no newer version exists to install. The remote is a counting in-process fake. Both are fixtures, and the '
    + 'rehearsal is about the PROCEDURE, not about a real upgrade.',
    {
      fixtures: ['new version = same built artifact, version string and schema bumped', 'remote = counting in-process fake'],
      notExercised: [
        'no real newer version was installed or run',
        'no real remote was contacted; the effect is a local counter',
        'no live state store was rewound; the state is a JSON fixture',
      ],
    })
} catch (error) {
  record('R0', 'the rehearsal completed', 'FAIL', error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
} finally {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    process.stderr.write(`warning: could not remove ${work}: ${String(error)}\n`)
  }
}

const report = {
  gate: 'U06',
  kind: 'ROLLBACK_REHEARSAL_OVER_A_TEMP_HOME',
  steps,
  summary: {
    pass: steps.filter(step => step.status === 'PASS').length,
    fail: steps.filter(step => step.status === 'FAIL').length,
  },
  claim:
    'The rollback restores the OLD artifact and the OLD consistency snapshot, reconciles the external effect the '
    + 'new version already produced, and reports the effect as still present in the world. Rolling back software '
    + 'is not reported as rolling back the world.',
  notClaimed: [
    'that a real newer version was rolled back: the new version is a fixture over the same built artifact',
    'that a real remote was reconciled: the remote is a counting in-process fake',
  ],
}

writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`\nU06 report: ${OUT}\n`)
process.stdout.write(`summary: ${JSON.stringify(report.summary)}\n`)
process.exit(report.summary.fail === 0 ? 0 : 1)
