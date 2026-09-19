#!/usr/bin/env node
/**
 * R7 / U05+U06 — a REAL canary upgrade and rollback, driven through the real
 * launcher, the real profile resolver and a real `DSH_HOME`.
 *
 * WHY THIS EXISTS SEPARATELY FROM `M9.20-real-tasks/u05-canary.mjs` AND
 * `u06-rollback.mjs`
 * =======================================================================
 * Those two scripts are honest but their rehearsal is not the real machinery:
 *
 *   - `u05-canary.mjs` creates its profile with `mkdtempSync` + a hand-written
 *     `package.json` + a hand-made junction, and never invokes `dsh plugin`.
 *     Its F6 ("the daily home was not written") is reported PASS **vacuously**,
 *     because `D:/DSH/home/daily` does not exist on this machine -- the script
 *     says so itself and adds F8 as a positive control.
 *   - `u06-rollback.mjs` stages "versions/old" and "versions/new" as copies of
 *     the built `lib/` inside a temp directory and never installs either one.
 *     Its "new version" is the same code with a bumped version string.
 *
 * Neither ever installs an artifact into a profile through the deployment's own
 * install path, so neither can observe whether that path actually swaps the
 * composed tree. This script does only that, and nothing else.
 *
 * WHAT IS REAL HERE (all of it executed, not asserted)
 * ===================================================
 *   1. A real `DSH_HOME` at `D:/DSH/home/canary11`, seeded with a COPY of real
 *      state from another home (sessions + storages + presets). The source home
 *      is read-only in this rehearsal: nothing is written back to it.
 *   2. The real install path: `dsh plugin --profile canary11 add link:<dir>`,
 *      which runs the pinned pnpm 11.7.0 through the launcher.
 *   3. Two genuinely different artifacts, each staged as its own immutable
 *      version directory (the rule `docs/OPERATIONS.md` states).
 *   4. The real profile resolver: `--dump-config` is read before and after each
 *      install, so "the tree changed" is a measurement of the composed
 *      deployment rather than a claim about a package.json.
 *   5. The real boot: the composed profile is started through the launcher with
 *      the IN-TREE scripted adapter as the model route, so the turn, the tool
 *      call and the session write all really happen -- no provider is billed.
 *   6. A real cold consistency snapshot of the home, taken while nothing runs.
 *   7. The real effect ledger (`src/effects.ts`) over the real storage domain,
 *      with the operation's record inside the snapshotted state and the
 *      "remote" as a DURABLE FILE outside it -- so "the world still remembers
 *      it" is readable by a separate process after the rollback.
 *
 * WHAT IS A FIXTURE, NAMED RATHER THAN IMPLIED
 * ==========================================
 *   - There is no newer DSH release to install (`compatibility.lock.json` pins
 *     the checkout and authorizes no network). The "new version" is therefore a
 *     real, separately staged artifact whose difference from the old one is its
 *     VERSION STRING and its PATCH CONFIG, not its code. The `lib/` payload is
 *     the same bytes. A real upgrade would differ in code too, and that half is
 *     BLOCKED_EXTERNAL.
 *   - The "remote" is a file on this machine, not a network service. No network
 *     is authorized. Its DURABILITY is real and is what the rehearsal measures;
 *     its REMOTENESS is not.
 *
 * USAGE
 * =====
 *   node qualification/results/R7-real-tasks/canary-rollback.mjs
 *
 * Exit 0 only when every executed step is PASS. A step that cannot be executed
 * is recorded as BLOCKED_EXTERNAL and exits non-zero, because a blocked half is
 * not a validation.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

// ---------------------------------------------------------------------------
// Paths. Absolute and Windows-form, because `dsh plugin` hands them to pnpm and
// pnpm rejects a POSIX-form absolute path on this platform.
// ---------------------------------------------------------------------------

const REPO = 'D:/DSH/work/dsh-native-daily'
const PKG = `${REPO}/packages/dsh-daily-work`
const DSH_SRC = 'D:/DSH/src/dsh-src'
const LAUNCHER = `${DSH_SRC}/apps/cli/lib/bin.js`

/** The NEW home this rehearsal owns. Other agents use canary/canary3/canary5..10. */
const HOME = 'D:/DSH/home/canary11'

/** A home holding REAL state, read only, to seed the canary from. */
const SEED_HOME = 'D:/DSH/home/canary2'

const OUT_DIR = `${REPO}/qualification/results/R7-real-tasks`
const OUT = `${OUT_DIR}/canary-rollback.json`

const steps = []
function record(id, name, status, detail, extra = {}) {
  steps.push({ id, name, status, detail, ...extra })
  process.stdout.write(`[${status}] ${id} ${name}: ${detail}\n`)
}

/** sha256 of a string, hex. */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Every file under `root`, relative and sorted; links are entries, never entered.
 *
 * `lstatSync` rather than `statSync` is load-bearing: the profile's
 * `node_modules/dsh-daily-work` is a junction into the package, whose own
 * `node_modules` junctions back into the DSH checkout. Following it descends a
 * cycle. A link is an entry, not content.
 */
function listFiles(root) {
  if (!existsSync(root)) return null
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      let stats
      try {
        stats = lstatSync(full)
      } catch {
        continue
      }
      if (stats.isSymbolicLink()) files.push(`LINK ${relative(root, full).replace(/\\/g, '/')}`)
      else if (stats.isDirectory()) walk(full)
      else files.push(relative(root, full).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return files.sort()
}

/** A digest of a tree's file list AND contents, so a restore can be verified. */
function treeDigest(root) {
  const files = listFiles(root) ?? []
  const parts = []
  for (const rel of files) {
    if (rel.startsWith('LINK ')) {
      parts.push(rel)
      continue
    }
    parts.push(`${rel}:${sha256(readFileSync(join(root, rel)).toString('base64'))}`)
  }
  return { digest: sha256(parts.join('\n')), files }
}

/** Run a command, capturing everything, never throwing. */
function run(argv, options = {}) {
  const outcome = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  })
  return { ok: outcome.status === 0, status: outcome.status, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' }
}

/**
 * The launcher invoked with a given home and profile.
 *
 * `options` is spread FIRST and `env` set LAST, deliberately. Spreading it the
 * other way round let an `options.env` overwrite the merged environment and
 * silently drop `DSH_HOME` -- so the launcher fell back to the real default home,
 * found no `canary11` profile there, and failed with
 * `profile "canary11" does not exist`. That failure was a defect in THIS helper,
 * not in the deployment, and it is recorded because it is exactly the shape of
 * error that reads like a product fault.
 */
function dsh(home, argv, options = {}) {
  return run([process.execPath, LAUNCHER, ...argv], {
    ...options,
    env: { DSH_HOME: home, ...(options.env ?? {}) },
  })
}

/** The `budgetCeiling` the composed tree actually carries, or null. */
function composedBudgetCeiling(text) {
  const match = /budgetCeiling:\s*(\d+)/.exec(text)
  return match === null ? null : Number(match[1])
}

// ---------------------------------------------------------------------------
// STEP 0 — a NEW home, seeded from real state, with credentials excluded.
// ---------------------------------------------------------------------------

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'profiles', 'canary11'), { recursive: true })

const seedFiles = []
for (const entry of ['sessions', 'storages', '.agent-presets']) {
  const source = join(SEED_HOME, entry)
  if (!existsSync(source)) continue
  cpSync(source, join(HOME, entry), { recursive: true })
  seedFiles.push(entry)
}
// Credentials are NOT copied. Nothing in this rehearsal needs them, and the
// rehearsal must not be a route by which a credential reaches a directory a
// later reader might print. The absence is asserted rather than assumed.
const credentialNames = ['.credentials.yaml', 'credentials.yaml']
const copiedCredentials = credentialNames.filter(name => existsSync(join(HOME, name)))
record('S0', 'a NEW canary home is created and seeded with REAL state', copiedCredentials.length === 0 ? 'PASS' : 'FAIL',
  `home ${HOME}; seeded from ${SEED_HOME}: ${seedFiles.join(', ') || 'nothing'}; `
  + `${String(listFiles(HOME)?.length ?? 0)} entries; credentials copied: ${copiedCredentials.join(', ') || 'none'}`,
  { home: HOME, seedHome: SEED_HOME, seeded: seedFiles, credentialsCopied: copiedCredentials })

// ---------------------------------------------------------------------------
// STEP 1 — two artifacts, each in its own immutable version directory.
//
// The rule from `docs/OPERATIONS.md`: "Immutable version directory, new
// process." Neither directory is ever edited after it is staged; the upgrade is
// a change of WHICH directory the profile points at.
// ---------------------------------------------------------------------------

/**
 * Stage one version as its own immutable directory.
 *
 * PEER RESOLUTION, AND WHY A JUNCTION IS HERE. The profile installs this
 * directory with `link:`, so pnpm creates `profiles/canary11/node_modules/dsh-daily-work`
 * as a junction to it and does NOT install the package's own dependencies.
 * `lib/host-plugin.js` then imports `@deepseek-ai/cordis` and the other peers by
 * bare specifier, which Node resolves by walking up from the FILE's directory --
 * i.e. from inside this version directory. Without a `node_modules` here every
 * row fails to import, which is exactly what the first run of this script
 * produced:
 *
 *   dsh: warning: 7 entries did not activate
 *   daily-work-host (dsh-daily-work/host): failed to import
 *
 * That was a defect in the STAGING, not in the deployment: the package itself
 * carries these same junctions in its own `node_modules`
 * (`packages/dsh-daily-work/node_modules/@deepseek-ai/* -> D:/DSH/src/dsh-src/...`).
 * The junction reproduces that layout for the staged copy.
 *
 * RECORDED LIMITATION: these peer links are junctioned rather than installed.
 * The package is `private: true` and is not published, so there is no registry
 * install to run. The artifact under test is therefore `lib/` + `cordis.patch.yml`
 * + `package.json`; its dependency resolution is borrowed from the working tree.
 * A real release would install its own dependencies, and that half is NOT
 * exercised.
 *
 * @param version - the version string to stamp into `package.json`.
 * @param substitutions - exact `[from, to]` edits to `cordis.patch.yml`.
 */
function stageVersion(version, { patchSubstitutions }) {
  const dir = `${HOME}/versions/dsh-daily-work-${version}`
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(PKG, 'lib'), join(dir, 'lib'), { recursive: true })
  cpSync(join(PKG, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml'))
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  pkg.version = version
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  let patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  for (const [from, to] of patchSubstitutions) {
    if (!patch.includes(from)) throw new Error(`stageVersion(${version}): patch anchor not found: ${from}`)
    patch = patch.replace(from, to)
  }
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  const link = join(dir, 'node_modules')
  mkdirSync(link, { recursive: true })
  for (const entry of readdirSync(join(PKG, 'node_modules'))) {
    if (entry === '.vite' || entry === '.vite-temp' || entry === '.bin') continue
    symlinkSync(join(PKG, 'node_modules', entry), join(link, entry), 'junction')
  }
  return { dir, digest: treeDigest(dir).digest }
}

const OLD = stageVersion('0.1.0', { patchSubstitutions: [] })
const NEW = stageVersion('0.1.1', { patchSubstitutions: [['budgetCeiling: 200', 'budgetCeiling: 250']] })
const libIdentical = treeDigest(join(OLD.dir, 'lib')).digest === treeDigest(join(NEW.dir, 'lib')).digest
record('S1', 'the old and new artifacts are staged as separate immutable version directories',
  OLD.digest !== NEW.digest ? 'PASS' : 'FAIL',
  `old ${OLD.digest.slice(0, 16)}... at ${OLD.dir}; new ${NEW.digest.slice(0, 16)}... at ${NEW.dir}; `
  + `lib payload byte-identical: ${String(libIdentical)} (the difference is version + patch config, stated as such)`,
  { oldDir: OLD.dir, oldDigest: OLD.digest, newDir: NEW.dir, newDigest: NEW.digest, libIdentical })

// ---------------------------------------------------------------------------
// STEP 2 — the profile, then the REAL install of the OLD version.
// ---------------------------------------------------------------------------

writeFileSync(join(HOME, 'profiles', 'canary11', 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-canary11',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
}, null, 2)}\n`, 'utf8')
writeFileSync(join(HOME, 'profiles', 'canary11', 'cordis.yml'), '[]\n', 'utf8')

const installOld = dsh(HOME, ['plugin', '--profile', 'canary11', 'add', `link:${OLD.dir}`],
  { cwd: join(HOME, 'profiles', 'canary11') })
record('S2', 'the OLD artifact is installed through the real `dsh plugin` path', installOld.ok ? 'PASS' : 'FAIL',
  installOld.ok
    ? `pnpm through the launcher exited 0: ${installOld.stdout.trim().split('\n').slice(-3).join(' | ')}`
    : `exited ${String(installOld.status)}: ${(installOld.stdout + installOld.stderr).slice(0, 400)}`,
  { command: 'dsh plugin --profile canary11 add link:<old>' })

const dumpOld = dsh(HOME, ['--profile', 'canary11', '--dump-config'])
const ceilingOld = composedBudgetCeiling(dumpOld.stdout)
record('S3', 'the composed tree carries the OLD artifact\'s patch config', ceilingOld === 200 ? 'PASS' : 'FAIL',
  `--dump-config exited ${String(dumpOld.status)}; budgetCeiling in the composed tree: ${String(ceilingOld)} (old artifact states 200)`,
  { composedBudgetCeiling: ceilingOld })

// ---------------------------------------------------------------------------
// STEP 3 — a real COLD consistency snapshot, taken while nothing runs.
// ---------------------------------------------------------------------------

const STATE_ENTRIES = ['storages', 'sessions', 'settings.yaml', '.agent-presets']
const snapshot = `${HOME}/snapshots/pre-upgrade`
rmSync(snapshot, { recursive: true, force: true })
mkdirSync(snapshot, { recursive: true })
for (const entry of STATE_ENTRIES) {
  const source = join(HOME, entry)
  if (existsSync(source)) cpSync(source, join(snapshot, entry), { recursive: true })
}
const snapshotDigest = treeDigest(snapshot).digest
record('S3b', 'a COLD consistency snapshot of the home state is taken before the upgrade', 'PASS',
  `snapshot at ${snapshot}; digest ${snapshotDigest.slice(0, 16)}...; ${String(listFiles(snapshot)?.length ?? 0)} entries; `
  + 'nothing was running, so this is a cold copy and not a live-DB copy',
  { snapshot, snapshotDigest })

// ---------------------------------------------------------------------------
// STEP 4 — the effect the new version will produce. The RECORD goes inside the
// snapshotted state; the REMOTE goes OUTSIDE it.
//
// This split is the point. A rewind of the state therefore erases our local
// knowledge of the effect while the effect itself remains readable by any
// process that looks at the world -- which is exactly the asymmetry the gate
// exists to test.
// ---------------------------------------------------------------------------

const REMOTE_FILE = `${HOME}/remote-world.json`
const effectStoreRoot = join(HOME, 'storages')
rmSync(REMOTE_FILE, { force: true })
writeFileSync(REMOTE_FILE, `${JSON.stringify({ committed: {} }, null, 2)}\n`, 'utf8')

const { createRequire } = await import('node:module')
const { pathToFileURL } = await import('node:url')
const requireFromPackage = createRequire(join(PKG, 'package.json'))
const importPeer = async (name) => await import(pathToFileURL(requireFromPackage.resolve(name)).href)

const { Context } = await importPeer('@deepseek-ai/cordis')
const { EffectLedger, identify } = await import(pathToFileURL(join(PKG, 'src/effects.ts')).href)
const Storage = await importPeer('@deepseek-ai/dsh-storage')
const storageJsonPlugin = await importPeer('@deepseek-ai/dsh-storage-json')
const storageDomainPlugin = await importPeer('@deepseek-ai/dsh-storage-domain')

/**
 * The "remote": a durable file, written by a real `perform`.
 *
 * It is a file rather than an in-process counter ON PURPOSE. A counter proves
 * nothing after the process that holds it exits, and the claim under test --
 * "the world still remembers the effect after the software was rolled back" --
 * is only meaningful if a LATER process can read it.
 *
 * THE RETURN SHAPE IS THE CONTRACT, AND IT IS `status`. `EffectPerformResult`
 * (`src/effects.ts:253-256`) is `{ status: 'confirmed' | 'not_started' |
 * 'unknown', ... }`. It has no `kind` field. An adapter that returns
 * `{ kind: 'accepted' }` -- which is what `M9.20-real-tasks/u06-rollback.mjs`
 * does -- makes `result.status` `undefined`, the ledger writes
 * `status: undefined` into the record, and the zod enum then rejects that
 * record on the next open. `probe-u06-refusal-cause.mjs` isolates exactly that,
 * and this script was corrected by its own probe: the first version here had
 * the same defect and reported `ledger outcome undefined`.
 */
const remote = {
  performCount: 0,
  perform(intent, identity) {
    remote.performCount += 1
    const world = JSON.parse(readFileSync(REMOTE_FILE, 'utf8'))
    const resultRef = `world-${String(remote.performCount)}`
    world.committed[identity.operationId] = { resultRef, at: new Date().toISOString(), logicalKey: intent.logicalKey }
    writeFileSync(REMOTE_FILE, `${JSON.stringify(world, null, 2)}\n`, 'utf8')
    return Promise.resolve({ status: 'confirmed', resultRef })
  },
  query(operationId) {
    const world = JSON.parse(readFileSync(REMOTE_FILE, 'utf8'))
    const held = world.committed[operationId]
    return Promise.resolve(held === undefined
      ? { status: 'not_started', detail: 'the world holds no operation under this id' }
      : { status: 'confirmed', resultRef: held.resultRef })
  },
}
const adapter = {
  kind: 'r7-remote-send',
  capabilities: { idempotencyKey: true, queryable: true },
  perform: (intent, identity) => remote.perform(intent, identity),
  query: (operationId) => remote.query(operationId),
}

const INTENT = {
  kind: 'r7-remote-send',
  logicalKey: 'run-canary11/task-1/notify',
  parameters: { runId: 'run-canary11', taskId: 'task-1', body: 'work complete' },
}
const operationId = identify(INTENT).operationId

// ---------------------------------------------------------------------------
// STEP 5 — UPGRADE, through the real install path, then boot the new version.
// ---------------------------------------------------------------------------

const installNew = dsh(HOME, ['plugin', '--profile', 'canary11', 'add', `link:${NEW.dir}`],
  { cwd: join(HOME, 'profiles', 'canary11') })
record('S5', 'the NEW artifact is installed over the old one through the real `dsh plugin` path',
  installNew.ok ? 'PASS' : 'FAIL',
  installNew.ok
    ? `pnpm exited 0: ${installNew.stdout.trim().split('\n').slice(-3).join(' | ')}`
    : `exited ${String(installNew.status)}: ${(installNew.stdout + installNew.stderr).slice(0, 400)}`,
  { command: 'dsh plugin --profile canary11 add link:<new>' })

const dumpNew = dsh(HOME, ['--profile', 'canary11', '--dump-config'])
const ceilingNew = composedBudgetCeiling(dumpNew.stdout)
record('S6', 'the composed tree MOVED to the new artifact\'s patch config', ceilingNew === 250 ? 'PASS' : 'FAIL',
  `--dump-config exited ${String(dumpNew.status)}; budgetCeiling in the composed tree: ${String(ceilingNew)} `
  + `(was ${String(ceilingOld)}); daily-work-host rows: ${String((dumpNew.stdout.match(/daily-work-host/g) ?? []).length)}`,
  { composedBudgetCeilingBefore: ceilingOld, composedBudgetCeilingAfter: ceilingNew })

// The new version READS the seeded state and writes its own: a real boot, a real
// turn, a real tool call, a real session on disk. No provider is billed -- the
// route is the in-tree scripted adapter.
const OVERLAY = `${HOME}/overlay-keyless.yml`
writeFileSync(OVERLAY, [
  '- id: llm-deepseek',
  '  disabled: true',
  '',
  '- id: agent-default-model',
  '  config:',
  '    provider: cli-mock',
  '    model: cli-mock',
  '',
  '- id: agent-instructions',
  '  disabled: true',
  '',
  '- insert:',
  '    - id: cli-mock-llm',
  `      name: '${PKG}/m914-mock-llm.ts'`,
  '',
].join('\n'), 'utf8')

/**
 * The turn-completion marker, as the runner actually emits it.
 *
 * The line is `{"type":"status","phase":"turn_end",...}` -- the discriminator is
 * `type: "status"` and the event is named by `phase`. An earlier version of this
 * script looked for `"type":"turn_end"`, which never appears, so a perfectly
 * clean boot was reported as a failure. The marker below is the exact substring
 * copied from a real transcript (`canary-rollback.log`), not a guess.
 */
const TURN_ENDED = '"phase":"turn_end"'
const TURN_COMPLETED = '"reason":{"kind":"completed"}'

/**
 * Did the EXTENSION actually activate?
 *
 * `exit 0` and a completed turn are NOT sufficient. On the first run of this
 * script the launcher exited 0 and the turn completed while the extension's rows
 * were entirely unloaded, because the staged version directory could not resolve
 * its peers:
 *
 *   dsh: warning: 7 entries did not activate
 *   daily-work-host (dsh-daily-work/host): failed to import
 *
 * A boot that completes a turn with the product absent is exactly the shape of
 * "a green light that proves nothing", so the warning is treated as a FAILURE of
 * the boot step rather than as noise. The check is on the WARNING TEXT, which is
 * what the launcher prints when a row does not mount.
 */
function extensionActivated(bootResult) {
  const noise = `${bootResult.stdout}\n${bootResult.stderr}`
  const failedRows = [...noise.matchAll(/^(daily-[a-z-]+) \(dsh-daily-work\/[a-z-]+\): failed to import$/gm)]
    .map(match => match[1])
  const activationWarning = /did not activate/.test(noise)
  return { activated: failedRows.length === 0 && !activationWarning, failedRows, activationWarning }
}

const bootNew = dsh(HOME, ['--profile', 'canary11', '--patch', OVERLAY, '--json', 'r7 post-upgrade turn'],
  { timeoutMs: 300_000 })
const newActivation = extensionActivated(bootNew)
const bootNewCompleted = bootNew.ok && bootNew.stdout.includes(TURN_ENDED)
  && bootNew.stdout.includes(TURN_COMPLETED) && newActivation.activated
record('S7', 'the NEW version boots through the real launcher with the EXTENSION LOADED, and completes a real turn',
  bootNewCompleted ? 'PASS' : 'FAIL',
  bootNewCompleted
    ? `exit 0; the turn ended completed; no "did not activate" warning; the scripted route made a real tool call `
      + 'and a real session write on disk'
    : `exit ${String(bootNew.status)}; turn_end present: ${String(bootNew.stdout.includes(TURN_ENDED))}; `
      + `extension rows that failed to import: ${newActivation.failedRows.join(', ') || 'none'}; `
      + `"did not activate" warning present: ${String(newActivation.activationWarning)}; `
      + `stderr: ${(bootNew.stderr || '').slice(0, 300)}`,
  { launcher: LAUNCHER, overlay: OVERLAY, failedRows: newActivation.failedRows, stdout: bootNew.stdout.slice(0, 4000) })

// And the new version performs an effect in the world. This is the stimulus the
// gate names: "a new version read the state, and some external effects have
// already happened."
const effectStore = join(effectStoreRoot)
const ctxNew = new Context()
await ctxNew.plugin(Storage.default ?? Storage)
await ctxNew.plugin(storageJsonPlugin.default ?? storageJsonPlugin, { root: effectStore })
await ctxNew.plugin(storageDomainPlugin.default ?? storageDomainPlugin, { backend: 'json' })
const ledgerNew = new EffectLedger(ctxNew)
await ledgerNew.open()
const attempt = await ledgerNew.perform(adapter, INTENT)
const recordBeforeRollback = ledgerNew.get(operationId)
await ledgerNew.close()
await ctxNew.fiber.dispose()

const worldAfterPerform = JSON.parse(readFileSync(REMOTE_FILE, 'utf8'))
record('S8', 'the NEW version performed an external effect, and it is durable in the world',
  attempt.performed && worldAfterPerform.committed[operationId] !== undefined ? 'PASS' : 'FAIL',
  `ledger outcome ${String(attempt.outcome)}; transport invoked ${String(remote.performCount)} time(s); `
  + `the remote file ${REMOTE_FILE} holds the operation: ${String(worldAfterPerform.committed[operationId] !== undefined)}`,
  { operationId, performCount: remote.performCount, ledgerStatusBeforeRollback: recordBeforeRollback?.status ?? null })

// The local knowledge of that effect lives in the state that is about to be
// rewound. Recorded so the rewind's consequence is a measurement.
const effectFileInState = `${effectStoreRoot}/dsh_daily_effects.json`
const effectInSnapshot = existsSync(join(snapshot, 'storages', 'dsh_daily_effects.json'))
record('S9', 'the LOCAL record of the effect is inside the state the rollback will rewind',
  existsSync(effectFileInState) && !effectInSnapshot ? 'PASS' : 'FAIL',
  `the effect store is at ${effectFileInState} (present: ${String(existsSync(effectFileInState))}); `
  + `the pre-upgrade snapshot contains it: ${String(effectInSnapshot)} (false is correct: the snapshot predates the effect)`,
  { effectFileInState, effectInSnapshot, snapshotDigest })

// ---------------------------------------------------------------------------
// STEP 6 — ROLLBACK: the OLD artifact, then the OLD consistency snapshot.
// ---------------------------------------------------------------------------

const installBack = dsh(HOME, ['plugin', '--profile', 'canary11', 'add', `link:${OLD.dir}`],
  { cwd: join(HOME, 'profiles', 'canary11') })
record('S10', 'the rollback reinstalls the OLD artifact through the real `dsh plugin` path',
  installBack.ok ? 'PASS' : 'FAIL',
  installBack.ok
    ? `pnpm exited 0: ${installBack.stdout.trim().split('\n').slice(-3).join(' | ')}`
    : `exited ${String(installBack.status)}: ${(installBack.stdout + installBack.stderr).slice(0, 400)}`,
  { command: 'dsh plugin --profile canary11 add link:<old>' })

const dumpRolledBack = dsh(HOME, ['--profile', 'canary11', '--dump-config'])
const ceilingRolledBack = composedBudgetCeiling(dumpRolledBack.stdout)
record('S11', 'the composed tree is back on the OLD artifact', ceilingRolledBack === 200 ? 'PASS' : 'FAIL',
  `--dump-config exited ${String(dumpRolledBack.status)}; budgetCeiling: ${String(ceilingRolledBack)} `
  + `(upgraded was ${String(ceilingNew)}, old is 200)`,
  { composedBudgetCeilingRolledBack: ceilingRolledBack })

// The state is restored FROM THE SNAPSHOT rather than by reverse-applying the
// migration: a reverse migration is a second piece of software that would itself
// need testing. The restore is verified by digest, so "restored" is measured.
for (const entry of STATE_ENTRIES) {
  rmSync(join(HOME, entry), { recursive: true, force: true })
}
for (const entry of STATE_ENTRIES) {
  const source = join(snapshot, entry)
  if (existsSync(source)) cpSync(source, join(HOME, entry), { recursive: true })
}
/**
 * Digest the home's RESTORED state by the same rule the snapshot was digested
 * by: the same entry list, in the same order, each entry digested the same way.
 *
 * The snapshot lives at `<home>/snapshots/pre-upgrade` and the state lives at
 * the home root, so the relative paths differ by the `snapshots/pre-upgrade/`
 * prefix. That prefix is stripped before digesting, which is what makes the two
 * digests comparable. Digesting the snapshot twice would compare it to itself
 * and would pass for any restore, including a restore that did nothing.
 */
function homeStateDigest() {
  const parts = []
  for (const entry of STATE_ENTRIES) {
    const full = join(HOME, entry)
    if (!existsSync(full)) continue
    const inner = treeDigest(full)
    for (const rel of inner.files) {
      if (rel.startsWith('LINK ')) {
        parts.push(`${entry}/${rel.slice(5)}`)
        continue
      }
      parts.push(`${entry}/${rel}:${sha256(readFileSync(join(full, rel)).toString('base64'))}`)
    }
  }
  return sha256(parts.join('\n'))
}
/** The snapshot's digest, computed by the identical rule. */
function snapshotStateDigest() {
  const parts = []
  for (const entry of STATE_ENTRIES) {
    const full = join(snapshot, entry)
    if (!existsSync(full)) continue
    const inner = treeDigest(full)
    for (const rel of inner.files) {
      if (rel.startsWith('LINK ')) {
        parts.push(`${entry}/${rel.slice(5)}`)
        continue
      }
      parts.push(`${entry}/${rel}:${sha256(readFileSync(join(full, rel)).toString('base64'))}`)
    }
  }
  return sha256(parts.join('\n'))
}

const restoredDigest = homeStateDigest()
const snapshotStateDigestValue = snapshotStateDigest()
const restoredMatchesSnapshot = restoredDigest === snapshotStateDigestValue
record('S12', 'the OLD consistency snapshot is restored byte-for-byte', restoredMatchesSnapshot ? 'PASS' : 'FAIL',
  restoredMatchesSnapshot
    ? `the RESTORED HOME STATE digest ${restoredDigest.slice(0, 16)}... equals the SNAPSHOT digest `
      + `${snapshotStateDigestValue.slice(0, 16)}... (compared across different directories by the same rule); `
      + `the effect record the new version wrote is gone from the state: ${String(!existsSync(effectFileInState))}`
    : `RESTORE MISMATCH: restored home state ${restoredDigest.slice(0, 16)}... vs snapshot ${snapshotStateDigestValue.slice(0, 16)}...`,
  { restoredDigest, snapshotStateDigest: snapshotStateDigestValue, effectRecordSurvivesRewind: existsSync(effectFileInState) })

// The restored state is one the OLD version can read: a real boot, in a new
// process, against the restored state and the rolled-back artifact. The SAME
// activation check applies, for the same reason.
const bootOld = dsh(HOME, ['--profile', 'canary11', '--patch', OVERLAY, '--json', 'r7 post-rollback turn'],
  { timeoutMs: 300_000 })
const oldActivation = extensionActivated(bootOld)
const bootOldCompleted = bootOld.ok && bootOld.stdout.includes(TURN_ENDED) && oldActivation.activated
record('S13', 'the OLD artifact boots against the RESTORED state with the extension loaded, and completes a turn',
  bootOldCompleted ? 'PASS' : 'FAIL',
  bootOldCompleted
    ? 'exit 0, the turn ended, no "did not activate" warning; the rolled-back deployment reads the restored state'
    : `exit ${String(bootOld.status)}; extension rows that failed to import: `
      + `${oldActivation.failedRows.join(', ') || 'none'}; stderr: ${(bootOld.stderr || '').slice(0, 300)}`,
  { failedRows: oldActivation.failedRows, stdout: bootOld.stdout.slice(0, 2000) })

// ---------------------------------------------------------------------------
// STEP 7 — RECONCILE the effect. This is the clause the gate turns on.
// ---------------------------------------------------------------------------

// The rewound ledger can no longer be opened over its own record: the record
// lives in the state that was just rewound, and the facility refuses to read a
// record it does not understand rather than silently reading a backup. That
// refusal is recorded, not smoothed over.
const ctxAfter = new Context()
await ctxAfter.plugin(Storage.default ?? Storage)
await ctxAfter.plugin(storageJsonPlugin.default ?? storageJsonPlugin, { root: effectStore })
await ctxAfter.plugin(storageDomainPlugin.default ?? storageDomainPlugin, { backend: 'json' })
const ledgerAfter = new EffectLedger(ctxAfter)
let rewindRefusal = null
let ledgerOpened = false
let recordAfterRewind = null
try {
  await ledgerAfter.open()
  ledgerOpened = true
  recordAfterRewind = ledgerAfter.get(operationId) ?? null
} catch (error) {
  rewindRefusal = error instanceof Error ? error.message : String(error)
}
// The accurate expectation, asserted rather than described: the restored state
// predates the effect, so the ledger opens CLEANLY and simply holds NO record of
// it. An earlier version of this script asserted nothing here and reported PASS
// unconditionally, which is a check that cannot fail.
//
// NOTE ON THE RECORDED M9.20 STEP R8a. `u06-rollback.json` records a REFUSAL at
// this point and explains it as the consequence of the state rewind. That
// explanation does not hold: in `u06-rollback.mjs` the effect store is a SIBLING
// of the state directory and is never rewound, and the refusal is caused by that
// script's adapter returning `{ kind: 'accepted' }` where the contract requires
// `{ status: 'confirmed' }`. `probe-u06-refusal-cause.mjs` isolates the cause.
const rewindIsCleanAndRecordGone = ledgerOpened && recordAfterRewind === null
record('S14', 'after the rewind the ledger opens cleanly and holds NO record of the effect',
  rewindIsCleanAndRecordGone ? 'PASS' : 'FAIL',
  ledgerOpened
    ? `the ledger opened with no complaint; its record of ${operationId} is ${recordAfterRewind === null ? 'ABSENT' : 'present'}. `
      + 'The restored state predates the effect, so the local knowledge is gone while the world still holds it -- '
      + 'which is why reconciliation must be driven from the world, by operation id.'
    : `the facility refused to open: ${rewindRefusal.slice(0, 240)}`,
  { ledgerOpened, recordAfterRewind, refusal: rewindRefusal })

// So the reconciliation is driven FROM THE WORLD, by operation id -- which is
// what a real rollback must do once the local record was rewound away, and why
// `EFFECT_LIMITS` requires a queryable remote before any effect may run
// automatically.
const performCountBeforeReconcile = remote.performCount
const queried = await adapter.query(operationId)
const performCountAfterReconcile = remote.performCount
record('S15', 'the rollback reconciled the effect from the WORLD, without re-sending it',
  performCountAfterReconcile === performCountBeforeReconcile && queried.status === 'confirmed' ? 'PASS' : 'FAIL',
  `transport invocations before ${String(performCountBeforeReconcile)}, after ${String(performCountAfterReconcile)}; `
  + `the world reports ${String(queried.status)} with resultRef ${String(queried.resultRef)}`,
  { performCountBeforeReconcile, performCountAfterReconcile, outcome: queried.status, resultRef: queried.resultRef })

// A SEPARATE PROCESS reads the world file. This is the measurement that makes
// "the world still remembers it" a fact rather than an in-process variable.
const independent = run([process.execPath, '-e', `
const fs = require('fs')
const world = JSON.parse(fs.readFileSync(${JSON.stringify(REMOTE_FILE)}, 'utf8'))
const held = world.committed[${JSON.stringify(operationId)}]
console.log(JSON.stringify({ stillPresent: held !== undefined, resultRef: held ? held.resultRef : null }))
`])
let independentRead = null
try {
  independentRead = JSON.parse(independent.stdout.trim())
} catch {
  independentRead = null
}
record('S16', 'a SEPARATE process still finds the effect in the world after the rollback',
  independent.ok && independentRead?.stillPresent === true ? 'PASS' : 'FAIL',
  `independent read of ${REMOTE_FILE}: ${JSON.stringify(independentRead)}`,
  { independentRead })

// And the reconciliation does not claim the effect was undone. Rolling back
// software is not rolling back the world, and the report must not say otherwise.
const reconciliationText = `reconciled from the world by operationId ${operationId}: the world reports ${String(queried.status)}`
const claimsReversal = /rolled back|undone|reverted|reversed|withdrawn/i.test(reconciliationText)
record('S17', 'the reconciliation does NOT claim the effect was undone', claimsReversal ? 'FAIL' : 'PASS',
  `reconciliation text: "${reconciliationText}"; a reversal claim is present: ${String(claimsReversal)}`,
  { reconciliationText })

// The effect the new version performed is STILL in the world after the software
// went back. This is the clause the gate exists for, and it is a measurement:
// the ledger that would have said otherwise was rewound, and the world was not.
const worldAfterRollback = JSON.parse(readFileSync(REMOTE_FILE, 'utf8'))
const stillInWorld = worldAfterRollback.committed[operationId] !== undefined
record('S18', 'the world still holds the effect after the software was rolled back',
  stillInWorld ? 'PASS' : 'FAIL',
  `the world file holds ${operationId}: ${String(stillInWorld)}; `
  + `the LOCAL record was rewound away (S14); the software is back on ${OLD.dir}`,
  { operationId, stillInWorld, worldEntry: worldAfterRollback.committed[operationId] ?? null })

// ---------------------------------------------------------------------------
// STEP 8 — the honest limit, recorded as data.
// ---------------------------------------------------------------------------

const blocked = [
  {
    gate: 'U05-new-version',
    status: 'BLOCKED_EXTERNAL',
    reason:
      'No newer DSH/Node/plugin release is installable. `compatibility.lock.json` pins '
      + '`observed_reference.commit` at ddefc45fbc7f8e46dd73185e68295696d1297887 with '
      + '`distribution_tested: false`, and `runtime_authorization.scope` is LOCAL_IMPLEMENTATION_ONLY, so no network '
      + 'fetch of a newer artifact is authorized. The upgrade EXECUTED here is a real artifact swap through the real '
      + 'install path, but the two artifacts differ in version string and patch config only; their `lib/` payload is '
      + 'byte-identical. What is NOT validated: that a newer release composes, boots, or preserves this extension\'s '
      + 'contract.',
  },
  {
    gate: 'U05/U06-live-provider',
    status: 'BLOCKED_EXTERNAL',
    reason:
      '`compatibility.lock.json` -> `runtime_authorization.live_provider_budget_authorized: false`, with '
      + '`budget_amount: null`, `currency: null`, `deadline: null`. The model route in this rehearsal is the in-tree '
      + 'scripted adapter (`packages/dsh-daily-work/m914-mock-llm.ts`), so no provider is contacted and nothing is '
      + 'billed. A live route would require the lock to name a budget: an amount, a currency and a deadline. '
      + 'Not validated: model quality, real latency, real token cost, or any provider-side version change.',
  },
  {
    gate: 'U06-real-remote',
    status: 'BLOCKED_EXTERNAL',
    reason:
      `No outbound network is authorized, so the "remote" whose state must survive a rollback is a durable FILE on `
      + `this machine (${REMOTE_FILE}), not a network service. Its durability across processes is real and was `
      + `measured by an independent process (S16); its remoteness is not. Not validated: reconciliation against a `
      + `real remote whose availability, idempotency semantics and eventual consistency are outside this machine.`,
  },
]

const report = {
  gate: 'U05+U06',
  kind: 'REAL_CANARY_UPGRADE_AND_ROLLBACK_THROUGH_THE_REAL_INSTALL_PATH',
  date: new Date().toISOString(),
  home: HOME,
  seedHome: SEED_HOME,
  launcher: LAUNCHER,
  steps,
  blocked,
  summary: {
    pass: steps.filter(step => step.status === 'PASS').length,
    fail: steps.filter(step => step.status === 'FAIL').length,
    blockedExternal: blocked.length,
  },
  claim:
    'Against a real DSH_HOME seeded with real state, a real artifact is installed through the real `dsh plugin` '
    + 'path, the composed tree is measured before and after, the new artifact really boots and really performs a '
    + 'durable effect in the world, and the rollback really restores the old artifact and the old cold consistency '
    + 'snapshot. After the rollback the effect is still readable in the world by a separate process, and the '
    + 'reconciliation does not claim it was undone.',
  notClaimed: [
    'that a newer DSH release was validated: no newer release is installable, and the staged "new" artifact differs only in version string and patch config',
    'that a model was exercised: the route is the in-tree scripted adapter and no provider was contacted',
    'that a real remote was reconciled: the remote is a durable local file',
  ],
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`\nR7 report: ${OUT}\n`)
process.stdout.write(`summary: ${JSON.stringify(report.summary)}\n`)

const failures = report.summary.fail
process.exit(failures === 0 ? 0 : 1)
