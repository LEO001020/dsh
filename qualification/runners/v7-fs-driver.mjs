/**
 * V7 driver: boot the real profile through the shared harness and report the
 * FILESYSTEM family's measurements for spec FS-01..FS-06.
 *
 * WHY A DRIVER AND NOT JUST THE PROBE. The probe runs INSIDE the host and sees
 * only the host's own view. Three facts this task must report are properties of
 * the BOOT, not of the context: the port was genuinely free, the host was killed,
 * and the port was released afterwards. The shared `boot-harness.mjs` owns those,
 * so this driver owns only the READING of the result -- the harness deliberately
 * does not interpret, because a shared helper that also judged would be a second
 * oracle.
 *
 * WHAT THIS DRIVER ADDS THAT THE T2 DRIVER DID NOT. T2's driver reported the
 * provider swap. This one reports the SIX SPEC ORACLES, each as its own named
 * check, and it deliberately keeps the "not refused" direction visible: FS-04's
 * oracle requires a vector that is NOT refused to be recorded as a finding rather
 * than folded into a green, so a check that merely tested "did the write happen"
 * would be the wrong shape.
 *
 * Usage: node qualification/runners/v7-fs-driver.mjs
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, cpSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { bootAndWait, readResult, LAUNCHER } from './boot-harness.mjs'

const REPO = 'D:/DSH/work/dsh-native-daily'
const RESULT_DIR = `${REPO}/qualification/results/V7-fs`
const HOME = 'D:/DSH/home/v7-fs'
const PROFILE = 'daily'
const PROFILE_SRC = `${REPO}/profiles/daily-candidate`
const PROFILE_DIR = `${HOME}/profiles/${PROFILE}`

const OUT = `${RESULT_DIR}/boot.json`
const VERDICT = `${RESULT_DIR}/VERDICT.json`
const TRANSCRIPT = `${RESULT_DIR}/transcript.txt`

/** SHA-256 of a file, or null when it cannot be read. */
function digest(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
}

/**
 * Digest every built artifact this boot will load, plus a src-vs-lib staleness
 * check.
 *
 * WHY. Every home installs the extension packages through a `link:`, so a boot
 * executes the repo's BUILT `lib/`, never its `src/`. A `lib/` older than its
 * `src/` means the measurement describes a previous build -- the trap that
 * produced a stale-`lib/` false finding in this project. The digests make "which
 * build does this describe" a field rather than an inference, and the staleness
 * check names any file that would make the numbers describe an older source.
 */
function buildIdentity() {
  const identity = {}
  for (const pkg of ['dsh-daily-work', 'dsh-ipython']) {
    const libDir = `${REPO}/packages/${pkg}/lib`
    const srcDir = `${REPO}/packages/${pkg}/src`
    const hasher = createHash('sha256')
    const files = []
    if (existsSync(libDir)) {
      // Non-recursive on purpose: the build output is flat, and a recursive walk
      // here would be an unbounded filesystem scan for no gain.
      for (const name of readdirSync(libDir).sort()) {
        if (!name.endsWith('.js')) continue
        hasher.update(name)
        hasher.update(readFileSync(`${libDir}/${name}`))
        files.push(name)
      }
    }
    // The staleness check: for each built `.js`, is there a `src/*.ts` NEWER than
    // it? A newer source means the lib does not describe that source.
    const stale = []
    if (existsSync(srcDir)) {
      for (const name of readdirSync(srcDir).sort()) {
        if (!name.endsWith('.ts')) continue
        const base = name.replace(/\.ts$/u, '')
        const libFile = `${libDir}/${base}.js`
        if (!existsSync(libFile)) continue
        if (statMtime(libFile) < statMtime(`${srcDir}/${name}`)) {
          stale.push({ module: base, lib: new Date(statMtime(libFile)).toISOString(), src: new Date(statMtime(`${srcDir}/${name}`)).toISOString() })
        }
      }
    }
    identity[pkg] = { fileCount: files.length, digest: hasher.digest('hex'), libNewerThanSrc: stale.length === 0, stale }
  }
  return identity
}

function statMtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Install the profile FRESH from the repository, so this boot measures the
 * repository's composition rather than a previous agent's copy.
 *
 * MEASURED REASON THIS IS NOT OPTIONAL: the installed profile patch under
 * `$DSH_HOME/profiles/daily/` is a COPY, and this machine's homes hold several
 * different revisions of it. Booting one measures that home's copy. A sibling
 * agent's T2 measurement was invalidated exactly this way (its home held
 * `3755f904…` while the repo had `5b8b2a8e…`, and the difference was real rows,
 * not comments).
 *
 * `plugin install` is required because it materialises `node_modules` for the
 * `link:` dependencies. Without it the profile's bundles do not resolve and the
 * boot fails with `cannot resolve profile bundle "dsh-daily-work"` -- a property
 * of the install step, not of the composition.
 */
function freshInstall() {
  const result = {}
  const existed = existsSync(PROFILE_DIR)
  if (existed) rmSync(PROFILE_DIR, { recursive: true, force: true })
  mkdirSync(`${HOME}/profiles`, { recursive: true })
  cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })
  result.replacedExisting = existed
  try {
    const stdout = execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', PROFILE, 'install'], {
      cwd: PROFILE_DIR,
      env: { ...process.env, DSH_HOME: HOME },
      encoding: 'utf8',
      timeout: 300_000,
    })
    result.exitCode = 0
    result.stdoutTail = stdout.slice(-1500)
  } catch (error) {
    result.exitCode = error.status ?? null
    result.error = String(error.message.split('\n')[0])
    result.stderrTail = String(error.stderr ?? '').slice(-1500)
  }
  return result
}

/**
 * Clear a STALE writer lock left in this home by a previous kill.
 *
 * The credentials store serializes read-render-commit through a `wx` lock file
 * recording the holder's pid (`packages/util/atomic-write/src/index.ts:158-185`).
 * The shared harness stops hosts with `SIGKILL`, which on win32 is
 * `TerminateProcess`, so the `finally` that removes the lock never runs and the
 * pid in the file is dead. The NEXT boot then fails with
 *
 *   dsh: startup failed: 1 required plugin did not activate
 *     connection (required)
 *     Error: atomic-write: timed out waiting for the writer lock at ...lock
 *
 * which reads exactly like a composition failure and is not one. Only THIS
 * probe's own home is touched, and only a lock whose recorded pid is not running:
 * a live holder is never disturbed, so this cannot mask real contention.
 * @returns a description of what was cleared, for the transcript.
 */
function clearStaleLock() {
  const lock = `${HOME}/.credentials.yaml.lock`
  if (!existsSync(lock)) return 'no lock present'
  const pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10)
  if (Number.isInteger(pid)) {
    try {
      process.kill(pid, 0)
      return `lock held by LIVE pid ${String(pid)} -- left alone`
    } catch {
      // ESRCH: no such process, so the lock is stale.
    }
  }
  rmSync(lock)
  return `removed stale lock (dead pid ${String(pid)})`
}

const lines = []
const say = (text) => { lines.push(text); process.stdout.write(`${text}\n`) }

say('=== V7: FILESYSTEM family (spec FS-01..FS-06), verified through a real profile boot ===')
say('')
say(`home:      ${HOME}`)
say(`profile:   ${PROFILE}`)
say(`overlay:   ${REPO}/qualification/runners/v7-fs.patch.yml`)
say(`probe_out: ${OUT}`)
say('')

// ---------------------------------------------------------------------------
// (0) the BUILD this measurement describes.
// ---------------------------------------------------------------------------
const build = buildIdentity()
for (const [pkg, row] of Object.entries(build)) {
  say(`build ${pkg}: ${String(row.fileCount)} lib files, sha256=${String(row.digest)}`)
  say(`  libNewerThanSrc: ${String(row.libNewerThanSrc)}${row.libNewerThanSrc ? '' : ` -- STALE: ${JSON.stringify(row.stale)}`}`)
}
say('')

// ---------------------------------------------------------------------------
// (1) a FRESH install, so this boot measures the REPOSITORY's composition.
// ---------------------------------------------------------------------------
const install = freshInstall()
say(`profile installed: ${PROFILE_SRC} -> ${PROFILE_DIR} (replaced an existing copy: ${String(install.replacedExisting)})`)
say(`plugin install: exit=${String(install.exitCode)}${install.error === undefined ? '' : ` -- ${String(install.error)}`}`)
if (install.exitCode !== 0) {
  say('--- install stdout (tail) ---')
  say(String(install.stdoutTail ?? ''))
  say('--- install stderr (tail) ---')
  say(String(install.stderrTail ?? ''))
}
say('')

/**
 * The composition this run describes, as two digests.
 *
 * `installed` is the patch the booted host actually loaded; `repo` is the
 * checked-in copy it is supposed to have come from. A reader who has only one of
 * them cannot tell a stale install from a current one -- the trap that produced a
 * stale M12 install and a stale-`lib/` false finding in this project. Reporting
 * both makes the comparison mechanical, and `isCurrent` states the answer.
 */
const composition = {
  installed: digest(`${PROFILE_DIR}/cordis.patch.yml`),
  repo: digest(`${PROFILE_SRC}/cordis.patch.yml`),
}
composition.isCurrent = composition.installed !== null && composition.installed === composition.repo
say(`composition_installed_sha256: ${String(composition.installed)}`)
say(`composition_repo_sha256:      ${String(composition.repo)}`)
say(`composition_is_current: ${String(composition.isCurrent)}`)
say(`stale_lock: ${clearStaleLock()}`)
say('')

// Boot from a FOREIGN cwd. The preset root is derived from `ctx.baseUrl`, and the
// recorded G-FIX-12/G-FIX-13 defects were both cwd-dependent preset-root bugs that
// looked healthy when booted from the profile's own directory.
const FOREIGN_CWD = 'D:/DSH/src/dsh-src'
const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [`${REPO}/qualification/runners/v7-fs.patch.yml`],
  outPath: OUT,
  cwd: FOREIGN_CWD,
})

say(`boot_cwd: ${FOREIGN_CWD} (deliberately foreign to the profile directory)`)
say(`port: ${String(boot.port)} (bound by the harness, not assumed)`)
say(`timed_out: ${String(boot.timedOut)}`)
say(`exit_code: ${String(boot.exitCode)}`)
say(`port_released_after_kill: ${String(boot.portReleased)}`)
say('')

// The harness's guard against the G-FIX-13 false PASS: a probe writing to a fixed
// path is a shared mutable resource, so the result must NAME the home we booted
// before any of it is read as ours.
let json
try {
  const read = readResult(OUT, HOME)
  json = read.json
  say(`result_names_this_home: true (presetRoots: ${read.roots.join(', ')})`)
} catch (error) {
  // A missing result is a finding about the BOOT, so the host's own output is
  // dumped rather than swallowed -- otherwise a failed boot and a failed probe are
  // indistinguishable, which is how a composition failure gets misread as a probe
  // bug (and vice versa).
  say(`result_names_this_home: FALSE -- ${error instanceof Error ? error.message : String(error)}`)
  say('')
  say('--- host stdout (tail) ---')
  say(boot.stdout.split('\n').slice(-40).join('\n'))
  say('--- host stderr (tail) ---')
  say(boot.stderr.split('\n').slice(-40).join('\n'))
  writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`, 'utf8')
  writeFileSync(VERDICT, JSON.stringify({ ok: false, reason: 'no probe result', exitCode: boot.exitCode, portReleased: boot.portReleased }, null, 2))
  process.exit(2)
}
say('')

const warningLines = boot.stderr.split('\n').filter(line => line.includes('did not activate'))
say(`activation_warning_lines: ${JSON.stringify(warningLines)}`)
say(`probe_error: ${json.error === null ? 'none' : String(json.error)}`)
say('')

const checks = {
  // ── the boot is a real composed profile, so the measurements mean something ──
  'the tool face is not zero (FACT F did not occur)': (json.toolFace?.count ?? 0) > 0,
  'no entry failed to activate': warningLines.length === 0,
  'the ipython tool is on the real surface': json.toolFace?.ipythonPresent === true,

  // ── FS-01: the write boundary is DISCLOSED, not claimed ────────────────────
  'FS-01: a write OUTSIDE the workspace succeeds under the deployed mode':
    json.fs01?.outsideWriteSucceeded === true,
  'FS-01: the file really exists outside the workspace':
    json.fs01?.outsideFileExists === true,
  'FS-01: the deployment records that the mounted backend does NOT confine (fsSandboxMode undefined)':
    json.fs01?.disclosed?.fsSandboxMode === null,
  'FS-01: the escalation fields are ABSENT from the write/edit schemas (no fence to escalate past)':
    (json.escalationFieldsAdvertised?.write ?? ['x']).length === 0
    && (json.escalationFieldsAdvertised?.edit ?? ['x']).length === 0,
  'FS-01: the deployment states in its own words that no write confinement is claimed':
    typeof json.fs01?.lockTrustModelStatement === 'string'
    && /NO confinement of reads, writes/iu.test(json.fs01.lockTrustModelStatement),
  'FS-01: the spec itself lists filesystem write confinement as NOT claimed':
    Array.isArray(json.fs01?.specExplicitlyNotClaimed)
    && json.fs01.specExplicitlyNotClaimed.some(s => /filesystem write confinement/iu.test(String(s))),

  // ── FS-02: the read boundary is DISCLOSED, not claimed ─────────────────────
  'FS-02: a read OUTSIDE the workspace through the NATIVE tool succeeds':
    json.fs02?.nativeReadSucceeded === true,
  'FS-02: the same read through a PYTHON cell succeeds': json.fs02?.pythonRead?.ok === true,
  'FS-02: both routes reach the SAME BYTES (digest compared)':
    json.fs02?.bothRoutesReachedSameBytes === true,

  // ── FS-03: one path string, four routes, one file ──────────────────────────
  'FS-03: the native `read` tool resolves the path to the canary': json.fs03?.readToolSawCanary === true,
  'FS-03: the native `grep` tool resolves the path to the canary': json.fs03?.grepToolSawCanary === true,
  'FS-03: a SPAWNED process resolves the path to the same digest':
    json.fs03?.shellSawSameDigest === true,
  'FS-03: a PYTHON cell resolves the path to the same digest': json.fs03?.pythonSawSameDigest === true,
  'FS-03: all four routes reached the same file in one world':
    json.fs03?.allFourReachedSameFile === true,

  // ── FS-04: link and rename, PER VECTOR ─────────────────────────────────────
  // The oracle demands that each vector is recorded SEPARATELY and that the
  // correctness half holds. The refusal direction is reported in the transcript
  // rather than asserted as a requirement the deployment never made -- but a
  // refusal that came from the OBSERVATION POLICY rather than from containment
  // must not be read as containment, so the code is recorded and checked here.
  'FS-04: the symlink vector was attempted and its outcome recorded':
    typeof json.fs04?.symlink?.verdict === 'string',
  'FS-04: the hardlink vector was attempted and its outcome recorded':
    typeof json.fs04?.hardlink?.verdict === 'string',
  'FS-04: the cross-boundary rename vector was attempted and its outcome recorded':
    typeof json.fs04?.rename?.verdict === 'string',
  'FS-04: the rename did NOT corrupt content (digest before == digest after)':
    json.fs04?.rename?.contentIntact === true,
  'FS-04: the native tool read the moved file at its NEW path and saw the real content':
    json.fs04?.rename?.nativeReadSawMovedContent === true,
  'FS-04: the symlink vector actually reached the mutation (its refusal, if any, is NOT FS_NOT_OBSERVED)':
    json.fs04?.symlink?.writeThroughLink?.code !== 'FS_NOT_OBSERVED',
  'FS-04: the hardlink vector actually reached the mutation (its refusal, if any, is NOT FS_NOT_OBSERVED)':
    json.fs04?.hardlink?.writeThroughLink?.code !== 'FS_NOT_OBSERVED',

  // ── FS-05: structured file tools keep their documented semantics ───────────
  'FS-05: read with offset/limit returns EXACTLY the requested window':
    json.fs05?.windowIsExact === true,
  'FS-05: an exact unique replacement applies once': json.fs05?.exactEditApplied === true,
  'FS-05: the exact edit produced the expected content':
    json.fs05?.exactEditContent === 'alpha BETA gamma\n',
  'FS-05: an AMBIGUOUS replacement is REFUSED, not guessed':
    json.fs05?.ambiguousRefused === true,
  'FS-05: the refused ambiguous edit changed nothing':
    json.fs05?.ambiguousContentUnchanged === true,
  'FS-05: an absent literal is refused with its own code':
    json.fs05?.missingRefused === true && json.fs05?.missingCode === 'FS_EDIT_NOT_FOUND',
  'FS-05: the refused absent-literal edit changed nothing':
    json.fs05?.missingContentUnchanged === true,

  // ── FS-06: workspace files vs store-owned artifacts ────────────────────────
  'FS-06: the artifact store is present and reports its own root':
    json.fs06?.dataPlanePresent === true && typeof json.fs06?.storeRoot === 'string',
  'FS-06: the store root RESOLVES OUTSIDE the session workspace':
    json.fs06?.storeRootIsInsideWorkspace === false,
  'FS-06: the store root is RELATIVE, and the record names what it resolves against':
    json.fs06?.storeRootIsRelative === true
    && typeof json.fs06?.storeRootResolvedAgainst === 'string',
  'FS-06: a published object\'s address IS its content digest':
    json.fs06?.artifactDigestMatchesContent === true,
  'FS-06: a workspace file with the artifact\'s own name does NOT change the store object':
    json.fs06?.storeBytesUnchanged === true && json.fs06?.objectOnDiskUnchanged === true,
  'FS-06: the store reports its own verdict on the object after the same-name write':
    json.fs06?.storeStatAfterSameNameWrite?.ok === true,
  // The finding this case's oracle is really about: one relative name, two files.
  'FS-06: the relative store path and the session-relative path are DIFFERENT files (recorded as a finding)':
    json.fs06?.sameRelativeNameTwoFiles === true
    && json.fs06?.storeObjectUntouchedByRelativeWrite === true,
  // And the absolute path DOES reach the store's object, so the two trees are not
  // a permission boundary -- only a naming divergence.
  'FS-06: the store object\'s ABSOLUTE path IS reachable by the tool (no confinement claimed)':
    json.fs06?.directObjectWriteSucceeded === true && json.fs06?.objectWasTampered === true,
}

const failed = Object.entries(checks).filter(([, ok]) => ok !== true)
const passed = Object.entries(checks).filter(([, ok]) => ok === true)

say('--- checks ---')
for (const [label, ok] of Object.entries(checks)) say(`${ok === true ? 'ok  ' : 'FAIL'} ${label}`)
say('')
say(`checks_passed: ${String(passed.length)}/${String(Object.keys(checks).length)}`)
say('')

// The FINDINGS the oracle requires to be visible rather than folded into a green.
say('--- FS-04 vectors, recorded per vector (a non-refusal is a FINDING, not a green) ---')
for (const vector of ['symlink', 'hardlink', 'rename']) {
  const entry = json.fs04?.[vector]
  say(`  ${vector.padEnd(9)} refused=${String(entry?.refused)} verdict=${String(entry?.verdict)}`)
}
say('')
say('--- FS-01 disclosure, both halves ---')
say(`  write outside the workspace succeeded: ${String(json.fs01?.outsideWriteSucceeded)}`)
say(`  fsSandboxMode (undefined = the backend does not confine): ${String(json.fs01?.disclosed?.fsSandboxMode)}`)
say(`  sandboxPolicy.defaultMode: ${String(json.fs01?.disclosed?.sandboxPolicyDefaultMode)}`)
say(`  modeSource: ${String(json.fs01?.disclosed?.modeSource)}`)
say(`  CONTRADICTION CHECK: fsClaimsNoConfinement=${String(json.fs01?.disclosureContradiction?.fsClaimsNoConfinement)} policyDefaultStillConfines=${String(json.fs01?.disclosureContradiction?.policyDefaultStillConfines)}`)
say('')
say('--- FS-06 artifact store ---')
say(`  storeRoot (as configured): ${String(json.fs06?.storeRoot)}`)
say(`  storeRootIsRelative: ${String(json.fs06?.storeRootIsRelative)} -- resolved against ${String(json.fs06?.storeRootResolvedAgainst)}`)
say(`  storeRootResolved: ${String(json.fs06?.storeRootResolved)}`)
say(`  ownerScope: ${String(json.fs06?.ownerScope)} executionWorld: ${String(json.fs06?.executionWorld)}`)
say(`  artifact: ${String(json.fs06?.artifact)}`)
say(`  THE DIVERGENCE -- one relative name, two files:`)
say(`    sameRelativeNameTwoFiles: ${String(json.fs06?.sameRelativeNameTwoFiles)}`)
say(`    the tool resolved the relative path to: ${String(json.fs06?.relativeWriteTargetAsSeenByTool)}`)
say(`    the store's object is at:               ${String(json.fs06?.objectOnDisk)}`)
say(`    store object untouched by the relative write: ${String(json.fs06?.storeObjectUntouchedByRelativeWrite)}`)
say(`  the ABSOLUTE store object path through the tool succeeded: ${String(json.fs06?.directObjectWriteSucceeded)}`)
say(`  the object on disk WAS tampered by the absolute write: ${String(json.fs06?.objectWasTampered)}`)
say(`  the store's own read after tampering: ${JSON.stringify(json.fs06?.storeReadAfterTamper)}`)
say(`  the store's own reconcile: ${JSON.stringify(json.fs06?.reconcile)}`)
say('')

const verdict = {
  ok: failed.length === 0,
  checksPassed: passed.length,
  checksTotal: Object.keys(checks).length,
  failedChecks: failed.map(([label]) => label),
  checks,
  composition,
  build,
  install: { exitCode: install.exitCode, replacedExisting: install.replacedExisting },
  // The measured facts a reader needs, carried up so the gate table can cite them
  // without re-reading the whole boot result.
  fs01: {
    outsideWriteSucceeded: json.fs01?.outsideWriteSucceeded ?? null,
    disclosed: json.fs01?.disclosed ?? null,
    disclosureContradiction: json.fs01?.disclosureContradiction ?? null,
    contractOk: json.fs01?.contractReport?.ok ?? null,
    contractViolations: json.fs01?.contractReport?.violations ?? null,
  },
  fs02: {
    nativeReadSucceeded: json.fs02?.nativeReadSucceeded ?? null,
    pythonReadOk: json.fs02?.pythonRead?.ok ?? null,
    bothRoutesReachedSameBytes: json.fs02?.bothRoutesReachedSameBytes ?? null,
    outsideReadDigest: json.fs02?.outsideReadDigest ?? null,
  },
  fs03: {
    readToolSawCanary: json.fs03?.readToolSawCanary ?? null,
    grepToolSawCanary: json.fs03?.grepToolSawCanary ?? null,
    shellSawSameDigest: json.fs03?.shellSawSameDigest ?? null,
    pythonSawSameDigest: json.fs03?.pythonSawSameDigest ?? null,
    allFourReachedSameFile: json.fs03?.allFourReachedSameFile ?? null,
    expectedDigest: json.fs03?.expectedDigest ?? null,
    executionWorld: json.fs03?.executionWorld ?? null,
    shellProvider: json.fs03?.shell?.provider ?? null,
  },
  fs04: {
    symlink: json.fs04?.symlink ? { created: json.fs04.symlink.created, refused: json.fs04.symlink.refused, writeEscapedWorkspace: json.fs04.symlink.writeEscapedWorkspace, verdict: json.fs04.symlink.verdict } : null,
    hardlink: json.fs04?.hardlink ? { created: json.fs04.hardlink.created, refused: json.fs04.hardlink.refused, writeEscapedWorkspace: json.fs04.hardlink.writeEscapedWorkspace, verdict: json.fs04.hardlink.verdict } : null,
    rename: json.fs04?.rename ? { refused: json.fs04.rename.refused, contentIntact: json.fs04.rename.contentIntact, nativeReadSawMovedContent: json.fs04.rename.nativeReadSawMovedContent, verdict: json.fs04.rename.verdict } : null,
  },
  fs05: {
    windowIsExact: json.fs05?.windowIsExact ?? null,
    windowLineNumbersPresent: json.fs05?.windowLineNumbersPresent ?? null,
    exactEditContent: json.fs05?.exactEditContent ?? null,
    ambiguousRefused: json.fs05?.ambiguousRefused ?? null,
    ambiguousCode: json.fs05?.ambiguousCode ?? null,
    missingCode: json.fs05?.missingCode ?? null,
  },
  fs06: {
    storeRoot: json.fs06?.storeRoot ?? null,
    storeRootIsRelative: json.fs06?.storeRootIsRelative ?? null,
    storeRootResolved: json.fs06?.storeRootResolved ?? null,
    storeRootResolvedAgainst: json.fs06?.storeRootResolvedAgainst ?? null,
    storeRootIsInsideWorkspace: json.fs06?.storeRootIsInsideWorkspace ?? null,
    artifact: json.fs06?.artifact ?? null,
    artifactDigestMatchesContent: json.fs06?.artifactDigestMatchesContent ?? null,
    sameNameWorkspaceFile: json.fs06?.sameNameWorkspaceFile ?? null,
    storeBytesUnchanged: json.fs06?.storeBytesUnchanged ?? null,
    objectOnDiskUnchanged: json.fs06?.objectOnDiskUnchanged ?? null,
    objectOnDisk: json.fs06?.objectOnDisk ?? null,
    relativeWriteTargetAsSeenByTool: json.fs06?.relativeWriteTargetAsSeenByTool ?? null,
    sameRelativeNameTwoFiles: json.fs06?.sameRelativeNameTwoFiles ?? null,
    storeObjectUntouchedByRelativeWrite: json.fs06?.storeObjectUntouchedByRelativeWrite ?? null,
    directObjectWriteSucceeded: json.fs06?.directObjectWriteSucceeded ?? null,
    objectWasTampered: json.fs06?.objectWasTampered ?? null,
    storeReadAfterTamper: json.fs06?.storeReadAfterTamper ?? null,
    reconcile: json.fs06?.reconcile ?? null,
  },
  toolFace: json.toolFace ?? null,
  escalationFieldsAdvertised: json.escalationFieldsAdvertised ?? null,
  boot: {
    port: boot.port,
    timedOut: boot.timedOut,
    exitCode: boot.exitCode,
    portReleased: boot.portReleased,
  },
  activationWarningLines: warningLines,
  probeError: json.error ?? null,
}

writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`, 'utf8')
writeFileSync(VERDICT, JSON.stringify(verdict, null, 2), 'utf8')
process.stdout.write(`\nwrote ${VERDICT} and ${TRANSCRIPT}\n`)
process.exit(failed.length === 0 ? 0 : 1)
