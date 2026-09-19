/**
 * T2 probe: is the mounted filesystem provider the LOCAL one, and do the
 * file-operation CORRECTNESS guards still refuse under it?
 *
 * THE CLAIM UNDER TEST. The architecture decision replaces `fs-sandbox` with
 * `fs-local`. `SandboxedFileSystem extends LocalFileSystem` and overrides
 * exactly three members (`packages/fs/fs-sandbox/src/index.ts:65,80,101`): the
 * `sandboxMode` capability getter and the two mutation entry points
 * `writeText`/`editText`. GPT Pro's correction -- and the claim a reader needs
 * evidence for -- is that this removes ACCESS CONTAINMENT while leaving
 * file-operation CORRECTNESS untouched. Reading the source supports that; this
 * probe measures it through a real composed profile boot.
 *
 * WHY A BOOT PROBE AND NOT A UNIT TEST. A unit test that constructs
 * `LocalFileSystem` proves the class works. It does NOT prove the PRODUCT mounts
 * it: the row could be absent from every bundle and the test would still be
 * green. This project has retracted that exact over-claim repeatedly (G-FIX-04,
 * G-FIX-05, G-FIX-12), so the provider identity below is read from the LIVE
 * composed tree, and the mutation guards are exercised through the REAL
 * model-facing tools on a REAL Session.
 *
 * HOW THE PROVIDER IS IDENTIFIED -- three independent routes, because a name
 * string is not evidence:
 *   1. `ctx.fs.constructor.name` and the full prototype chain.
 *   2. CLASS IDENTITY: the resolved module's own exported class is imported and
 *      `ctx.fs.constructor === LocalFileSystem` is asserted, with the module's
 *      REALPATH reported. `instanceof LocalFileSystem` alone would be a weak
 *      test -- `SandboxedFileSystem` extends it, so BOTH providers satisfy it.
 *      The negative is asserted the same way: the instance must NOT be an
 *      instance of `SandboxedFileSystem`, and that class must be absent from the
 *      prototype chain.
 *   3. The COMPOSITION: the loader's own entry table, read from `ctx.loader`,
 *      showing the `fs-sandbox` row disabled and the `fs-local` row ACTIVE.
 *
 * WHAT IS MEASURED, AND WHY EACH IS A REAL ASSERTION
 *   - The observation policy is STILL ACTIVE, probed BEHAVIOURALLY: the two
 *     `fs/*` intent waterfalls must still be occupied. The bare default is
 *     `undefined` (`packages/fs/tool-fs/src/write.ts:115`), so a defined
 *     write-intent or a thrown `FS_NOT_OBSERVED` edit-intent is positive
 *     evidence a listener answered, not an entry-state inference.
 *   - read -> write -> edit round-trips through the real tools.
 *   - A STALE-VERSION write is still REFUSED. The staleness is created
 *     OUT-OF-BAND with plain `node:fs`, so the observation policy's recorded
 *     version is genuinely behind the file -- the guard is exercised, not
 *     simulated.
 *   - An edit whose literal `old_string` is absent is still REFUSED.
 *   - The access-containment delta, measured in BOTH directions: a write OUTSIDE
 *     the session workspace. Under `fs-sandbox` it is denied; under `fs-local`
 *     it succeeds. The same probe binary is run against both compositions, so
 *     neither direction is asserted from reading.
 *
 * WHAT THIS DOES NOT PROVE is stated in the FINDINGS file next to the result.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'verify-t2-fs'

/**
 * The services this probe needs before its assertions mean anything.
 *
 * `sessionController` is in the gate for a MEASURED reason, not caution: the
 * first version of this probe injected only `['tools', 'fs']`, both of which
 * publish early, so the probe activated while `session-controller`, `webserver`
 * and `agent-presets` were still pending. It then reported `presetRoots: []` and
 * died on `ctx.get('sessionController').create` being undefined -- a probe
 * failure that says nothing about the product. Gating on `sessionController`
 * puts the probe after the composition it is supposed to observe. `fs` is the
 * subject and `tools` is the path the assertions drive, so both stay.
 *
 * `sandboxPolicy` is deliberately NOT in `inject`. The probe REPORTS the policy
 * it finds; gating on it would make a missing policy look like the probe's own
 * absence. It is read with `ctx.get`, which returns `undefined` honestly.
 */
export const inject = ['sessionController', 'tools', 'fs']

const REPO = 'D:/DSH/work/dsh-native-daily'
const RESULT_DIR = `${REPO}/qualification/results/T2-fs`
/** The output path. `DSH_PROBE_OUT` lets the shared harness own this file, so
 * two agents cannot read each other's result (the G-FIX-13 false PASS). */
const OUT = process.env.DSH_PROBE_OUT ?? `${RESULT_DIR}/boot.json`

/** The session workspace: the containment boundary when a fence is mounted. */
const WORKSPACE = `${RESULT_DIR}/workspace`
/** A directory genuinely OUTSIDE that workspace and outside the platform temp
 * areas `writableRoots` also allows (`packages/sandbox/sandbox/src/roots.ts:54`). */
const OUTSIDE = `${RESULT_DIR}/outside-workspace`

/**
 * SHA-256 of the INSTALLED profile patch, read from the home that was booted.
 *
 * WHY THIS IS IN THE RESULT AND NOT LEFT TO THE READER. A `VERDICT.json` that
 * names a provider but not the composition it was measured under cannot be
 * re-checked: the same numbers can describe a stale install and a current one,
 * and nothing in the file distinguishes them. That trap has already produced a
 * stale M12 install, a stale deployment identity and a stale-`lib/` false finding
 * in this project. The hash makes "which composition does this describe" a field
 * rather than an inference, and it is taken from the INSTALLED file rather than
 * the repo copy so a stale install is visible as a mismatch.
 *
 * @returns the digest, or null when the file cannot be read.
 */
function installedPatchDigest() {
  const home = process.env.DSH_HOME
  if (home === undefined) return null
  const path = `${home.replace(/\\/g, '/')}/profiles/daily/cordis.patch.yml`
  if (!existsSync(path)) return { path, sha256: null, error: 'not found' }
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

/** Resolve a package the way the LAUNCHER's own resolver does, and realpath it. */
function resolveModuleRealpath(specifier) {
  const require = createRequire('D:/DSH/src/dsh-src/apps/cli/lib/bin.js')
  return realpathSync(require.resolve(specifier))
}

/** One tool call through the REAL registry, on behalf of a REAL agent. */
async function callTool(ctx, agent, n, toolName, args) {
  const result = await ctx.get('tools').execute({
    callId: `t2-${n}`,
    name: toolName,
    arguments: args,
    ...agent === undefined ? {} : { agent },
    signal: new AbortController().signal,
  })
  const text = (result.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('\n')
  return {
    isError: result.isError === true,
    code: result.isError === true ? (result.error?.info?.code ?? null) : null,
    message: result.isError === true ? result.error.message : text,
  }
}

/**
 * Record a value or the failure that prevented it, without aborting the probe.
 *
 * `code` IS CARRIED, and that is a correction rather than a convenience. The
 * first version of this helper serialized only `name` and `message`, so the
 * `fs/edit-intent` listener's refusal arrived as
 *
 *   FsError: edit requires reading "…intent-probe.txt" first
 *
 * and the driver's check looked for the string `FS_NOT_OBSERVED` IN THE MESSAGE.
 * The listener HAD answered and HAD refused with the right code -- `FsError`
 * carries it on `.code` (`packages/fs/fs/src/types.ts:196-202`), and this
 * project's own rule is to route on the code and never parse the message. The
 * check therefore reported a missing listener when the only thing missing was a
 * serialized field. The code is now captured and asserted directly.
 */
async function attempt(label, fn) {
  try {
    return { label, ok: true, value: await fn() }
  } catch (error) {
    return {
      label,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      code: typeof error?.code === 'string' ? error.code : null,
    }
  }
}

export async function apply(ctx) {
  const finding = {
    probe: 'verify-t2-fs',
    dshHome: process.env.DSH_HOME ?? null,
    bootCwd: process.cwd(),
    // The composition this result describes, as a digest of the INSTALLED patch.
    installedProfilePatch: installedPatchDigest(),
    // `presetRoots` is what `readResult()` in boot-harness.mjs asserts against,
    // binding this result to the home that was booted.
    presetRoots: [],
    presetDefaultId: null,
    error: null,
  }
  try {
    // ── the preset roster, so the result names the home it came from ─────────
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetDefaultId = roster.defaultId ?? null
      finding.presetRoots = (roster.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))
    }

    // ── 1. provider identity ────────────────────────────────────────────────
    const fs = ctx.get('fs')
    finding.fsPresent = fs !== undefined
    if (fs === undefined) throw new Error('ctx.fs is absent: the profile mounted no filesystem')

    const chain = []
    for (let proto = Object.getPrototypeOf(fs); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      chain.push(proto.constructor?.name ?? '<anonymous>')
    }
    finding.providerClassName = fs.constructor?.name ?? null
    finding.providerPrototypeChain = chain

    // Route 2: class identity against the RESOLVED MODULE, with its realpath.
    // `instanceof LocalFileSystem` is true for BOTH providers (the sandboxed one
    // extends it), so the discriminating assertions are exact-constructor
    // equality and the ABSENCE of SandboxedFileSystem from the chain.
    //
    // THE PROXY SUBTLETY, measured rather than assumed: `ctx.fs` is a cordis
    // TRACE PROXY, not the raw service (`vendor/cordis/src/reflect.ts:154` wraps
    // every service read in `getTraceable`, and `createTraceable` returns
    // `new Proxy(value, ...)`, `vendor/cordis/src/utils.ts:173`). So
    // `ctx.fs.constructor` returns a WRAPPED constructor and exact equality
    // against the module's exported class is false even for a correct mount --
    // the first run of this probe reported `providerIsExactLocalClass: false`
    // alongside `providerIsInstanceOfLocalClass: true` for exactly that reason.
    // Weakening the check to `instanceof` alone would lose the ability to
    // distinguish the two providers, so the proxy is UNWRAPPED instead:
    // `symbols.original` is cordis's own escape hatch (`utils.ts:175` returns
    // the raw target for it), and `Symbol.for` means the key is stable across
    // module instances.
    const ORIGINAL = Symbol.for('cordis.original')
    const rawFs = fs[ORIGINAL] ?? fs
    finding.fsWasTraceProxy = rawFs !== fs
    finding.rawProviderClassName = rawFs.constructor?.name ?? null
    const localPath = resolveModuleRealpath('@deepseek-ai/dsh-fs-local')
    const sandboxPath = resolveModuleRealpath('@deepseek-ai/dsh-fs-sandbox')
    finding.resolvedModuleRealpaths = { 'dsh-fs-local': localPath, 'dsh-fs-sandbox': sandboxPath }
    const localModule = await import(pathToFileURL(localPath).href)
    const sandboxModule = await import(pathToFileURL(sandboxPath).href)
    finding.providerIsExactLocalClass = rawFs.constructor === localModule.LocalFileSystem
    finding.providerIsInstanceOfLocalClass = rawFs instanceof localModule.LocalFileSystem
    finding.providerIsInstanceOfSandboxClass = rawFs instanceof sandboxModule.SandboxedFileSystem
    finding.sandboxClassInPrototypeChain = chain.includes('SandboxedFileSystem')
    // The same identity question asked of the SANDBOX class's own module, so a
    // reader can see the two classes are genuinely different objects and not
    // one class re-exported under two names.
    finding.providerClassesAreDistinct = localModule.LocalFileSystem !== sandboxModule.SandboxedFileSystem

    // Route 3: the composition, from the loader's own entry table. This is the
    // fact that separates "the class works" from "the product mounts it". Read
    // defensively: `ctx.loader` is a launcher-provided service, and a probe that
    // threw here would lose every assertion below it.
    const loader = ctx.get('loader')
    finding.loaderPresent = loader !== undefined
    //
    // THE TABLE IS RE-READ ON EVERY SAMPLE, and that is a correction to this probe
    // rather than a detail. The first version built `entries` ONCE and then looped
    // `while (!settled())` over that frozen array: the loop could not observe any
    // change, so it spun for its full deadline and reported the initial state as
    // the settled one. It produced a confident, wrong "hmr is stuck in LOADING"
    // finding on a row that had in fact activated. A snapshot cannot be used to
    // measure a transition; `readEntries()` is called fresh instead.
    const readEntries = () => {
      const rows = []
      if (loader === undefined) return rows
      for (const entry of loader.entries()) {
        rows.push({
          id: entry.options.id,
          name: entry.options.name,
          disabled: entry.disabled === true,
          fiberState: entry.fiber?.state ?? null,
        })
      }
      return rows
    }
    const entries = readEntries()
    // FiberState.ACTIVE === 2 (`vendor/cordis/src/fiber.ts:147-154`).
    finding.fsRows = entries.filter(row => row.id === 'fs-sandbox' || row.id === 'fs-local' || row.id === 'fs-observation-policy')
    const sandboxRow = entries.find(row => row.id === 'fs-sandbox')
    const localRow = entries.find(row => row.id === 'fs-local')
    const policyRow = entries.find(row => row.id === 'fs-observation-policy')
    finding.fsSandboxRowDisabled = sandboxRow?.disabled ?? null
    finding.fsLocalRowActive = localRow?.fiberState === 2
    finding.fsObservationPolicyRowActive = policyRow?.fiberState === 2
    finding.fsSandboxRowFiberState = sandboxRow?.fiberState ?? null
    finding.fsLocalRowFiberState = localRow?.fiberState ?? null
    finding.fsObservationPolicyRowFiberState = policyRow?.fiberState ?? null
    // The inactive-entry count the harness's baseline compares against: a row
    // that never activated is what FACT F produced (toolCount: 0).
    //
    // EVERY non-active entry is reported WITH its state and its own error, because
    // "one entry did not activate" is not a finding a reader can act on: PENDING
    // (0), LOADING (1) and FAILED (3) are different diagnoses, and a bare id list
    // cannot tell them apart. `FiberState` is `PENDING=0, LOADING=1, ACTIVE=2,
    // FAILED=3, DISPOSED=4, UNLOADING=5` (`vendor/cordis/src/fiber.ts:147-154`).
    //
    // THE COMPOSITION IS ALLOWED TO SETTLE FIRST, and this is a correction rather
    // than a convenience. `apply()` runs as the loading callback of THIS probe's
    // own fiber, and it gates on `sessionController`, which publishes EARLY --
    // so a row that is merely slower than `sessionController` is still LOADING
    // when the first sample is taken. Reading that as "failed to activate" is a
    // race, not a finding. The probe therefore re-samples until the only non-active
    // entry is its own row, or a bounded deadline passes.
    //
    // `ctx.loader.await()` is deliberately NOT used: it awaits every entry's
    // `_initTask`, and this probe's own entry is one of them, so awaiting it from
    // inside `apply()` would wait on itself and deadlock. Sampling with a bounded
    // deadline has no such coupling.
    const SELF_ID = 'verify-t2-fs'
    const pendingExceptSelf = rows => rows.filter(row => !row.disabled && row.fiberState !== 2 && row.id !== SELF_ID)
    const settleDeadline = Date.now() + 8000
    finding.settleSamples = []
    let settledRows = readEntries()
    while (pendingExceptSelf(settledRows).length > 0 && Date.now() < settleDeadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
      settledRows = readEntries()
      finding.settleSamples.push(
        pendingExceptSelf(settledRows).map(row => `${row.id}:${String(row.fiberState)}`),
      )
    }
    finding.settledWithinMs = 8000 - Math.max(0, settleDeadline - Date.now())
    const describeRow = (row) => {
      const entry = loader.entries().find(candidate => candidate.options.id === row.id)
      const error = entry?.fiber?._error
      return {
        id: row.id,
        name: row.name,
        fiberState: row.fiberState,
        error: error === undefined || error === null
          ? null
          : (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      }
    }
    const nonActive = settledRows.filter(row => row.fiberState !== 2 && !row.disabled)
    finding.nonActiveEntries = nonActive.map(describeRow)
    finding.selfRowId = SELF_ID
    finding.inactiveEntryIds = nonActive
      .filter(row => row.id !== SELF_ID)
      .map(row => row.id)
    finding.selfRowFiberState = nonActive.find(row => row.id === SELF_ID)?.fiberState ?? null
    // `hmr` is the row this check actually caught. Its constructor throws when the
    // loader exposes no internal module loader
    // (`packages/boot/hmr/src/index.ts:180-182`: "--expose-internals is required
    // for HMR service"), so the loader's own capability is reported alongside it --
    // that is the difference between "the row is broken" and "the host this probe
    // launched did not offer the capability the row requires".
    finding.loaderInternalPresent = loader?.internal !== undefined && loader?.internal !== null

    // ── 2. sandboxMode capability fact + the schemas it gates ───────────────
    finding.fsSandboxMode = fs.sandboxMode ?? null
    const policy = ctx.get('sandboxPolicy')
    finding.sandboxPolicyPresent = policy !== undefined
    // Reported, never assumed: if this is already `danger-full-access` then the
    // fence was ALREADY inert and the containment delta below is a no-op.
    finding.sandboxPolicyDefaultMode = policy?.defaultMode ?? null
    finding.sandboxPolicyResolved = policy === undefined ? null : policy.resolve().mode

    // ── 3. a real Session, and its real tool face ───────────────────────────
    // The fixtures are rebuilt from empty on every run. This is not tidiness: the
    // observation policy makes the FIRST write to an existing file a
    // `createIfAbsent` rejection (`FS_NOT_OBSERVED`), which is correct product
    // behaviour and would be misread as a round-trip failure if a previous run's
    // file were still on disk. Measured: run 2 against a surviving
    // `round-trip.txt` failed the round-trip check for exactly that reason while
    // the product behaved correctly.
    rmSync(WORKSPACE, { recursive: true, force: true })
    rmSync(OUTSIDE, { recursive: true, force: true })
    mkdirSync(WORKSPACE, { recursive: true })
    mkdirSync(OUTSIDE, { recursive: true })
    const sc = ctx.get('sessionController')
    finding.sessionControllerPresent = sc !== undefined
    if (sc === undefined) throw new Error('ctx.sessionController is absent; this probe must gate on it (see the inject note)')
    const created = await sc.create({ cwd: WORKSPACE })
    const sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = sessionId !== null
    finding.sessionId = sessionId
    finding.sessionCwd = WORKSPACE

    const agent = ctx.get('agents')?.get(sessionId)
    finding.agentPresent = agent !== undefined
    const schemas = ctx.get('tools').schemas(agent)
    const names = schemas.map(schema => schema.name).sort()
    finding.toolCount = names.length
    finding.tools = names
    finding.ipythonToolPresent = names.includes('ipython')
    // The escalation fields are advertised ONLY under a confining backend
    // (`packages/fs/tool-fs/src/sandbox.ts:44-45`), so their presence/absence is
    // a second, independent read of the same capability fact -- and unlike the
    // containment behaviour it does NOT depend on the mode's VALUE.
    const propertiesOf = toolName => Object.keys(schemas.find(s => s.name === toolName)?.parameters?.properties ?? {})
    finding.mutationToolParameters = {
      write: propertiesOf('write'),
      edit: propertiesOf('edit'),
    }
    finding.escalationFieldsAdvertised = {
      write: propertiesOf('write').filter(k => k === 'sandbox_permissions' || k === 'justification'),
      edit: propertiesOf('edit').filter(k => k === 'sandbox_permissions' || k === 'justification'),
    }

    // ── 4. the observation policy, probed BEHAVIOURALLY ─────────────────────
    // The bare default for both waterfalls is `undefined`, so a defined
    // write-intent or a thrown FS_NOT_OBSERVED edit-intent can only come from a
    // live listener. An entry-state check would not distinguish a mounted row
    // that registers nothing.
    const probeTarget = await fs.resolve(`${WORKSPACE}/intent-probe.txt`)
    finding.writeIntentWithNoActor = await attempt('write-intent', async () =>
      await ctx.waterfall('fs/write-intent', probeTarget, undefined, () => undefined))
    finding.editIntentWithNoActor = await attempt('edit-intent', async () =>
      await ctx.waterfall('fs/edit-intent', probeTarget, undefined, () => undefined))

    // ── 5. read -> write -> edit round trip through the REAL tools ──────────
    const file = `${WORKSPACE}/round-trip.txt`
    finding.roundTrip = {}
    finding.roundTrip.write = await callTool(ctx, agent, 1, 'write', { file_path: file, content: 'line-one\nline-two\n' })
    finding.roundTrip.read = await callTool(ctx, agent, 2, 'read', { file_path: file })
    finding.roundTrip.edit = await callTool(ctx, agent, 3, 'edit', { file_path: file, old_string: 'line-two', new_string: 'line-2' })
    finding.roundTrip.contentAfterEdit = existsSync(file) ? readFileSync(file, 'utf8') : null
    finding.roundTrip.roundTripOk = finding.roundTrip.write.isError === false
      && finding.roundTrip.edit.isError === false
      && finding.roundTrip.contentAfterEdit === 'line-one\nline-2\n'

    // ── 6. a STALE-VERSION write is still refused ───────────────────────────
    // The staleness is real: the observation policy recorded the version at
    // read time, then plain `node:fs` (no DSH tool, no fs service) replaces the
    // file out of band. The next edit carries the STALE observed version.
    finding.staleVersion = {}
    finding.staleVersion.read = await callTool(ctx, agent, 4, 'read', { file_path: file })
    const beforeOutOfBand = readFileSync(file, 'utf8')
    writeFileSync(file, 'REPLACED OUT OF BAND by plain node:fs, a different length entirely\n', 'utf8')
    finding.staleVersion.outOfBandWrite = { from: beforeOutOfBand, to: readFileSync(file, 'utf8') }
    finding.staleVersion.edit = await callTool(ctx, agent, 5, 'edit', { file_path: file, old_string: 'line-1', new_string: 'x' })
    finding.staleVersion.refused = finding.staleVersion.edit.isError === true
    finding.staleVersion.code = finding.staleVersion.edit.code
    finding.staleVersion.codeIsStaleVersion = finding.staleVersion.edit.code === 'FS_STALE_VERSION'
    // The refusal must also be a NON-EFFECT: the out-of-band content stands.
    finding.staleVersion.contentUnchangedAfterRefusal = readFileSync(file, 'utf8')
      === finding.staleVersion.outOfBandWrite.to

    // ── 7. an exact edit that does NOT match is still refused ───────────────
    finding.exactMatch = {}
    finding.exactMatch.read = await callTool(ctx, agent, 6, 'read', { file_path: file })
    const beforeNoMatch = readFileSync(file, 'utf8')
    finding.exactMatch.edit = await callTool(ctx, agent, 7, 'edit', {
      file_path: file,
      old_string: 'THIS-LITERAL-STRING-APPEARS-NOWHERE-IN-THE-FILE',
      new_string: 'x',
    })
    finding.exactMatch.refused = finding.exactMatch.edit.isError === true
    finding.exactMatch.code = finding.exactMatch.edit.code
    finding.exactMatch.codeIsEditNotFound = finding.exactMatch.edit.code === 'FS_EDIT_NOT_FOUND'
    finding.exactMatch.contentUnchangedAfterRefusal = readFileSync(file, 'utf8') === beforeNoMatch

    // ── 8. the access-containment delta, in whichever direction is live ─────
    // The SAME probe binary runs against both compositions, so this is a
    // measurement of the delta rather than an assertion about it.
    const outsideFile = `${OUTSIDE}/escape.txt`
    finding.outsideWorkspaceWrite = await callTool(ctx, agent, 8, 'write', {
      file_path: outsideFile,
      content: 'written outside the session workspace\n',
    })
    finding.outsideWorkspaceWriteSucceeded = finding.outsideWorkspaceWrite.isError === false
    finding.outsideWorkspaceFileExists = existsSync(outsideFile)
    // Reads were never fenced -- every mode permits reading -- so this is the
    // control that separates "the fence denies" from "the path is unreachable".
    const outsideReadPath = `${OUTSIDE}/pre-existing-outside.txt`
    if (!existsSync(outsideReadPath)) writeFileSync(outsideReadPath, 'pre-existing content outside the workspace\n', 'utf8')
    finding.outsideWorkspaceRead = await callTool(ctx, agent, 9, 'read', { file_path: outsideReadPath })
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(finding, null, 2), 'utf8')
  process.stdout.write(`VERIFY-T2-FS: ${JSON.stringify({ out: OUT, provider: finding.providerClassName, error: finding.error })}\n`)
}
