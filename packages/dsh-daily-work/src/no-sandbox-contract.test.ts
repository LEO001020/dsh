/**
 * The no-sandbox contract guard: what it catches, and what it does not.
 *
 * THE DECISION THIS FILE GUARDS
 * =============================
 * This deployment runs DSH with NO sandbox on Windows, deliberately:
 * `danger-full-access`, no WSL, no bubblewrap, the OS user account as the
 * execution authority boundary. The records are
 * `docs/decisions/2026-09-20-sandbox-removal-plan.md`,
 * `2026-09-20-windows-nosandbox-rebuild.md` and
 * `2026-09-20-six-gate-impact-explained.md`.
 *
 * The decision is only real if a REVERSION is loud. `sandbox-policy` is a
 * service seven entries `inject`, so the failure mode is not "the sandbox comes
 * back" — it is "someone restores a row and the deployment silently confines
 * again", or the mirror image, "someone deletes the row and the whole tool face
 * goes to zero while the process still starts" (MEASURED: 7 entries pending,
 * `toolCount: 0`; `AUDIT-REQUEST-nosandbox.md` fact F). Both directions look
 * healthy from outside.
 *
 * HOW THIS FILE PROVES THE GUARD HAS TEETH
 * =========================================
 * Two halves, and the split is the point:
 *
 *   1. DECISION POWER, by measurement on synthetic graphs. Every case feeds the
 *      guard a graph that represents a REVERTED deployment and asserts the guard
 *      REFUSES. A guard that always said `ok` would pass a "the graph is fine"
 *      assertion for a broken graph; asserting the refusal is what makes the
 *      detector's power observable. The control arm — a healthy graph reports
 *      `ok: true` — is included, because without it a guard that always failed
 *      would look equally "working".
 *
 *   2. COMPOSITION, by reading the REAL profile and preset files. The decision
 *      lives in YAML rows (a disabled `fs-sandbox`, an inserted `fs-local`, and
 *      so on), not in TypeScript. A live-graph check cannot see a row that has
 *      been deleted but is currently masked by another; the row scan can.
 *
 * WHAT THIS FILE DOES NOT CLAIM
 * =============================
 * It does not prove the deployment is unconfined. It proves the guard REFUSES
 * the graphs that would mean confinement, and that the composition still
 * declares the intended rows. The one claim the deployment does NOT currently
 * satisfy — `sandboxPolicy.defaultMode` is `workspace-write`, not the
 * `danger-full-access` the architecture claims — is asserted at full strength
 * and marked as an explicit expected failure naming the defect. See
 * `qualification/results/T5-contract/FINDINGS.md`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ESCALATION_PARAMETERS,
  NoSandboxContractService,
  TRUSTED_LOCAL_MODE,
  deploymentChecks,
  inject,
  startupPolicyChecks,
  surfaceChecks,
  type DeploymentObservation,
  type SurfaceObservation,
} from './no-sandbox-contract.ts'

/** The repository root, from this file's location (`packages/dsh-daily-work/src`). */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** Read a text file with CRLF normalised, so a platform line ending is not a finding. */
function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** The daily candidate profile and the preset that carries its tool rows. */
const PROFILE_PATCH = join(REPO_ROOT, 'profiles', 'daily-candidate', 'cordis.patch.yml')
const DAILY_PRESET = join(REPO_ROOT, 'profiles', 'daily-candidate', 'presets', 'daily-standard', 'agent.cordis.yml')
/** This package's own bundle patch, which is what travels WITH the code. */
const OWN_BUNDLE_PATCH = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'cordis.patch.yml')
/** This package's manifest, where the export the row resolves through is declared. */
const OWN_MANIFEST = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'package.json')
/** The shipped bundle the profile patches; the sandbox rows originate here. */
const BASE_BUNDLE = join('D:', 'DSH', 'src', 'dsh-src', 'packages', 'bundle', 'base', 'cordis.patch.yml')
/** `ui-permission` is a web-app row, NOT a base row — see the composition case. */
const WEB_APP_BUNDLE = join('D:', 'DSH', 'src', 'dsh-src', 'packages', 'bundle', 'web-app', 'cordis.patch.yml')

/**
 * Extract one YAML row by its `id`, as the row's own indented block.
 *
 * A focused reader rather than a YAML parse, and deliberately so: these files
 * are hand-written with prose comments and the package has no YAML dependency.
 * The subset read here is `- id: <name>` followed by the lines indented DEEPER
 * than it, which is exactly a row's own keys.
 *
 * The indent rule is the whole helper, and it is strict on purpose. A looser
 * "until the next top-level `- `" rule would let a row's block run on through
 * the following prose and the NEXT row's comments, so an assertion like
 * "this block contains `@deepseek-ai/dsh-fs-local`" could be satisfied by a
 * sentence in a comment after the row was deleted. Stopping at the first
 * non-blank line that is not deeper-indented cannot do that.
 *
 * @param text - the file's text.
 * @param id - the row id to extract.
 * @returns the row block, or `undefined` when no such row exists.
 */
function rowBlock(text: string, id: string): string | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === `- id: ${id}`)
  if (start < 0) return undefined
  const indentOf = (line: string): number => line.length - line.trimStart().length
  const ownIndent = indentOf(lines[start]!)
  const block: string[] = []
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!
    // The first non-blank line that is not deeper-indented than the row itself
    // ends it: a sibling row, a top-level comment, or `- insert:` at the same
    // level. Blank lines are kept, since YAML rows are separated by them.
    if (index > start && line.trim() !== '' && indentOf(line) <= ownIndent) break
    block.push(line)
  }
  return block.join('\n')
}

/** A deployment observation representing the INTENDED trusted-local graph. */
function healthyDeployment(overrides: Partial<DeploymentObservation> = {}): DeploymentObservation {
  return {
    defaultMode: TRUSTED_LOCAL_MODE,
    // The shipped row restates `workspaceRoot: !!js process.cwd()`
    // (`profiles/daily-candidate/cordis.patch.yml`), so the intended graph's
    // root is an absolute path. A synthetic one is used here because this
    // factory describes the INTENDED graph rather than one boot: what the
    // startup check asserts is absoluteness, not a particular directory.
    workspaceRoot: 'D:\\DSH\\work\\dsh-native-daily',
    modeSource: 'unobservable',
    // `undefined` is the local backend's base getter: it does not confine.
    fsSandboxMode: undefined,
    fsProvider: 'LocalFileSystem',
    shellSandboxMode: undefined,
    shellProvider: 'PwshLocalExecutor',
    shellMounted: true,
    ptcSandboxMode: undefined,
    ptcMounted: false,
    ipythonMounted: true,
    sshMounted: false,
    sshSubprocessMounted: false,
    wslMounted: false,
    ...overrides,
  }
}

/** A model surface representing the INTENDED daily surface. */
function healthySurface(overrides: Partial<SurfaceObservation> = {}): SurfaceObservation {
  return {
    toolNames: ['edit', 'ipython', 'read', 'write'],
    escalationTools: [],
    pwshPresent: false,
    ipythonPresent: true,
    ipythonParameters: ['code'],
    ptcTransportPresent: false,
    ...overrides,
  }
}

/** The failing check ids of a report, for assertions that name what was caught. */
function failures(checks: readonly { id: string; ok: boolean }[]): string[] {
  return checks.filter(check => !check.ok).map(check => check.id)
}

// ---------------------------------------------------------------------------
// The control arm — a healthy graph must be reported healthy
// ---------------------------------------------------------------------------

describe('the guard does not cry wolf: the intended graph reports ok', () => {
  it('every deployment-level check passes on the graph the architecture describes', () => {
    // WITHOUT THIS CASE the detection cases below would be worthless: a guard
    // that returned `ok: false` unconditionally would pass all of them. This is
    // the same control-arm discipline the VER-09 CAS case uses.
    const checks = deploymentChecks(healthyDeployment())
    expect(failures(checks)).toEqual([])
  })

  it('every surface check passes on the intended daily surface', () => {
    const checks = surfaceChecks(healthySurface())
    expect(failures(checks)).toEqual([])
  })

  it('a MISSING tool registry is a violation, not an empty catalog', () => {
    // G-FIX-06's exact false negative: "no registry" was reported as "the model
    // has no tools". The guard must distinguish them, so `undefined` is a FAIL.
    const checks = surfaceChecks(undefined)
    expect(failures(checks)).toEqual(['surface.registry'])
  })
})

// ---------------------------------------------------------------------------
// Detection power — each reverted graph must be REFUSED
// ---------------------------------------------------------------------------

describe('the guard refuses a silently reverted deployment', () => {
  it('a confining filesystem backend is caught, and the provider is named', () => {
    // The sharpest reversion: `fs-sandbox` restored in place of `fs-local`. The
    // service name is unchanged (`ctx.fs`), so nothing downstream notices, and
    // the ONLY visible symptom is `sandboxMode` becoming defined again.
    const checks = deploymentChecks(healthyDeployment({
      fsSandboxMode: 'workspace-write',
      fsProvider: 'SandboxedFileSystem',
    }))
    expect(failures(checks)).toEqual(['fs.provider'])
    // The report names what it SAW, not only that it failed, so an operator can
    // act without re-running a probe.
    const check = checks.find(candidate => candidate.id === 'fs.provider')!
    expect(check.observed).toContain('SandboxedFileSystem')
    expect(check.observed).toContain('workspace-write')
  })

  it('a confining shell executor is caught', () => {
    const checks = deploymentChecks(healthyDeployment({
      shellSandboxMode: 'workspace-write',
      shellProvider: 'SandboxPwshExecutor',
    }))
    expect(failures(checks)).toEqual(['shell.provider'])
  })

  it('a missing shell is NOT a violation: only a mounted one that confines is', () => {
    // The asymmetry is deliberate and worth pinning. This deployment ships no
    // model-facing `pwsh`, so an absent shell is the intended state; treating
    // absence as failure would make the guard fail on a correct deployment.
    expect(failures(deploymentChecks(healthyDeployment({ shellMounted: false, shellProvider: undefined }))))
      .toEqual([])
  })

  it('the deployment default falling back to a confined mode is caught', () => {
    // The direction that matters most: `read-only` is Config's SCHEMA DEFAULT, so
    // this is what an unconfigured deployment looks like. The guard cannot tell
    // it from an explicit `read-only` (recorded as an honest gap) and says so in
    // the detail rather than guessing.
    const checks = deploymentChecks(healthyDeployment({ defaultMode: 'read-only' }))
    expect(failures(checks)).toEqual(['sandboxPolicy.defaultMode'])
    const check = checks.find(candidate => candidate.id === 'sandboxPolicy.defaultMode')!
    expect(check.observed).toBe("'read-only'")
    expect(check.detail).toContain('CONFINES')
  })

  it('an absent sandbox policy is caught AND tied to the tool-face-zeroing cascade', () => {
    // The measured silent-degradation mode. Deleting the row does not confine
    // anything — it makes seven entries pending, which zeroes the model's tool
    // face while the process still starts. The detail must carry that, because
    // "no policy service" reads like a harmless absence.
    const checks = deploymentChecks(healthyDeployment({ defaultMode: undefined }))
    expect(failures(checks)).toEqual(['sandboxPolicy.defaultMode'])
    const check = checks.find(candidate => candidate.id === 'sandboxPolicy.defaultMode')!
    expect(check.detail).toContain('toolCount 0')
  })

  it('an SSH execution world reappearing is caught, in either of its two shapes', () => {
    // Two worlds with different filesystem identities is the confusion DEP-04
    // exists to prevent; trusted-local has exactly one world.
    expect(failures(deploymentChecks(healthyDeployment({ sshMounted: true })))).toEqual(['ssh.absent'])
    expect(failures(deploymentChecks(healthyDeployment({ sshSubprocessMounted: true })))).toEqual(['ssh.absent'])
  })

  it('a WSL dependency reappearing is caught', () => {
    expect(failures(deploymentChecks(healthyDeployment({ wslMounted: true })))).toEqual(['wsl.absent'])
  })

  it('the IPython kernel service disappearing is caught', () => {
    // IPython is the PRIMARY execution surface here, so its absence removes the
    // deployment's main capability rather than one tool among many.
    expect(failures(deploymentChecks(healthyDeployment({ ipythonMounted: false })))).toEqual(['ipython.present'])
  })

  it('a mounted PTC runtime that confines is caught', () => {
    // PTC leaving the daily surface is the intended end state, so absence passes;
    // a mounted PTC that resolves to a confined mode does not.
    expect(failures(deploymentChecks(healthyDeployment({ ptcMounted: true, ptcSandboxMode: 'workspace-write' }))))
      .toEqual(['ptcRuntime.sandboxMode'])
    expect(failures(deploymentChecks(healthyDeployment({ ptcMounted: true, ptcSandboxMode: TRUSTED_LOCAL_MODE }))))
      .toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The STARTUP boundary: the policy row on its own, before anything else mounts
//
// WHY THIS BLOCK EXISTS. `startupPolicyChecks` is a SECOND check set, not a
// subset of `deploymentChecks`: `checkBoundarySync` selects it for the `startup`
// boundary, which fires when `sandboxPolicy` mounts — earlier than `fs`, `shell`
// and `ipython`, where the full contract measured a half-mounted graph and
// reported three failures for a CORRECT deployment.
//
// That makes it the set a real boot actually runs first, and it had NO test arm:
// the cases above all go through `deploymentChecks`, so a regression inside
// `startupPolicyChecks` — including deleting a check — would have been invisible
// to this suite. These cases are the detection arms that were missing.
// ---------------------------------------------------------------------------

describe('the startup boundary checks the policy row, and only what is knowable then', () => {
  it('the intended policy row passes, on the same observation the full contract accepts', () => {
    // The control arm, for the same reason as the one above: without it, a check
    // set that returned `ok: false` unconditionally would pass every case below.
    expect(failures(startupPolicyChecks(healthyDeployment()))).toEqual([])
  })

  it('it is a DIFFERENT set from the full contract, not a renamed copy', () => {
    // If these two were the same set, the startup boundary would re-report the
    // half-mounted graph and the false alarm it was introduced to fix would come
    // back. Pinned by ids rather than by length so the difference is legible: the
    // startup set carries the policy facts, and none of the backend facts.
    const startup = startupPolicyChecks(healthyDeployment()).map(check => check.id)
    const deployment = deploymentChecks(healthyDeployment()).map(check => check.id)
    expect(startup).toEqual([
      'startup.sandboxPolicy.present',
      'startup.sandboxPolicy.mode',
      'startup.sandboxPolicy.workspaceRoot',
    ])
    for (const id of startup) expect(deployment, `${id} must not be in the full set too`).not.toContain(id)
    // And the backend facts it must NOT claim, because they are not knowable yet.
    expect(startup).not.toContain('fs.provider')
    expect(startup).not.toContain('ipython.present')
  })

  it('an ABSENT policy row is caught here, which is the tool-face-zeroing precondition', () => {
    const checks = startupPolicyChecks(healthyDeployment({ defaultMode: undefined, workspaceRoot: undefined }))
    expect(failures(checks)).toEqual([
      'startup.sandboxPolicy.present',
      'startup.sandboxPolicy.mode',
      'startup.sandboxPolicy.workspaceRoot',
    ])
    // The report names the cascade rather than only the absence, so an operator
    // reading a refused boot learns why seven rows went pending.
    const present = checks.find(check => check.id === 'startup.sandboxPolicy.present')!
    expect(present.observed).toContain('NOT mounted')
    expect(present.detail).toContain('tool face to zero')
  })

  it('a policy row that CONFINES is caught at startup, before anything runs under it', () => {
    // This is the F3 shape: the row exists and resolves, but to the wrong mode.
    // Catching it at startup is the point of the boundary — the deployment stops
    // before a model-facing sentence claims an authority the deployment lacks.
    const checks = startupPolicyChecks(healthyDeployment({ defaultMode: 'workspace-write' }))
    expect(failures(checks)).toEqual(['startup.sandboxPolicy.mode'])
    const mode = checks.find(check => check.id === 'startup.sandboxPolicy.mode')!
    expect(mode.observed).toBe("'workspace-write'")
    expect(mode.detail).toContain('FALSE STATEMENT ABOUT THE MODEL\'S PERMISSIONS')
  })

  it('a NON-ABSOLUTE workspace root is caught, and an absolute one in either spelling is not', () => {
    // CMP-02's oracle names the absolute root explicitly, and the service throws
    // for a relative one (`sandbox-policy/src/index.ts:36-39`) — so a relative
    // value arriving here means it was produced some other way. The predicate is
    // structural rather than `path.isAbsolute` on purpose, so both Windows
    // spellings and a POSIX root are accepted; a platform-dependent predicate
    // would make one composed value pass or fail depending on which OS read it.
    expect(failures(startupPolicyChecks(healthyDeployment({ workspaceRoot: 'relative/root' }))))
      .toEqual(['startup.sandboxPolicy.workspaceRoot'])
    expect(failures(startupPolicyChecks(healthyDeployment({ workspaceRoot: 'D:/DSH/work' })))).toEqual([])
    expect(failures(startupPolicyChecks(healthyDeployment({ workspaceRoot: 'D:\\DSH\\work' })))).toEqual([])
    expect(failures(startupPolicyChecks(healthyDeployment({ workspaceRoot: '/home/dsh' })))).toEqual([])
  })

  it('the service routes the startup boundary to THIS set, so the arms above are reachable', () => {
    // Without this case the checks could be correct and unreachable — the defect
    // class this project keeps finding. `checkBoundarySync` is the only caller,
    // so its selection is read from source rather than assumed.
    const source = readText(join(import.meta.dirname, 'no-sandbox-contract.ts'))
    expect(source).toContain("boundary === 'startup'")
    expect(source).toContain('? startupPolicyChecks(observed)')
    expect(source).toContain(': deploymentChecks(observed)')
  })
})

describe('the guard refuses a reverted model surface', () => {
  it('the escalation parameters reappearing on any tool is caught, per tool', () => {
    // THE INVISIBLE ONE. `dsh-tool-fs` gates `sandbox_permissions`/`justification`
    // on whether the mounted BACKEND confines (`tool-fs/src/sandbox.ts:44-45`), a
    // property of the provider rather than of the mode's value. So a deployment
    // that sets `danger-full-access` and believes it is unconfined still hands
    // the model these fields, and NOTHING in the resolved graph shows it.
    const checks = surfaceChecks(healthySurface({
      escalationTools: [
        { name: 'write', parameters: [...ESCALATION_PARAMETERS] },
        { name: 'edit', parameters: [...ESCALATION_PARAMETERS] },
      ],
    }))
    expect(failures(checks)).toEqual(['surface.escalation-parameters'])
    const check = checks.find(candidate => candidate.id === 'surface.escalation-parameters')!
    expect(check.observed).toContain('write ->')
    expect(check.observed).toContain('edit ->')
  })

  it('a model-facing pwsh tool is caught', () => {
    expect(failures(surfaceChecks(healthySurface({ pwshPresent: true }))))
      .toEqual(['surface.pwsh-absent'])
  })

  it('a second ipython parameter is caught: the contract is EXACTLY `code`', () => {
    // A second parameter means the model gained a control the host is supposed to
    // own (kernel lifecycle, output cap, timeout). The guard checks the
    // ADVERTISED schema, which is where such a control would appear.
    expect(failures(surfaceChecks(healthySurface({ ipythonParameters: ['code', 'timeoutMs'] }))))
      .toEqual(['surface.ipython-present'])
    expect(failures(surfaceChecks(healthySurface({ ipythonParameters: [] }))))
      .toEqual(['surface.ipython-present'])
  })

  it('the PTC `run_code` transport reappearing is caught', () => {
    // While it is present the PTC collapse is live, so the catalog the model sees
    // is not the catalog it can call by name.
    expect(failures(surfaceChecks(healthySurface({ ptcTransportPresent: true }))))
      .toEqual(['surface.ptc-transport-absent'])
  })
})

// ---------------------------------------------------------------------------
// The service shape — a read-only reporter, and it must not hard-inject
// ---------------------------------------------------------------------------

describe('the guard is a read-only reporter and declares no hard inject', () => {
  it('the plugin declares an EMPTY inject, and that is load-bearing', () => {
    // `inject` is a READINESS GATE: a plugin whose inject names a service that
    // never activates stays `pending` forever. This guard's subject is a graph
    // where services are LEGITIMATELY absent (`ssh`, `sandbox`, and `ptcRuntime`
    // once PTC leaves the daily), so a hard inject would leave the guard blind to
    // exactly the states it exists to report. Pinned as an assertion so a later
    // "tidy-up" that adds an inject is a visible change.
    expect(inject).toEqual([])
  })

  it('the service reads a live graph and reports without throwing', async () => {
    // A degraded graph is what the guard is FOR, so `report()` must return a
    // report rather than throw — a throw would replace a readable report with one
    // stack trace. This context mounts nothing, so every service is absent and
    // the report must say so instead of crashing.
    const ctx = new Context()
    try {
      const service = new NoSandboxContractService(ctx)
      const result = service.report()
      expect(result.ok).toBe(false)
      // `ctx.sandboxPolicy` is genuinely not mounted here, so the deployment half
      // reports the absence it observed.
      expect(result.violations).toContain('sandboxPolicy.defaultMode')
      // And `assert()` is the fail-loudly entry point a boot-time check calls.
      expect(() => { service.assert() }).toThrow(/no-sandbox contract violated/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Composition — the REAL files must still declare the decision
// ---------------------------------------------------------------------------

describe('the composed profile still declares the no-sandbox decision', () => {
  it('the sandboxed filesystem and shell providers are disabled, and the local ones inserted', () => {
    // The mechanism a patch dialect offers: a row cannot be renamed, so the
    // shipped row is disabled and its replacement inserted. Both halves are
    // asserted — a disabled `fs-sandbox` with NO `fs-local` would leave `ctx.fs`
    // unpublished, which cascades to the tool face going to zero.
    const profile = readText(PROFILE_PATCH)
    for (const id of ['fs-sandbox', 'pwsh-sandbox']) {
      const block = rowBlock(profile, id)
      expect(block, `${id} must still be named in the profile`).toBeDefined()
      expect(block, `${id} must stay disabled`).toContain('disabled: true')
    }
    for (const [id, name] of [
      ['fs-local', '@deepseek-ai/dsh-fs-local'],
      ['pwsh-local', '@deepseek-ai/dsh-pwsh-local'],
    ] as const) {
      const block = rowBlock(profile, id)
      expect(block, `${id} must still be inserted`).toBeDefined()
      expect(block, `${id} must name its provider`).toContain(name)
    }
  })

  it('the permission control plane stays off and the approval policy stays `never`', () => {
    // `permission-presets` THROWS in its constructor when `ctx.shell.sandboxMode`
    // is undefined, so it cannot coexist with an unconfined executor; and the
    // shipped approval policy is computed from `DSH_PERMISSION_MODE`, which is
    // unset on this machine and therefore evaluates to `ask`. Both must be
    // pinned, or the deployment's stated stance is a value nobody chose.
    const profile = readText(PROFILE_PATCH)
    for (const id of ['permission', 'ui-permission']) {
      expect(rowBlock(profile, id), `${id} must stay disabled`).toContain('disabled: true')
    }
    const approval = rowBlock(profile, 'approval')
    expect(approval, 'the approval row must stay mounted with an explicit policy').toBeDefined()
    expect(approval).toContain('policy: never')
  })

  it('the model-facing shell tool stays off in the daily preset', () => {
    // IPython is the model's only execution surface on this deployment; `tool-pwsh`
    // is unconditionally disabled in the preset. An unconditional `disabled: true`
    // is asserted rather than the shipped `process.platform !== 'win32'`
    // expression, because the platform expression would re-enable it on POSIX.
    const preset = readText(DAILY_PRESET)
    const pwsh = rowBlock(preset, 'tool-pwsh')
    expect(pwsh, 'tool-pwsh must still be named in the preset').toBeDefined()
    expect(pwsh).toContain('disabled: true')
    expect(pwsh, 'the platform-conditional form would re-enable it on POSIX')
      .not.toContain('process.platform')
    // And the IPython tool row must remain, since it replaces the shell.
    expect(rowBlock(preset, 'ipython-tool')).toContain('dsh-ipython/tool')
  })

  it('the shipped bundles still originate the sandbox rows, so the profile is patching something real', () => {
    // WHY THIS CASE EXISTS: the profile's `- id: fs-sandbox` / `- id: pwsh-sandbox`
    // / `- id: permission` / `- id: ui-permission` patches are matched BY ID
    // against the shipped bundle rows. If an upstream rename or a bundle change
    // removes the row, the patch silently does nothing (`applyEntryPatches` skips
    // a row it cannot find) and the deployment reverts WITHOUT the profile file
    // changing at all. That is a reversion this test can catch and a live-graph
    // check cannot attribute.
    //
    // EACH ROW IS CHECKED IN ITS OWN BUNDLE, which is a fact worth pinning rather
    // than a detail: `ui-permission` is NOT in `base` — it is a `web-app` row.
    // Asserting the whole set against `base` would have failed, and "the profile
    // patches a row that no bundle owns" is the defect this case exists to catch,
    // so the attribution has to be right for the assertion to mean anything.
    const origins = [
      [BASE_BUNDLE, ['fs-sandbox', 'pwsh-sandbox', 'permission', 'approval', 'sandbox-policy']],
      [WEB_APP_BUNDLE, ['ui-permission']],
    ] as const
    for (const [path, ids] of origins) {
      const bundle = readText(path)
      for (const id of ids) {
        expect(rowBlock(bundle, id), `${id} must still exist in ${path} for the profile to patch`).toBeDefined()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The guard must be REACHABLE, not merely correct — Gap 1 closed permanently
// ---------------------------------------------------------------------------

describe('the guard has a production entry point, so a profile can actually mount it', () => {
  it('the package EXPORTS the guard, and the export points at built output', () => {
    // WHY THIS CASE EXISTS, and it was the guard's own most serious gap. The
    // module was correct and compiled, but nothing could reach it: no `exports`
    // entry and no patch row, so no profile would ever load it. That is the same
    // defect class this project has retracted four times (a launch port with no
    // production caller, a continuation taker with none, a package with no
    // `dsh.bundle`, and `worktree-isolation.ts` before its plugin existed).
    // A guard that only a test can reach is not a guard.
    //
    // A test that mounts the module DIRECTLY proves the module works and proves
    // nothing about whether a profile uses it — so this case asserts the three
    // links in order instead: the export, the file it names, and the row that
    // resolves through it.
    const manifest = JSON.parse(readFileSync(OWN_MANIFEST, 'utf8')) as {
      exports: Record<string, { types: string; default: string }>
    }
    const entry = manifest.exports['./no-sandbox-contract']
    expect(entry, 'the guard must be an exported subpath').toBeDefined()
    // Built output, not `src`: a `src` target would ship TypeScript where a
    // consumer expects a module, and would bind the public surface to the layout.
    expect(entry!.default).toBe('./lib/no-sandbox-contract.js')
    expect(entry!.types).toBe('./lib/no-sandbox-contract.d.ts')
    // And the files must EXIST, because an export naming a missing file fails at
    // import — the defect this project records as G-FIX-04.
    for (const target of [entry!.default, entry!.types]) {
      expect(existsSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', target)), `${target} must exist`).toBe(true)
    }
  })

  it('the bundle patch inserts the row, and it is ACTIVE rather than disabled', () => {
    // The row is what a profile resolver actually loads, so it is the link that
    // turns "the module is correct" into "the deployment runs it".
    //
    // THE ID IS `daily-no-sandbox-contract` IN THE FILE AND
    // `include:daily-no-sandbox-contract` IN THE LOADER, and the difference is
    // load-bearing rather than cosmetic. The loader PREFIXES inserted rows with
    // `include:` (`packages/boot/plugin-manager`, and measured on a real boot in
    // `qualification/results/ROOT-verification/contract-mounted.json`, whose
    // `rowsMatchingNoSandbox[0].id` is `include:daily-no-sandbox-contract`). A
    // probe filtering on the bare id, or on the `name` field — which is `null` on
    // the loaded row — reports a false absence. Both spellings are therefore
    // asserted here, so the naming is pinned rather than rediscovered.
    const bundle = readText(OWN_BUNDLE_PATCH)
    const row = rowBlock(bundle, 'daily-no-sandbox-contract')
    expect(row, 'the bundle must insert the guard row').toBeDefined()
    expect(row).toContain('dsh-daily-work/no-sandbox-contract')
    // ACTIVE: a `disabled: true` row would be inert, and the guard would be back
    // to being unreachable while every other assertion here still passed.
    expect(row).not.toContain('disabled: true')
  })

  it('the guard is mounted WITHOUT a hard inject, which is what made it safe to add', () => {
    // A row that hard-injected a service the composed graph cannot satisfy would
    // stay `pending` forever, and a pending row is what produced this project's
    // measured `toolCount: 0` failure. The guard reads every service through
    // `ctx.get`, so it cannot introduce a pending fiber — and this is the
    // property that made wiring it a zero-risk change. Asserted rather than
    // trusted, since a later edit adding an inject would be a silent regression
    // of exactly that property.
    expect(inject).toEqual([])
    // And the row must not add an inject of its own, which would have the same
    // effect from the composition side.
    expect(rowBlock(readText(OWN_BUNDLE_PATCH), 'daily-no-sandbox-contract')).not.toContain('inject')
  })
})

// ---------------------------------------------------------------------------
// The defect that WAS here — closed, and the marker removed
// ---------------------------------------------------------------------------

describe('G-SEAM-33: the profile declares the trusted-local mode', () => {
  it('the profile pins the sandbox mode to the trusted-local value the architecture claims', () => {
    // THIS CASE WAS `it.fails` AND IS NOW A PASSING ASSERTION, which is the
    // self-clearing behaviour its own comment predicted. It was written as an
    // expected failure while the profile had no `sandbox-policy` row, so the
    // shipped bundle's `mode: !!js process.env.DSH_PERMISSION_MODE ??
    // 'workspace-write'` (`packages/bundle/base/cordis.patch.yml:218`) stood and
    // the deployment resolved to a CONFINING mode. The marker existed so the
    // claim stayed at FULL STRENGTH without the guard certifying the defect.
    //
    // The row now exists, so the marker is REMOVED rather than left in place: an
    // `it.fails` that unexpectedly passes is reported by vitest as a FAILURE, and
    // that is what forced this edit — the mechanism worked exactly as documented.
    // Leaving the marker would have made a correct deployment red.
    //
    // WHAT THIS CASE DOES AND DOES NOT ESTABLISH. It is a FILE-LEVEL assertion:
    // the composed profile declares `mode: danger-full-access`. It does NOT
    // establish that the running deployment resolves to it — that is what the
    // boot-measured pair does (`qualification/results/R1-trusted-local/
    // composition-before.json` vs `composition-after.json`, and the explicit
    // loudness verdicts `loudness-verdict.json` / `loudness-after-fix.json`).
    const profile = readText(PROFILE_PATCH)
    const policy = rowBlock(profile, 'sandbox-policy')
    expect(policy, 'the profile must declare the sandbox mode the architecture claims').toBeDefined()
    expect(policy).toContain(`mode: ${TRUSTED_LOCAL_MODE}`)
    // BOTH KEYS, because a patch REPLACES the target row's whole `config` object.
    // Stating only `mode` would drop `workspaceRoot`, whose schema has no default,
    // and the row would fail validation — the trap this project has already been
    // bitten by once (the `subagent` comment on DIFFERENCE 1 records it).
    // Asserted WITH the colon, so this matches the YAML key rather than any
    // sentence that happens to name it -- and so a row restating only `mode` fails
    // here rather than at boot-time validation.
    expect(policy, 'workspaceRoot has no schema default; omitting it fails validation')
      .toContain('workspaceRoot:')
  })
})

// ---------------------------------------------------------------------------
// The wiring defect found while finishing this slice — pinned so it cannot return
// ---------------------------------------------------------------------------

describe('the startup boundary is LOUD, and that is a wiring property', () => {
  it('`apply` is async and runs the startup check in its OWN body', () => {
    // THE DEFECT THIS PINS, and it is the worst kind this project has: the guard
    // reproduced the silent degradation it exists to catch.
    //
    // The startup boundary was written as `ctx.inject(['sandboxPolicy'], cb)` with
    // the returned fiber DISCARDED. `ctx.inject` creates a CHILD fiber, and DSH's
    // activation audit classifies by the ENTRY's fiber state
    // (`packages/boot/app-boot/src/index.ts:769-802`). A throw inside a DISCARDED
    // child leaves the entry ACTIVE, so the refusal reached NO process channel.
    // MEASURED on a real boot with no probe in the tree: the reverted
    // (`workspace-write`) deployment produced the SAME EMPTY STDERR as the healthy
    // control (`qualification/results/R1-trusted-local/loudness-verdict.json`,
    // whose `diagnosis` reads "SILENT").
    //
    // The fix is structural: the check runs in `apply`'s own async body, so its
    // rejection belongs to the ENTRY. This case asserts the SHAPE, because the
    // shape is the whole fix and a future "tidy-up" that moves the check back
    // into a discarded child fiber would silently restore the defect while every
    // behavioural assertion above still passed.
    const source = readText(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'no-sandbox-contract.ts'))
    expect(source, 'apply must be async so its rejection fails the entry').toMatch(/export async function apply\(ctx: Context\): Promise<void>/u)
    expect(source, 'the startup check must run in apply, not in a discarded child fiber')
      .toMatch(/service\.checkBoundarySync\('startup'\)/u)
    // And the plugin's static inject must STILL be empty: naming `sandboxPolicy`
    // there would leave this row pending on exactly the degraded graph it exists
    // to report. Both halves matter — the loud wiring must not have been bought
    // with a readiness gate.
    expect(inject).toEqual([])
  })

  it('the wait for `sandboxPolicy` is BOUNDED, because an unsettled apply suppresses every diagnostic', () => {
    // WHY THE BOUND IS LOAD-BEARING. `EntryTree.getTasks()` includes an entry's
    // in-flight apply promise and `loader.await()` loops on those tasks
    // (`vendor/loader/src/config/tree.ts:43-51`), so an `apply` that never
    // resolves stops `boot()` from ever reaching `auditStartupEntries`. MEASURED:
    // an arm that awaited a never-mounting service printed NOTHING on either
    // stream and never bound its web port, suppressing the activation audit for
    // every sibling entry too. A timeout instead lets the check run and report the
    // absent service, which is the honest outcome.
    const source = readText(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'no-sandbox-contract.ts'))
    expect(source).toMatch(/STARTUP_POLICY_WAIT_MS/u)
    expect(source, 'the wait must be bounded by a deadline, not unbounded').toMatch(/Date\.now\(\) < deadline/u)
  })
})
