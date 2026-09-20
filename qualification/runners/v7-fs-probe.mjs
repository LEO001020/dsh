/**
 * V7 probe: the FILESYSTEM family's oracle legs that the T2 probe did not
 * measure, run INSIDE a real composed `daily-candidate` profile boot.
 *
 * WHY THIS EXISTS AND WHY THE T2 PROBE IS NOT ENOUGH.
 * `qualification/results/T2-fs/VERDICT.json` (23/23) measures the PROVIDER SWAP
 * and the mutation guards. It does NOT measure five of the six spec oracles,
 * because those oracles are not about which class is mounted:
 *
 *   FS-01  "the write boundary is disclosed, not claimed" -- needs the RECORD's
 *          own description of the boundary, not just the write's outcome.
 *   FS-02  "the read boundary is disclosed" -- needs a read through BOTH a
 *          native tool and a Python cell, plus the disclosure.
 *   FS-03  "one path string resolves to one file in one world" -- needs the
 *          SAME path through read / grep / a spawned process / a Python cell,
 *          compared against each other.
 *   FS-04  "link and rename behaviour is recorded per vector, including where
 *          nothing refuses" -- needs symlink / hardlink / cross-boundary rename
 *          attempted SEPARATELY, with a non-refusal reported as a finding.
 *   FS-05  "structured file tools keep their documented semantics" -- needs
 *          read-with-offset/limit, an exact edit, and an ambiguous edit.
 *   FS-06  "workspace files and store-owned artifacts are not conflated" --
 *          needs the artifact store's own root and a same-named workspace write.
 *
 * LABEL COLLISION, stated because it is a live trap in this repo.
 * `packages/dsh-daily-work/src/durability-advanced.test.ts` has a describe block
 * `T9-C: FILESYSTEM gates FS-01..FS-06`, and `verification-gates.test.ts` has
 * `FS-06` cases. Those labels PREDATE the trusted-local spec and their subjects
 * do NOT match it:
 *
 *   | label      | what that test measures                | spec case with that id  |
 *   |------------|----------------------------------------|-------------------------|
 *   | T9-C FS-01 | atomic write / abort leaves original   | FS-01 write disclosure  |
 *   | T9-C FS-02 | stale version rejected                 | FS-02 read disclosure   |
 *   | T9-C FS-03 | concurrent same-target serialization   | FS-03 one path, 4 routes|
 *   | T9-C FS-04 | exact edit / ambiguity / not found     | FS-04 link+rename       |
 *   | T9-C FS-05 | line endings through edit              | FS-05 structured tools  |
 *   | T9-C FS-06 | raw Python mutation visible to verifier| FS-06 workspace vs store|
 *
 * So the T9-C block is real evidence for the spec's FS-05 (edit semantics), and
 * it is evidence about the CORRECTNESS of the mounted backend that several cases
 * lean on -- but a label match is not an oracle match. This probe measures the
 * spec's oracles directly, and the gate table records both.
 *
 * HOW IT MEASURES, so a reader can falsify each one:
 *   - Every tool call goes through the REAL `ctx.tools.execute` registry on
 *     behalf of a REAL Agent, the way the model would call it.
 *   - The Python route is a REAL `python.exe` child process, the same
 *     interpreter the IPython surface uses, run as the same OS user.
 *   - The shell route is the REAL mounted `ctx.shell` executor.
 *   - The artifact route uses the REAL `ctx.dailyData` service and its own
 *     `store.root`.
 *
 * WHAT THIS DOES NOT PROVE: nothing about confinement. Under trusted-local there
 * is none to prove, and every "succeeded" below is the DEPLOYED behaviour, not a
 * bug. The disclosure half of FS-01/FS-02 is measured from the deployment's own
 * recorded words, not from prose in this file.
 *
 * RUN: via `qualification/runners/v7-fs-driver.mjs`, which owns the home, the
 * port and the output path. Do not run it by hand: a fixed output path is a
 * shared mutable resource (the G-FIX-13 false PASS).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, linkSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

export const name = 'verify-v7-fs'

/**
 * `dailyData` is in the gate because FS-06 is about the ARTIFACT STORE, and a
 * probe that activated before the data plane published would report a missing
 * store as a missing fact. `sessionController` is the same gate T2 needed: the
 * first version of that probe activated while `session-controller` was still
 * pending and reported `presetRoots: []`.
 *
 * `fs` and `tools` are the subject and the path the assertions drive.
 * `shell` is NOT injected: it is read with `ctx.get`, so an absent shell is
 * reported as a fact rather than making the probe pending.
 */
export const inject = ['sessionController', 'tools', 'fs', 'dailyData']

const REPO = 'D:/DSH/work/dsh-native-daily'
const OUT = process.env.DSH_PROBE_OUT ?? `${REPO}/qualification/results/V7-fs/boot.json`

/** The session workspace: what a confined deployment would treat as the root. */
const WORKSPACE = `${REPO}/qualification/results/V7-fs/workspace`
/** Genuinely OUTSIDE that workspace, and outside the platform temp areas a
 * `workspace-write` fence also allows (`packages/sandbox/sandbox/src/roots.ts`). */
const OUTSIDE = `${REPO}/qualification/results/V7-fs/outside-workspace`

/** The interpreter the IPython surface runs, verified present before use. */
const PYTHON = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** SHA-256 of the INSTALLED profile patch, from the home that was booted.
 *
 * Recorded because a result that names a composition but not its digest cannot
 * be re-checked: the same numbers describe a stale install and a current one.
 * Taken from the INSTALLED copy so a stale install shows up as a mismatch. */
function installedPatchDigest() {
  const home = process.env.DSH_HOME
  if (home === undefined) return null
  const path = `${home.replace(/\\/g, '/')}/profiles/daily/cordis.patch.yml`
  if (!existsSync(path)) return { path, sha256: null, error: 'not found' }
  return { path, sha256: sha256File(path) }
}

/** One tool call through the REAL registry, on behalf of a REAL agent. */
async function callTool(ctx, agent, n, toolName, args) {
  const result = await ctx.get('tools').execute({
    callId: `v7-${n}`,
    name: toolName,
    arguments: args,
    ...agent === undefined ? {} : { agent },
    signal: new AbortController().signal,
  })
  const text = (result.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('\n')
  return {
    isError: result.isError === true,
    // `FsError` carries the code on `.code` (`packages/fs/fs/src/types.ts:196-202`),
    // NOT in the message. The T2 probe read the message first and reported a
    // missing listener; this one routes on the code, as the project's own rule
    // requires.
    code: result.isError === true ? (result.error?.info?.code ?? null) : null,
    message: result.isError === true ? result.error.message : text,
  }
}

/** Record a value or the failure that prevented it, without aborting the probe. */
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

/** Run a Python snippet the way a cell would, and return stdout/stderr/exit. */
function runPython(script) {
  try {
    const stdout = execFileSync(PYTHON, ['-c', script], { encoding: 'utf8', timeout: 60_000 })
    return { ok: true, stdout, stderr: '', exitCode: 0 }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
      exitCode: typeof error.status === 'number' ? error.status : null,
    }
  }
}

export async function apply(ctx) {
  const finding = {
    probe: 'verify-v7-fs',
    dshHome: process.env.DSH_HOME ?? null,
    bootCwd: process.cwd(),
    installedProfilePatch: installedPatchDigest(),
    // What `readResult()` in boot-harness.mjs asserts against, binding this
    // result to the home the caller booted.
    presetRoots: [],
    error: null,
  }
  try {
    // ── 0. the home this result came from ────────────────────────────────────
    const presets = ctx.get('agentPresets')
    finding.presetRoots = (presets?.roots ?? []).map(r => ({ path: String(r.path ?? r), trust: r.trust ?? null }))
    finding.presetDefaultId = presets?.defaultId ?? null

    // ── 1. a real Session on the composed preset ─────────────────────────────
    // The fixtures are rebuilt from empty every run: the observation policy makes
    // the FIRST write to an EXISTING file a `createIfAbsent` rejection
    // (`FS_NOT_OBSERVED`), which is correct product behaviour and would be misread
    // as a failure if a previous run's file survived. MEASURED by T2: run 2
    // against a surviving `round-trip.txt` failed its round-trip check for exactly
    // that reason while the product behaved correctly.
    rmSync(WORKSPACE, { recursive: true, force: true })
    rmSync(OUTSIDE, { recursive: true, force: true })
    mkdirSync(WORKSPACE, { recursive: true })
    mkdirSync(OUTSIDE, { recursive: true })

    const sc = ctx.get('sessionController')
    if (sc === undefined) throw new Error('ctx.sessionController is absent; this probe must gate on it')
    const created = await sc.create({ cwd: WORKSPACE })
    const sessionId = created?.sessionId ?? created?.id ?? null
    const agent = ctx.get('agents')?.get(sessionId)
    finding.session = { created: sessionId !== null, sessionId, cwd: WORKSPACE, agentPresent: agent !== undefined }
    // The real Session object, kept for the contract's session half: passing only
    // the Agent would silently skip the session-override checks, and an
    // incomplete report is exactly the shape that reads as green.
    const session = agent?.session ?? ctx.get('sessions')?.get?.(sessionId) ?? undefined
    finding.session.sessionObjectAvailable = session !== undefined

    // ── FS-01: the write boundary, as DISCLOSED ──────────────────────────────
    // The oracle has two halves and BOTH are measured:
    //   (a) the write outside the workspace SUCCEEDS under the deployed mode;
    //   (b) the deployment's own record states that no write confinement is
    //       claimed -- and, critically, does NOT state that it is confined.
    // (b) is read from the LIVE `ctx.noSandboxContract` service, which is the
    // product's own self-check, plus the lock's `trust_model_statement`. Prose in
    // this probe is not evidence.
    finding.fs01 = {}
    const escapePath = `${OUTSIDE}/escape.txt`
    finding.fs01.outsideWrite = await callTool(ctx, agent, 1, 'write', {
      file_path: escapePath,
      content: 'written outside the session workspace by the write tool\n',
    })
    finding.fs01.outsideWriteSucceeded = finding.fs01.outsideWrite.isError === false
    finding.fs01.outsideFileExists = existsSync(escapePath)
    finding.fs01.outsideFileContent = existsSync(escapePath) ? readFileSync(escapePath, 'utf8') : null

    const contract = ctx.get('noSandboxContract')
    finding.fs01.contractPresent = contract !== undefined
    if (contract !== undefined) {
      // `report({ agent })` runs the deployment and surface halves. The SESSION
      // half is added when the Session object is reachable, because the
      // three-value distinction (`explicit > session override > default`) is the
      // part that catches a Session carrying a stale `workspace-write` override --
      // and a report missing it would read as green while a session was confined.
      const subject = session === undefined ? { agent } : { agent, session }
      const report = contract.report(subject)
      finding.fs01.contractReport = {
        ok: report.ok,
        violations: report.violations,
        checks: report.checks.map(c => ({ id: c.id, ok: c.ok, observed: c.observed, detail: c.detail })),
      }
      // The surface half, which is the same capability fact read a second way.
      try {
        finding.fs01.contractSurface = {
          toolNames: report.checks.some(c => c.id === 'surface.escalation-parameters') ? 'see contractReport' : null,
        }
      } catch { /* the surface half is optional; its absence is reported by the checks */ }
      const deployment = contract.observe()
      finding.fs01.disclosed = {
        // `fsSandboxMode === undefined` is the deployment's OWN statement that the
        // mounted backend does not confine -- read off the live service, not inferred.
        fsSandboxMode: deployment.fsSandboxMode ?? null,
        fsProvider: deployment.fsProvider ?? null,
        sandboxPolicyDefaultMode: deployment.defaultMode ?? null,
        modeSource: deployment.modeSource,
        shellSandboxMode: deployment.shellSandboxMode ?? null,
        shellProvider: deployment.shellProvider ?? null,
        shellMounted: deployment.shellMounted,
        ptcSandboxMode: deployment.ptcSandboxMode ?? null,
        ptcMounted: deployment.ptcMounted,
      }
      // The two values that must AGREE for the disclosure to be honest: the
      // deployment says "no confinement" (undefined) while the policy default
      // still says `workspace-write`. Recording both is the point -- see G-SEAM-33.
      finding.fs01.disclosureContradiction = {
        fsClaimsNoConfinement: deployment.fsSandboxMode === undefined,
        policyDefaultStillConfines: deployment.defaultMode !== undefined && deployment.defaultMode !== 'danger-full-access',
        policyDefault: deployment.defaultMode ?? null,
      }
    }
    // The lock's own trust-model statement, so the deployment's words are on the
    // record rather than paraphrased by this probe.
    try {
      const lock = JSON.parse(readFileSync(`${REPO}/compatibility.lock.json`, 'utf8'))
      finding.fs01.lockTrustModel = lock?.deployment?.trust_model ?? null
      finding.fs01.lockTrustModelStatement = lock?.deployment?.trust_model_statement ?? null
      finding.fs01.specExplicitlyNotClaimed = JSON.parse(
        readFileSync(`${REPO}/qualification/specs/acceptance-spec.trusted-local-v1.json`, 'utf8'),
      )?.trust_model?.explicitly_not_claimed ?? null
    } catch (error) {
      finding.fs01.lockError = String(error)
    }

    // ── FS-02: the read boundary, through BOTH routes ────────────────────────
    const outsideReadPath = `${OUTSIDE}/pre-existing-outside.txt`
    writeFileSync(outsideReadPath, 'pre-existing content outside the workspace\n', 'utf8')
    const outsideReadDigest = sha256File(outsideReadPath)
    finding.fs02 = { outsideReadPath, outsideReadDigest }
    finding.fs02.nativeRead = await callTool(ctx, agent, 2, 'read', { file_path: outsideReadPath })
    finding.fs02.nativeReadSucceeded = finding.fs02.nativeRead.isError === false
    // The PYTHON route: a real interpreter, the way a cell runs one.
    finding.fs02.pythonRead = runPython(
      `import pathlib,hashlib\n`
      + `p = pathlib.Path(${JSON.stringify(outsideReadPath.replace(/\\/g, '/'))})\n`
      + `b = p.read_bytes()\n`
      + `print(hashlib.sha256(b).hexdigest())\n`
      + `print(b.decode('utf-8'), end='')\n`,
    )
    finding.fs02.pythonReadDigest = finding.fs02.pythonRead.ok
      ? String(finding.fs02.pythonRead.stdout).split(/\r?\n/u)[0]
      : null
    // Both routes must reach the SAME BYTES, so "reads are not confined" is a
    // digest comparison rather than a claim about an error field.
    finding.fs02.bothRoutesReachedSameBytes = finding.fs02.pythonReadDigest === outsideReadDigest
    finding.fs02.readDisclosure = finding.fs01.disclosed ?? null

    // ── FS-03: ONE path string, FOUR routes, ONE file ────────────────────────
    // The oracle: all four resolve in the SAME execution world and reach the same
    // file. The path is written with a DIFFERENT spelling per route only where the
    // route forces it (a shell needs quoting, Python needs a literal), and the
    // BYTES are compared by digest so "same file" is not an inference from a
    // string that looks alike.
    const routeFile = `${WORKSPACE}/one-path.txt`
    const routeContent = 'V7-FS03-CANARY one path string four routes\n'
    writeFileSync(routeFile, routeContent, 'utf8')
    const routeDigest = sha256File(routeFile)
    finding.fs03 = { path: routeFile, expectedDigest: routeDigest, expectedBytes: Buffer.byteLength(routeContent) }

    // Route 1: the native `read` tool.
    finding.fs03.readTool = await callTool(ctx, agent, 3, 'read', { file_path: routeFile })
    finding.fs03.readToolSawCanary = finding.fs03.readTool.isError === false
      && finding.fs03.readTool.message.includes('V7-FS03-CANARY')

    // Route 2: the native `grep` tool.
    finding.fs03.grepTool = await callTool(ctx, agent, 4, 'grep', { pattern: 'V7-FS03-CANARY', path: WORKSPACE })
    finding.fs03.grepToolSawCanary = finding.fs03.grepTool.isError === false
      && finding.fs03.grepTool.message.includes('V7-FS03-CANARY')

    // Route 3: a SPAWNED PROCESS through the real mounted shell executor.
    finding.fs03.shell = { mounted: false, provider: null }
    const shell = ctx.get('shell')
    if (shell !== undefined) {
      finding.fs03.shell.mounted = true
      finding.fs03.shell.provider = shell.constructor?.name ?? null
      finding.fs03.shell.sandboxMode = shell.sandboxMode ?? null
      const spec = shell.resolve({
        command: `powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '${routeFile.replace(/\//g, '\\')}').Hash.ToLower()"`,
        workdir: WORKSPACE,
      })
      const run = await shell.run(spec)
      // `ShellRunResult.stdout` is a `CollectedOutput` -- `{ text, truncated,
      // spillPath? }` (`packages/subprocess/subprocess/src/types.ts:22-29`) --
      // NOT a string. The first version of this probe called `String(run.stdout)`
      // and measured `"[object Object]"`, which failed the digest comparison while
      // the shell had in fact answered correctly. A probe defect, not a product
      // one: the same class as T2's `FsError.code` mistake, and recorded here for
      // the same reason.
      const stdoutText = String(run.stdout?.text ?? '')
      finding.fs03.shellResult = {
        exitCode: run.exitCode,
        stdout: stdoutText.trim(),
        stdoutTruncated: run.stdout?.truncated ?? null,
        stderr: String(run.stderr?.text ?? '').trim().slice(0, 400),
        // Absent for an unsandboxed executor, which is itself a fact about FS-01.
        sandbox: run.sandbox ?? null,
      }
      finding.fs03.shellSawSameDigest = stdoutText.trim().toLowerCase() === routeDigest
    }

    // Route 4: a PYTHON cell.
    finding.fs03.python = runPython(
      `import pathlib,hashlib\n`
      + `p = pathlib.Path(${JSON.stringify(routeFile.replace(/\\/g, '/'))})\n`
      + `b = p.read_bytes()\n`
      + `print(hashlib.sha256(b).hexdigest())\n`
      + `print(p.resolve())\n`,
    )
    const pythonLines = finding.fs03.python.ok ? String(finding.fs03.python.stdout).split(/\r?\n/u) : []
    finding.fs03.pythonDigest = pythonLines[0] ?? null
    finding.fs03.pythonResolvedPath = pythonLines[1] ?? null
    finding.fs03.pythonSawSameDigest = finding.fs03.pythonDigest === routeDigest

    // The one-world half: the deployment's own record of which world this is.
    finding.fs03.executionWorld = ctx.get('dailyData')?.executionWorld ?? null
    finding.fs03.worldsSeen = {
      readTool: 'dsh fs service over the OS filesystem',
      grepTool: 'ripgrep child over the OS filesystem',
      shell: finding.fs03.shell.provider,
      python: 'python.exe child over the OS filesystem',
    }
    finding.fs03.allFourReachedSameFile = finding.fs03.readToolSawCanary
      && finding.fs03.grepToolSawCanary
      && finding.fs03.shellSawSameDigest === true
      && finding.fs03.pythonSawSameDigest === true

    // ── FS-04: link and rename, PER VECTOR, including non-refusals ───────────
    // The oracle requires each vector recorded SEPARATELY and a vector that is NOT
    // refused reported as a FINDING rather than folded into a green. It also
    // requires the correctness half in every case: no data corruption, and no
    // operation silently acting on a different file than the caller named.
    finding.fs04 = {}

    // Vector A: a SYMLINK pointing outside the workspace, then a write THROUGH it.
    const symlinkTarget = `${OUTSIDE}/symlink-target.txt`
    const symlinkPath = `${WORKSPACE}/escape-link.txt`
    writeFileSync(symlinkTarget, 'original content of the outside symlink target\n', 'utf8')
    finding.fs04.symlink = { target: symlinkTarget, link: symlinkPath }
    try {
      symlinkSync(symlinkTarget, symlinkPath, 'file')
      finding.fs04.symlink.created = true
      finding.fs04.symlink.createdVia = 'node:fs symlinkSync (a real OS symlink)'
    } catch (error) {
      finding.fs04.symlink.created = false
      finding.fs04.symlink.createError = String(error)
    }
    if (finding.fs04.symlink.created) {
      // READ FIRST, and this is not a formality. The observation policy refuses a
      // mutation of a file that has not been read -- MEASURED here on the first run
      // as `FS_NOT_OBSERVED: file has not been read`. Without this read the write
      // would be refused for a reason that has NOTHING to do with containment, and
      // the vector would be recorded as "REFUSED" while the containment question
      // was never put to the system. That is a false finding in the green
      // direction, which is worse than a missing one.
      finding.fs04.symlink.readFirst = await callTool(ctx, agent, 5, 'read', { file_path: symlinkPath })
      finding.fs04.symlink.writeThroughLink = await callTool(ctx, agent, 6, 'write', {
        file_path: symlinkPath,
        content: 'V7-FS04 written THROUGH the symlink\n',
      })
      // WHERE THE BYTES LANDED is the measurement: if the target changed, the
      // write followed the link out of the workspace.
      finding.fs04.symlink.targetAfterWrite = readFileSync(symlinkTarget, 'utf8')
      finding.fs04.symlink.linkStillASymlink = existsSync(symlinkPath)
        && (() => { try { return statSync(symlinkPath).isSymbolicLink() || readFileSync(symlinkPath, 'utf8') === finding.fs04.symlink.targetAfterWrite } catch { return false } })()
      finding.fs04.symlink.writeEscapedWorkspace = finding.fs04.symlink.targetAfterWrite.includes('V7-FS04')
      // The correctness half: the caller named the LINK and the bytes went to the
      // TARGET, which is what the OS does with a symlink -- so this is not
      // "silently acting on a different file", it is the documented OS semantic.
      finding.fs04.symlink.refused = finding.fs04.symlink.writeThroughLink.isError === true
      finding.fs04.symlink.verdict = finding.fs04.symlink.refused
        ? 'REFUSED'
        : 'NOT REFUSED -- FINDING: a symlink in the workspace escapes it; the write followed the link and mutated the target outside'
    }

    // Vector B: a HARDLINK from outside into the workspace, then a write through it.
    const hardlinkSource = `${OUTSIDE}/hardlink-source.txt`
    const hardlinkPath = `${WORKSPACE}/hardlink.txt`
    writeFileSync(hardlinkSource, 'original content of the outside hardlink source\n', 'utf8')
    finding.fs04.hardlink = { source: hardlinkSource, link: hardlinkPath }
    try {
      linkSync(hardlinkSource, hardlinkPath)
      finding.fs04.hardlink.created = true
    } catch (error) {
      finding.fs04.hardlink.created = false
      finding.fs04.hardlink.createError = String(error)
    }
    if (finding.fs04.hardlink.created) {
      // Read first, for the same MEASURED reason as the symlink vector above.
      finding.fs04.hardlink.readFirst = await callTool(ctx, agent, 7, 'read', { file_path: hardlinkPath })
      finding.fs04.hardlink.writeThroughLink = await callTool(ctx, agent, 8, 'write', {
        file_path: hardlinkPath,
        content: 'V7-FS04 written THROUGH the hardlink\n',
      })
      finding.fs04.hardlink.sourceAfterWrite = readFileSync(hardlinkSource, 'utf8')
      finding.fs04.hardlink.writeEscapedWorkspace = finding.fs04.hardlink.sourceAfterWrite.includes('V7-FS04')
      finding.fs04.hardlink.refused = finding.fs04.hardlink.writeThroughLink.isError === true
      finding.fs04.hardlink.verdict = finding.fs04.hardlink.refused
        ? 'REFUSED'
        : 'NOT REFUSED -- FINDING: a hardlink shares the inode, so a write inside the workspace mutates the outside file'
    }

    // Vector C: a CROSS-BOUNDARY RENAME, driven by raw Python the way a cell would.
    // This is the vector a write-only tool cannot see, and the oracle's correctness
    // half is the load-bearing part: no corruption, no surprise target.
    const renameSource = `${OUTSIDE}/rename-source.txt`
    const renameDest = `${WORKSPACE}/renamed-in.txt`
    writeFileSync(renameSource, 'V7-FS04 content moved by a cross-boundary rename\n', 'utf8')
    const renameDigestBefore = sha256File(renameSource)
    finding.fs04.rename = { source: renameSource, dest: renameDest, digestBefore: renameDigestBefore }
    const renameRun = runPython(
      `import os,pathlib\n`
      + `src = pathlib.Path(${JSON.stringify(renameSource.replace(/\\/g, '/'))})\n`
      + `dst = pathlib.Path(${JSON.stringify(renameDest.replace(/\\/g, '/'))})\n`
      + `os.rename(src, dst)\n`
      + `print('RENAMED')\n`,
    )
    finding.fs04.rename.pythonRun = renameRun
    finding.fs04.rename.sourceGone = !existsSync(renameSource)
    finding.fs04.rename.destExists = existsSync(renameDest)
    finding.fs04.rename.digestAfter = existsSync(renameDest) ? sha256File(renameDest) : null
    finding.fs04.rename.contentIntact = finding.fs04.rename.digestAfter === renameDigestBefore
    finding.fs04.rename.refused = finding.fs04.rename.sourceGone === false
    finding.fs04.rename.verdict = finding.fs04.rename.refused
      ? 'REFUSED'
      : 'NOT REFUSED -- FINDING: raw Python renames across the workspace boundary; content is INTACT (digest equal), so this is disclosure, not corruption'

    // The native `write` tool's view of the rename: does it refuse, or does it
    // silently write to a path whose identity changed under it?
    finding.fs04.rename.nativeReadAfter = await callTool(ctx, agent, 14, 'read', { file_path: renameDest })
    finding.fs04.rename.nativeReadSawMovedContent = finding.fs04.rename.nativeReadAfter.isError === false
      && finding.fs04.rename.nativeReadAfter.message.includes('V7-FS04 content moved')

    // ── FS-05: structured tool semantics ─────────────────────────────────────
    // read with offset+limit, an exact edit, and an AMBIGUOUS replacement that
    // must be refused rather than guessed.
    const bigFile = `${WORKSPACE}/big.txt`
    const lines = Array.from({ length: 400 }, (_u, i) => `line-${String(i + 1).padStart(3, '0')}`)
    writeFileSync(bigFile, `${lines.join('\n')}\n`, 'utf8')
    finding.fs05 = { bigFilePath: bigFile, totalLines: 400 }

    finding.fs05.windowedRead = await callTool(ctx, agent, 8, 'read', {
      file_path: bigFile,
      offset: 100,
      limit: 5,
    })
    finding.fs05.windowedReadIsError = finding.fs05.windowedRead.isError
    const windowText = finding.fs05.windowedRead.message
    // The window must be EXACTLY the requested lines: not the head, not the whole
    // file. Asserting on three specific line numbers is what makes it a window.
    finding.fs05.windowIsExact = windowText.includes('line-100')
      && windowText.includes('line-101')
      && windowText.includes('line-104')
      && !windowText.includes('line-099')
      && !windowText.includes('line-105')
      && !windowText.includes('line-001')
    finding.fs05.windowLineNumbersPresent = (windowText.match(/^\s*\d+:/gmu) ?? []).map(s => s.trim())

    // An exact, unique replacement.
    // READ FIRST: the observation policy refuses a mutation of a file it has not
    // observed -- MEASURED on the first run of this probe as
    // `FS_NOT_OBSERVED: file has not been read`. Without the read, BOTH the exact
    // edit and the absent-literal edit below return FS_NOT_OBSERVED, so the case
    // would report "refused" for the wrong reason and never reach the
    // `FS_EDIT_NOT_FOUND` branch it exists to check.
    const editFile = `${WORKSPACE}/edit-me.txt`
    writeFileSync(editFile, 'alpha beta gamma\n', 'utf8')
    finding.fs05.exactEditReadFirst = await callTool(ctx, agent, 9, 'read', { file_path: editFile })
    finding.fs05.exactEdit = await callTool(ctx, agent, 10, 'edit', {
      file_path: editFile,
      old_string: 'beta',
      new_string: 'BETA',
    })
    finding.fs05.exactEditApplied = finding.fs05.exactEdit.isError === false
    finding.fs05.exactEditContent = readFileSync(editFile, 'utf8')

    // An AMBIGUOUS replacement: `x` appears three times with replace_all unset.
    const ambiguousFile = `${WORKSPACE}/ambiguous.txt`
    writeFileSync(ambiguousFile, 'x x x\n', 'utf8')
    finding.fs05.ambiguousReadFirst = await callTool(ctx, agent, 11, 'read', { file_path: ambiguousFile })
    finding.fs05.ambiguousEdit = await callTool(ctx, agent, 12, 'edit', {
      file_path: ambiguousFile,
      old_string: 'x',
      new_string: 'y',
    })
    finding.fs05.ambiguousRefused = finding.fs05.ambiguousEdit.isError === true
    finding.fs05.ambiguousCode = finding.fs05.ambiguousEdit.code
    finding.fs05.ambiguousContentUnchanged = readFileSync(ambiguousFile, 'utf8') === 'x x x\n'

    // A literal that is absent is its own refusal. The file was read above, so the
    // observation policy is satisfied and the ONLY thing that can refuse this is
    // the literal-match check.
    finding.fs05.missingEdit = await callTool(ctx, agent, 13, 'edit', {
      file_path: editFile,
      old_string: 'THIS-LITERAL-APPEARS-NOWHERE',
      new_string: 'z',
    })
    finding.fs05.missingRefused = finding.fs05.missingEdit.isError === true
    finding.fs05.missingCode = finding.fs05.missingEdit.code
    finding.fs05.missingContentUnchanged = readFileSync(editFile, 'utf8') === 'alpha BETA gamma\n'

    // ── FS-06: workspace files vs store-owned artifacts ──────────────────────
    // The oracle: the record DISTINGUISHES workspace paths from store-owned
    // artifacts, and the store's object is UNAFFECTED by a workspace write of the
    // same name. The trap it names: assuming an artifact is immutable merely
    // because a cell can write a same-named path.
    finding.fs06 = {}
    const data = ctx.get('dailyData')
    finding.fs06.dataPlanePresent = data !== undefined
    if (data !== undefined) {
      finding.fs06.storeRoot = data.store.root
      finding.fs06.ownerScope = data.ownerScope
      finding.fs06.executionWorld = data.executionWorld
      finding.fs06.pageBytes = data.pageBytes
      finding.fs06.storeRootIsAbsolute = /^[A-Za-z]:[\\/]/u.test(String(data.store.root))
        || String(data.store.root).startsWith('/')
      // ── WHERE the store's object actually is, and this is a measured GAP ────
      // `defaultArtifactRoot` falls back to the RELATIVE literal `data-artifacts`
      // (`packages/dsh-daily-work/src/data-service.ts:400-406`), and the profile
      // sets no `artifactRoot` (DIFFERENCE 5 says so deliberately). A relative
      // root resolves against the HOST PROCESS's cwd, NOT the session workspace --
      // so the store and the workspace are two different trees that share a
      // relative name. That is precisely the conflation FS-06 asks about, so it is
      // measured rather than described, and the RESOLVED path is reported.
      const storeRootResolved = resolve(String(data.store.root))
      finding.fs06.storeRootResolved = storeRootResolved
      finding.fs06.storeRootResolvedAgainst = process.cwd()
      finding.fs06.storeRootIsRelative = !/^[A-Za-z]:[\\/]/u.test(String(data.store.root))
        && !String(data.store.root).startsWith('/')
      finding.fs06.storeRootDiffersFromWorkspace = storeRootResolved.replace(/\\/g, '/').toLowerCase()
        !== WORKSPACE.replace(/\\/g, '/').toLowerCase()
      finding.fs06.storeRootIsInsideWorkspace = storeRootResolved.replace(/\\/g, '/').toLowerCase()
        .startsWith(WORKSPACE.replace(/\\/g, '/').toLowerCase())

      // Publish a REAL object through the store, then attack it by name from the
      // workspace. The object's address IS its digest, so the conflation the case
      // warns about would show up as the store's bytes changing.
      const payload = 'V7-FS06 store-owned artifact payload -- this must survive a workspace write\n'
      const put = await attempt('store.put', async () => data.store.put([Buffer.from(payload, 'utf8')]))
      finding.fs06.put = put
      if (put.ok) {
        finding.fs06.artifact = put.value.artifact
        finding.fs06.artifactSha256 = put.value.sha256
        finding.fs06.artifactBytes = put.value.bytes
        finding.fs06.artifactDigestMatchesContent = put.value.sha256
          === createHash('sha256').update(payload).digest('hex')
        // The object's real path on disk, so the same-name attack has a target.
        // Built from the RESOLVED root, because the configured root is relative and
        // `join` on a relative root would name a path relative to the probe's own
        // process rather than the store's.
        const objectOnDisk = join(storeRootResolved, 'objects', put.value.sha256.slice(0, 2), put.value.sha256)
        finding.fs06.objectOnDisk = objectOnDisk
        finding.fs06.objectExistsOnDisk = existsSync(objectOnDisk)
        finding.fs06.objectIsOutsideWorkspace = !objectOnDisk.replace(/\\/g, '/').toLowerCase()
          .startsWith(WORKSPACE.replace(/\\/g, '/').toLowerCase())

        // (a) A workspace file with the SAME BASENAME as the artifact.
        const sameName = `${WORKSPACE}/${put.value.sha256}`
        writeFileSync(sameName, 'V7-FS06 workspace file impersonating the artifact\n', 'utf8')
        finding.fs06.sameNameWorkspaceFile = sameName
        finding.fs06.sameNameFileExists = existsSync(sameName)
        finding.fs06.storeStatAfterSameNameWrite = await attempt('store.stat', async () => data.store.stat(put.value.artifact))
        // The store's own verdict about its object, read AFTER the attack.
        finding.fs06.storeBytesUnchanged = finding.fs06.storeStatAfterSameNameWrite.ok
          && finding.fs06.storeStatAfterSameNameWrite.value?.sha256 === put.value.sha256
          && finding.fs06.storeStatAfterSameNameWrite.value?.bytes === put.value.bytes
        finding.fs06.objectOnDiskUnchanged = existsSync(objectOnDisk)
          && sha256File(objectOnDisk) === put.value.sha256

        // (b) The direct attack: write the store's object path through the native
        // tool. Under trusted-local this is EXPECTED to succeed -- there is no
        // confinement -- and the honest measurement is whether the STORE's own
        // read path still returns the original bytes or detects the damage.
        //
        // THE PATH IS PASSED RELATIVE, ON PURPOSE, because that is what exposes the
        // real finding: the store's root is the relative literal `data-artifacts`,
        // the store resolves it against the HOST PROCESS cwd, and the fs tool
        // resolves the SAME relative string against the SESSION cwd. So the two
        // components address two different trees with one name. Passing the
        // resolved absolute path would hide that; passing the relative one measures
        // it. Both are done, so the reader sees which file each component touched.
        finding.fs06.directObjectWriteRelative = await callTool(ctx, agent, 15, 'write', {
          file_path: `data-artifacts/objects/${put.value.sha256.slice(0, 2)}/${put.value.sha256}`,
          content: 'V7-FS06 TAMPERED store object\n',
        })
        finding.fs06.relativeWriteTargetAsSeenByTool = `${WORKSPACE}/data-artifacts/objects/${put.value.sha256.slice(0, 2)}/${put.value.sha256}`
        finding.fs06.relativeWriteHitTheStoreObject = existsSync(objectOnDisk)
          && readFileSync(objectOnDisk, 'utf8').includes('TAMPERED')
        // The divergence, stated as a boolean a reader can check.
        finding.fs06.sameRelativeNameTwoFiles = !finding.fs06.relativeWriteHitTheStoreObject
          && existsSync(`${WORKSPACE}/data-artifacts/objects/${put.value.sha256.slice(0, 2)}/${put.value.sha256}`)
        finding.fs06.storeObjectUntouchedByRelativeWrite = existsSync(objectOnDisk)
          && readFileSync(objectOnDisk, 'utf8') === payload

        // (c) The absolute attack: the store's REAL resolved path, through the tool.
        // READ FIRST, for the third time and the same MEASURED reason: the
        // observation policy refuses a mutation of a file it has not observed, so
        // without this the refusal would be `FS_NOT_OBSERVED` and the containment
        // question would never be put to the system.
        finding.fs06.objectReadFirst = await callTool(ctx, agent, 16, 'read', { file_path: objectOnDisk })
        finding.fs06.directObjectWrite = await callTool(ctx, agent, 17, 'write', {
          file_path: objectOnDisk,
          content: 'V7-FS06 TAMPERED store object\n',
        })
        finding.fs06.directObjectWriteSucceeded = finding.fs06.directObjectWrite.isError === false
        const tamperedOnDisk = existsSync(objectOnDisk) ? readFileSync(objectOnDisk, 'utf8') : null
        finding.fs06.objectOnDiskAfterDirectWrite = tamperedOnDisk
        finding.fs06.objectWasTampered = tamperedOnDisk !== null && tamperedOnDisk.includes('TAMPERED')
        // The store publishes its objects 0o400 (read-only), so on Windows the
        // refusal comes from the OS as `ReplaceFileW EACCES`, NOT from a DSH policy
        // decision. Recorded explicitly because it is the difference between "the
        // store is protected" and "the store is protected BY A PERMISSION BIT that
        // the same OS user can clear" -- and this deployment claims no confinement,
        // so the bit is the whole protection and must be named as such.
        finding.fs06.objectModeOnDisk = (() => {
          try {
            const mode = statSync(objectOnDisk).mode
            return { octal: (mode & 0o777).toString(8), writableByOwner: (mode & 0o200) !== 0 }
          } catch { return null }
        })()
        finding.fs06.refusalCameFromTheOS = /EACCES/u.test(String(finding.fs06.directObjectWrite.message ?? ''))
        // The counter-check that keeps the claim honest: the SAME user can clear
        // the read-only bit, so this is a guard against accident, not a boundary.
        //
        // AND THE TAMPERING IS NOT DETECTED ON THE READ PATH. `openRange` reads a
        // byte window and returns it -- its own source says the verification is
        // separate (`packages/dsh-daily-work/src/artifacts.ts:391`: "Verify the
        // whole object against its address. Explicit, so paging stays O(page)").
        // So a tampered object IS returned as content with NO error, and the first
        // version of this probe asserted the opposite in a CHECK LABEL while the
        // measured value said otherwise. The label was a false claim in the GREEN
        // direction -- the failure mode this spec exists to catch. The measurement
        // is the finding; the labels below now say what was measured.
        finding.fs06.sameUserCanClearTheBit = await attempt('clear read-only bit and write', async () => {
          const { chmodSync } = await import('node:fs')
          chmodSync(objectOnDisk, 0o600)
          writeFileSync(objectOnDisk, 'V7-FS06 TAMPERED store object\n', 'utf8')
          const nowTampered = readFileSync(objectOnDisk, 'utf8').includes('TAMPERED')
          // (1) the READ path, with no error thrown.
          let readThrew = null
          let storeSaw = null
          try {
            storeSaw = Buffer.from(await data.store.openRange(put.value.artifact, { offset: 0, length: 64 })).toString('utf8')
          } catch (error) {
            readThrew = `${error.name}: ${error.message}`
          }
          // (2) the EXPLICIT verifier, which is the thing that CAN tell.
          const verifySays = await data.store.verify(put.value.artifact)
          // (3) stat, whose reported sha256 is derived from the reference NAME
          // rather than recomputed, so it cannot detect this either.
          const statSays = await data.store.stat(put.value.artifact)
          // Restore the object so the store is left as it was found.
          writeFileSync(objectOnDisk, payload, 'utf8')
          chmodSync(objectOnDisk, 0o400)
          return {
            theBitCouldBeCleared: true,
            theObjectCouldBeOverwritten: nowTampered,
            // MEASURED: no error, and the bytes returned are the TAMPERED ones. So
            // the read path did NOT detect -- stated in the affirmative direction.
            readPathThrewAnError: readThrew !== null,
            whatTheReadPathReturned: storeSaw,
            readPathReturnedTamperedBytes: storeSaw !== null
              && storeSaw.includes('TAMPERED'),
            readPathDetectedTheTampering: readThrew !== null,
            // MEASURED: the explicit verifier DOES catch it.
            theExplicitVerifyDetectedTheTampering: verifySays === false,
            // MEASURED: stat reports the ORIGINAL digest beside the TAMPERED byte
            // count, so its two fields disagree and neither is a verification.
            whatStatReportedWhileTampered: statSays ?? null,
            statDigestMatchesItsOwnBytes: statSays !== null
              && statSays !== undefined
              && statSays.sha256 === createHash('sha256').update('V7-FS06 TAMPERED store object\n').digest('hex'),
            restored: readFileSync(objectOnDisk, 'utf8') === payload,
          }
        })
        // The store's own integrity answer, which is what a reader needs: did the
        // store NOTICE? `openRange` verifies, so a tampered object must not be
        // returned as clean content.
        finding.fs06.storeReadAfterTamper = await attempt('store.openRange', async () =>
          Buffer.from(await data.store.openRange(put.value.artifact, { offset: 0, length: 64 })).toString('utf8'))
        finding.fs06.reconcile = await attempt('store.reconcile', async () => data.reconcile())
      }
    }

    // ── the tool face, recorded so the family's claims are anchored ──────────
    const schemas = ctx.get('tools').schemas(agent)
    finding.toolFace = {
      count: schemas.length,
      names: schemas.map(s => s.name).sort(),
      ipythonPresent: schemas.some(s => s.name === 'ipython'),
      pwshPresent: schemas.some(s => s.name === 'pwsh'),
    }
    // The escalation fields are advertised ONLY under a confining backend
    // (`packages/fs/tool-fs/src/sandbox.ts:44-45`), so their absence is a second
    // independent read of the same capability fact as FS-01.
    const propsOf = toolName => Object.keys(schemas.find(s => s.name === toolName)?.parameters?.properties ?? {})
    finding.escalationFieldsAdvertised = {
      write: propsOf('write').filter(k => k === 'sandbox_permissions' || k === 'justification'),
      edit: propsOf('edit').filter(k => k === 'sandbox_permissions' || k === 'justification'),
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(finding, null, 2), 'utf8')
  process.stdout.write(`VERIFY-V7-FS: ${JSON.stringify({ out: OUT, home: finding.dshHome, error: finding.error })}\n`)
}
