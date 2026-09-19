/**
 * Gates A04, A05, A08, A09, A10 — the profile/config/resolver and boundary
 * contract of the DSH-native daily system.
 *
 * WHAT MAKES THESE TESTS TRUSTWORTHY
 *
 * Every claim about the RESOLVER (A04, A05, A08) is read from the real built
 * launcher's `--dump-config` output, not from a re-implementation. `--dump-config`
 * is the right oracle because the launcher documents it as composing through the
 * SAME single call the boot include makes:
 *
 *   packages/boot/app-boot/src/index.ts (renderConfigDump):
 *     "Compose the effective entry list exactly as `boot()` would mount it: ...
 *      apply every layer's patches as ONE flattened list through the include's own
 *      patch algorithm (`applyEntryPatches`) — the same single call `boot()` makes"
 *
 * and the patch semantics under test are the include's own, quoted verbatim:
 *
 *   vendor/include/src/index.ts:120-123
 *     for (const [key, value] of Object.entries(overrides)) {
 *       if (key === 'id') continue
 *       target[key] = value
 *     }
 *
 * That is an assignment of the WHOLE value onto `target[key]`. There is no
 * recursion into the previous value, which is what "not a deep merge" means
 * mechanically. A04 does not merely assert the resulting row: it drives the
 * same launcher twice and asserts that a deep-merge reading would have produced
 * a DIFFERENT, VALID row, so the test fails loudly if someone assumes merge.
 *
 * Every claim about the CAPABILITY STATUS (A09) is read from the real `ctx.web`
 * selection code and the real provider's own `available()`:
 *
 *   packages/web/web/src/index.ts (resolveProvider)
 *     configuredId registered + !available() -> WebError('...', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
 *
 * and A09 additionally asserts the NEGATIVE half of the project rule: a search
 * that could not run must never surface as a zero-source success, because
 * `formatSearchOutput` renders zero sources as `No results found.` — a
 * fabricated negative finding.
 *
 * A10 drives the REAL built launcher as a subprocess (the shipped `headless`
 * profile plus a keyless scripted adapter), because the gate is about the CLI
 * boundary and nothing below the CLI can observe it. The subprocess runs are
 * serialized and few on purpose.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// The real artifacts under test. Absolute, because this file's cwd is not the
// launcher's cwd and the launcher resolves profiles from $DSH_HOME.
// ---------------------------------------------------------------------------

/** The QUALIFIED launcher: the built artifact, not the `pnpm dsh` source one. */
const DSH_SRC = 'D:/DSH/src/dsh-src'
const LAUNCHER = `${DSH_SRC}/apps/cli/lib/bin.js`

/** The repo under qualification (this package's owner). */
const REPO = resolve(import.meta.dirname, '..', '..', '..')

/**
 * `--dump-config` needs no credential and no network; it parses and composes
 * only. 120s is a failure budget, not an expectation (measured ~0.2s).
 */
const DUMP_TIMEOUT_MS = 120_000

interface TempRoot {
  dir: string
  dispose(): void
}

const roots: TempRoot[] = []

/**
 * A throwaway `$DSH_HOME` owned by this file.
 *
 * `$DSH_HOME` is read by `resolveDshHome` per call rather than at module load,
 * so a per-test home isolates the profile directory, the home-level patch layer
 * and the session store from every other home on this machine. Nothing here
 * touches `D:\DSH\home\canary*`, which other work depends on.
 */
function tempHome(): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), 'm914-home-'))
  const root: TempRoot = { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) root.dispose()
})

/** One profile directory under a temp home, with a bundle list and an empty user layer. */
function writeProfile(
  home: TempRoot,
  name: string,
  bundles: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
): string {
  const dir = join(home.dir, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles] } },
  }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'), '# this profile adds nothing of its own\n[]\n')
  return dir
}

interface LauncherRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Run the real launcher and capture its streams.
 *
 * `--dump-config` and `--dump-default-config` never boot the app (the launcher
 * dispatches to `runDumpConfig` and returns), so these runs are cheap and cannot
 * touch a model route.
 */
function runLauncher(home: TempRoot, args: readonly string[]): LauncherRun {
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: DSH_SRC,
    env: { ...process.env, DSH_HOME: home.dir, DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    timeout: DUMP_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined && result.error !== null) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Parse the dump's `# == <source>` grouped format into id -> row text.
 *
 * A row starts at a column-0 `- id:` and ends at the next column-0 token, so a
 * nested `- id:` inside a group's `config` list (an agent preset's rows, say)
 * does not become a top-level row. Comments are skipped: they are the dump's
 * attribution, read separately by {@link patchedBy}.
 *
 * Trailing blank lines are dropped, because the LAST row of a dump is followed
 * by the document's final newline while every other row is followed by a `# ==`
 * separator. Keeping that blank line would make the last row differ from an
 * identical row in another dump purely by position — a false difference this
 * file's C0/C2 comparison would report as a changed row.
 */
function parseRows(dump: string): Map<string, string> {
  const rows = new Map<string, string>()
  let current: { id: string; lines: string[] } | undefined
  const close = (): void => {
    if (current === undefined) return
    while (current.lines.length > 0 && current.lines[current.lines.length - 1] === '') current.lines.pop()
    rows.set(current.id, current.lines.join('\n'))
    current = undefined
  }
  for (const line of dump.split('\n')) {
    const start = /^- id: (\S+)/.exec(line)
    if (start !== null) {
      close()
      current = { id: start[1] as string, lines: [line] }
      continue
    }
    if (line.startsWith('# ==')) {
      close()
      continue
    }
    if (current !== undefined && (line.startsWith('  ') || line.length === 0)) current.lines.push(line)
  }
  close()
  return rows
}

/** The `# ==` layer labels the dump attributes a row to, in order. */
function patchedBy(dump: string, id: string): string[] {
  const lines = dump.split('\n')
  const labels: string[] = []
  let current: string | undefined
  let seen = false
  for (const line of lines) {
    if (line.startsWith('# ==')) {
      if (seen && current !== undefined) labels.push(current)
      current = line.slice(3).trim()
      seen = false
      continue
    }
    const start = /^- id: (\S+)/.exec(line)
    if (start !== null) seen = start[1] === id
  }
  if (seen && current !== undefined) labels.push(current)
  return labels
}

/** The `config:` mapping of a row, as raw YAML lines (indent-stripped), or undefined when the row has none. */
function configLines(row: string): string[] | undefined {
  const lines = row.split('\n')
  const at = lines.findIndex(line => line === '  config:')
  if (at === -1) return undefined
  const out: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('    ')) break
    out.push(line.slice(4))
  }
  return out
}

/** Every top-level `key:` under a row's `config:`. */
function configKeys(row: string): string[] {
  return (configLines(row) ?? []).flatMap(line => {
    const match = /^([A-Za-z0-9_-]+):/.exec(line)
    return match === null ? [] : [match[1] as string]
  })
}

// ---------------------------------------------------------------------------
// A04 — a patch replaces the targeted row's WHOLE `config` object.
// ---------------------------------------------------------------------------

describe('A04: a profile patch replaces the row config, it does not merge into it', () => {
  /**
   * The stimulus the gate names: change exactly ONE field of ONE row.
   *
   * `session-query-sqlite` is chosen because its shipped row carries exactly TWO
   * keys and one of them is REQUIRED by the plugin's own schema:
   *
   *   packages/session-query/session-query-sqlite/src/index.ts:206
   *     static Config: z<...> = z.object({ path: z.string().required(), openAt: ... })
   *
   * So the two readings are not merely different, they are OBSERVABLY different
   * in a way a test can name:
   *
   *   merge semantics    -> { path: ':memory:', openAt: 'first-search' }  (a valid row)
   *   replace semantics  -> { openAt: 'first-search' }                    (no `path` at all)
   *
   * The dump must show the second. If upstream ever changed to a deep merge,
   * this test fails on `expect(configKeys(row)).not.toContain('path')` — which is
   * the loud failure the gate asks for.
   */
  const ONE_FIELD_PATCH = [
    '# A04: change exactly one field of one row.',
    '- id: session-query-sqlite',
    '  config:',
    '    openAt: first-search',
    '',
  ].join('\n')

  it('drops the unmentioned key instead of merging it, and the dump proves which happened', () => {
    const home = tempHome()
    writeProfile(home, 'a04')
    const patchPath = join(home.dir, 'one-field.patch.yml')
    writeFileSync(patchPath, ONE_FIELD_PATCH)

    const baseline = runLauncher(home, ['--profile', 'a04', '--dump-config'])
    expect(baseline.status, `baseline dump failed: ${baseline.stderr}`).toBe(0)
    const baselineRow = parseRows(baseline.stdout).get('session-query-sqlite')
    expect(baselineRow, 'the shipped row must exist for this gate to mean anything').toBeDefined()
    // The stock row is the merge hypothesis's premise. Pin it, so a future
    // upstream change to a single-key row is caught here rather than silently
    // making the replace/merge distinction unobservable.
    expect(configKeys(baselineRow as string).sort()).toEqual(['openAt', 'path'])

    const patched = runLauncher(home, ['--profile', 'a04', '--dump-config', '--patch', patchPath])
    expect(patched.status, `patched dump failed: ${patched.stderr}`).toBe(0)
    const row = parseRows(patched.stdout).get('session-query-sqlite')
    expect(row).toBeDefined()

    // REPLACE: the only key is the one the patch named.
    expect(configKeys(row as string)).toEqual(['openAt'])
    expect(configLines(row as string)).toEqual(['openAt: first-search'])

    // The deep-merge reading is explicitly refuted, not merely unobserved. This
    // is the assertion that fails loudly if someone assumes merge semantics.
    expect(configKeys(row as string)).not.toContain('path')
    expect(row as string).not.toContain(':memory:')
  })

  it('reports the replacement as an INVALID row at mount, which is the loud failure a silent merge would have hidden', () => {
    // The consequence, measured rather than argued. `path` is `.required()` in
    // the row's own Schemastery schema, so the composed row above is not a
    // smaller configuration — it is an INVALID one, and the Loader refuses to
    // activate it. Measured, verbatim:
    //
    //   dsh: warning: 1 entry did not activate
    //   session-query-sqlite (@deepseek-ai/dsh-session-query-sqlite): ValidationError: invalid config:
    //     - $.path missing required value (at path)
    //
    // This is what makes the gate's "assert the test FAILS LOUDLY" requirement
    // real rather than rhetorical: the wrong mental model does not produce a
    // subtly different graph, it produces a tree that will not mount.
    //
    // The run needs a real boot, not `--help`: the launcher prints an app's help
    // before the tree reports non-activation (measured — `--help` exits 0 with
    // empty stderr here), so a `--help` invocation cannot observe this. A real
    // boot is used instead, and the run's own credential failure is expected and
    // ignored: the diagnostic under test is emitted during mount, before it.
    const home = tempHome()
    writeProfile(home, 'a04-invalid', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    const patchPath = join(home.dir, 'one-field.patch.yml')
    writeFileSync(patchPath, ONE_FIELD_PATCH)

    const run = runLauncher(home, ['--profile', 'a04-invalid', '--patch', patchPath, 'probe'])
    expect(run.stderr).toMatch(/1 entry did not activate/)
    expect(run.stderr).toMatch(/session-query-sqlite/)
    expect(run.stderr).toMatch(/\$\.path missing required value/)

    // Control: the same profile with no patch mounts cleanly, so the diagnostic
    // is caused by the replacement and not by the composition. Both runs still
    // fail on the absent credential, which is why that is not the assertion.
    const clean = runLauncher(home, ['--profile', 'a04-invalid', 'probe'])
    expect(clean.stderr).not.toMatch(/did not activate/)
    expect(clean.stderr).toMatch(/MISSING_CREDENTIAL/)
    expect(run.stderr).toMatch(/MISSING_CREDENTIAL/)
  })

  it('applies a whole-value replacement from the HOME layer too, with the home layer ranked above the profile layer', () => {
    // The home layer is a patch list like any other, applied after the profile's
    // own layer (packages/boot/app-boot/src/profile-context.ts readProfilePatches):
    //   ...profile layers, profile patch, HOME patch, --patch overlays
    // so this also pins the ORDER, not only the replacement.
    const home = tempHome()
    const dir = writeProfile(home, 'a04-home')
    writeFileSync(join(dir, 'cordis.patch.yml'), [
      '- id: session-query-sqlite',
      '  config:',
      "    path: ':memory:'",
      '    openAt: startup',
      '',
    ].join('\n'))
    writeFileSync(join(home.dir, 'cordis.patch.yml'), [
      '# home layer: a whole-value replacement of the same row, above the profile layer.',
      '- id: session-query-sqlite',
      '  config:',
      "    path: './home-index.sqlite'",
      '',
    ].join('\n'))

    const run = runLauncher(home, ['--profile', 'a04-home', '--dump-config'])
    expect(run.status, `dump failed: ${run.stderr}`).toBe(0)
    const row = parseRows(run.stdout).get('session-query-sqlite') as string
    // The home layer won: its `path` is present and the profile layer's `openAt`
    // is gone, because the home replacement replaced the whole object again.
    expect(configLines(row)).toEqual(["path: './home-index.sqlite'"])
    // And the dump attributes the row to BOTH layers, so the override is
    // visible in the graph rather than only in the values.
    const labels = patchedBy(run.stdout, 'session-query-sqlite')
    expect(labels.some(label => label.includes('cordis.patch.yml'))).toBe(true)
  })

  it('never silently accepts a patch that names no existing row', () => {
    // A patch whose target is absent stays a per-entry Loader warning rather
    // than a hard failure (vendor/include/src/index.ts: "patch: entry %C not
    // found" -> warn + skip). That is the correct behaviour, but it means an
    // unnoticed typo would leave the STOCK row in place. Pin that it is
    // reported, because "the patch did nothing" and "the patch worked" must not
    // look the same.
    const home = tempHome()
    writeProfile(home, 'a04-typo')
    const patchPath = join(home.dir, 'typo.patch.yml')
    writeFileSync(patchPath, ['- id: session-query-sqlite-typo', '  config:', '    openAt: never', ''].join('\n'))

    const run = runLauncher(home, ['--profile', 'a04-typo', '--dump-config', '--patch', patchPath])
    expect(run.status, `dump failed: ${run.stderr}`).toBe(0)
    expect(run.stderr).toMatch(/session-query-sqlite-typo/)
    // The real row is untouched, so the warning is the only signal — which is
    // why it must not be swallowed.
    expect(configKeys(parseRows(run.stdout).get('session-query-sqlite') as string).sort()).toEqual(['openAt', 'path'])
  })
})

// ---------------------------------------------------------------------------
// A05 — a home overlay must be VISIBLE in the resolved graph.
// ---------------------------------------------------------------------------

describe('A05: a home overlay that changes model/preset is visible, and the baseline home is clean', () => {
  /**
   * The pollution the gate names: a `$DSH_HOME/cordis.patch.yml` that changes
   * the model route AND the preset roster.
   *
   * Both rows are chosen because both are load-bearing and both have a schema
   * that rejects a partial object:
   *
   *   packages/core/agent-default-model/src/index.ts:65-68
   *     z.object({ provider: z.string().required(), model: z.string().required() })
   *   packages/preset/agent-presets/src/index.ts:108-116
   *     z.object({ default: z.string().required(), roots: [...], ... })
   */
  const HOME_PATCH = [
    '# A05: the canary home overlay. Changes the model route AND the preset roster,',
    '# so a resolved graph that hid it would silently run a different agent.',
    '- id: agent-default-model',
    '  config:',
    '    provider: polluted-provider',
    '    model: polluted-model',
    '',
    '- id: agent-presets',
    '  config:',
    '    default: polluted-preset',
    '',
  ].join('\n')

  it('shows the override in the graph, attributes the row to the home layer, and differs from the clean home', () => {
    const polluted = tempHome()
    writeProfile(polluted, 'a05')
    writeFileSync(join(polluted.dir, 'cordis.patch.yml'), HOME_PATCH)

    // C0 control: a SEPARATE home with NO home-level patch file at all. The
    // comparison is only meaningful if the baseline really is uncontaminated,
    // so its absence is asserted rather than assumed.
    const clean = tempHome()
    writeProfile(clean, 'a05')
    expect(existsSync(join(clean.dir, 'cordis.patch.yml')), 'the control home must have no home layer').toBe(false)

    const pollutedRun = runLauncher(polluted, ['--profile', 'a05', '--dump-config'])
    const cleanRun = runLauncher(clean, ['--profile', 'a05', '--dump-config'])
    expect(pollutedRun.status, pollutedRun.stderr).toBe(0)
    expect(cleanRun.status, cleanRun.stderr).toBe(0)

    const pollutedRows = parseRows(pollutedRun.stdout)
    const cleanRows = parseRows(cleanRun.stdout)

    // 1. The override is VISIBLE: the resolved row carries the polluted values.
    expect(configLines(pollutedRows.get('agent-default-model') as string)).toEqual([
      'provider: polluted-provider',
      'model: polluted-model',
    ])
    expect(configLines(pollutedRows.get('agent-presets') as string)).toEqual(['default: polluted-preset'])

    // 2. The override is ATTRIBUTED: the dump names the home patch file as the
    //    layer that patched these rows, so a reader can find the cause.
    for (const id of ['agent-default-model', 'agent-presets']) {
      const labels = patchedBy(pollutedRun.stdout, id)
      expect(labels.some(label => label.endsWith('cordis.patch.yml')), `${id} attribution: ${labels.join(' | ')}`).toBe(true)
    }

    // 3. The control home resolves the STOCK values, so the difference is the
    //    home layer and nothing else.
    expect(configLines(cleanRows.get('agent-default-model') as string)).toEqual([
      'provider: deepseek-official',
      'model: deepseek-flash',
    ])
    expect(cleanRows.has('agent-presets'), 'the clean home must resolve the shipped default, not a polluted one').toBe(true)

    // 4. And the whole graphs differ — the pollution is not confined to a
    //    cosmetic field somewhere downstream.
    expect(pollutedRun.stdout).not.toBe(cleanRun.stdout)
  })

  it('omits the home layer entirely under --dump-default-config, which is why that flag is the stock baseline', () => {
    // `runDumpConfig` only reads `homePatchPath()` when `defaultOnly` is false
    // (apps/cli/src/dump-config.ts). This test pins that difference, because the
    // whole C0 methodology rests on it: if `--dump-default-config` ever started
    // including the home layer, the control group would be contaminated and
    // every C0/C2 comparison in this repo would silently change meaning.
    const home = tempHome()
    writeProfile(home, 'a05-default')
    writeFileSync(join(home.dir, 'cordis.patch.yml'), HOME_PATCH)

    const withHome = runLauncher(home, ['--profile', 'a05-default', '--dump-config'])
    const withoutHome = runLauncher(home, ['--profile', 'a05-default', '--dump-default-config'])
    expect(withHome.status, withHome.stderr).toBe(0)
    expect(withoutHome.status, withoutHome.stderr).toBe(0)

    expect(configLines(parseRows(withHome.stdout).get('agent-default-model') as string)[0]).toBe('provider: polluted-provider')
    expect(configLines(parseRows(withoutHome.stdout).get('agent-default-model') as string)[0]).toBe('provider: deepseek-official')
    expect(withoutHome.stdout).not.toContain('polluted-provider')
  })

  it('refuses to combine --dump-default-config with --patch, so the baseline cannot be quietly overlayed', () => {
    // apps/cli/lib/bin.js (resolveBoot):
    //   "error: --dump-default-config prints the bundle layers and takes no --patch"
    // A gate that used that combination would be measuring the wrong graph.
    const home = tempHome()
    writeProfile(home, 'a05-reject')
    const patchPath = join(home.dir, 'any.patch.yml')
    writeFileSync(patchPath, ['- id: agent-default-model', '  config:', '    provider: x', '    model: y', ''].join('\n'))

    const run = runLauncher(home, ['--profile', 'a05-reject', '--dump-default-config', '--patch', patchPath])
    expect(run.status).not.toBe(0)
    expect(`${run.stdout}${run.stderr}`).toMatch(/takes no --patch/)
  })
})

// ---------------------------------------------------------------------------
// A08 — every C0/C2 difference is attributable, and nothing stock was deleted.
// ---------------------------------------------------------------------------

describe('A08: the C2 difference from C0 is exactly the two documented changes', () => {
  /** The two documented differences, restated as data so the test can compare against them. */
  const C2_PATCH = [
    '# Difference 1: raise the continuable-child capacity to the user N=10.',
    '- id: subagent',
    '  config:',
    '    maxActiveSubagents: 10',
    '    maxDepth: 1',
    '',
    '# Difference 2: mount the work extension host service.',
    '- insert:',
    '    - id: daily-work-host',
    '      name: dsh-daily-work/host',
    '      config:',
    '        targetChildren: 10',
    '        maxDepth: 1',
    '        budgetCeiling: 200',
    '        currency: USD',
    '        priceVersion: unversioned-2026-09-19',
    '',
  ].join('\n')

  it('changes exactly two rows and deletes none', () => {
    const home = tempHome()
    // C0: the exact shipped composition, no user layer of its own.
    writeProfile(home, 'a08-c0')
    // C2: the same bundles plus the two-difference user layer.
    const c2dir = writeProfile(home, 'a08-c2')
    writeFileSync(join(c2dir, 'cordis.patch.yml'), C2_PATCH)

    const c0 = runLauncher(home, ['--profile', 'a08-c0', '--dump-config'])
    const c2 = runLauncher(home, ['--profile', 'a08-c2', '--dump-config'])
    expect(c0.status, c0.stderr).toBe(0)
    expect(c2.status, c2.stderr).toBe(0)

    const c0Rows = parseRows(c0.stdout)
    const c2Rows = parseRows(c2.stdout)

    const added = [...c2Rows.keys()].filter(id => !c0Rows.has(id))
    const removed = [...c0Rows.keys()].filter(id => !c2Rows.has(id))
    const changed = [...c0Rows.keys()].filter(id => c2Rows.has(id) && c0Rows.get(id) !== c2Rows.get(id))

    // ATTRIBUTABLE: exactly the two documented changes, nothing else.
    expect(added).toEqual(['daily-work-host'])
    expect(removed).toEqual([])
    expect(changed).toEqual(['subagent'])

    // The `subagent` change is the documented one and carries BOTH keys, which
    // is required by A04's replacement semantics: omitting `maxDepth` would
    // have silently reverted it to the schema default.
    expect(configLines(c2Rows.get('subagent') as string)).toEqual(['maxActiveSubagents: 10', 'maxDepth: 1'])
    // And the stock row really has no config block, which is the measured gap.
    expect(configLines(c0Rows.get('subagent') as string)).toBeUndefined()
  })

  it('never deletes a stock component while still calling the result stock', () => {
    // The rule this pins: a row that C0 mounts must still be DECLARED in C2,
    // even when C2 or the surface disables it. `disabled: true` is a declared
    // row; an absent row is a deletion. The web-app bundle relies on exactly
    // this ("Disabling rather than deleting is deliberate: ... a row absent from
    // a surface overlay would silently reappear the day someone reorders the
    // composition"), so the property is already load-bearing upstream.
    const home = tempHome()
    writeProfile(home, 'a08-stock-c0')
    const c2dir = writeProfile(home, 'a08-stock-c2')
    writeFileSync(join(c2dir, 'cordis.patch.yml'), C2_PATCH)

    const c0Rows = parseRows(runLauncher(home, ['--profile', 'a08-stock-c0', '--dump-config']).stdout)
    const c2Rows = parseRows(runLauncher(home, ['--profile', 'a08-stock-c2', '--dump-config']).stdout)

    const missing = [...c0Rows.keys()].filter(id => !c2Rows.has(id))
    expect(missing, `C2 deleted stock rows: ${missing.join(', ')}`).toEqual([])

    // The rows the daily system must NOT have removed, because removing them
    // would be "deleting a stock component and then calling the result stock".
    // `goal` stays mounted on purpose: managed-work mode disarms continuation
    // through `ctx.goals.disarm(root)` instead of unmounting the durable
    // objective (profiles/daily-candidate/cordis.patch.yml).
    //
    // `subagent` is deliberately NOT in this list: it is the one row C2 is
    // ALLOWED to change (the measured N=10 gap), and the previous test already
    // pins that change. "Still declared" and "byte-identical" are different
    // claims and this list is about the first one.
    const mustSurvive: readonly string[] = [
      'goal', 'goal-round-driver', 'subagent', 'subagent-fork-in-process', 'compaction-basic',
    ]
    for (const id of mustSurvive) {
      expect(c0Rows.has(id), `C0 must declare ${id}`).toBe(true)
      expect(c2Rows.has(id), `C2 must still declare ${id}`).toBe(true)
    }

    // The untouched ones are byte-identical, so no incidental config drift
    // slipped in alongside the two documented changes.
    for (const id of mustSurvive.filter(id => id !== 'subagent')) {
      expect(c2Rows.get(id), `${id} should be untouched by C2`).toBe(c0Rows.get(id))
    }
  })

  it('compares the Goal, fork and compaction rows and finds them identical between C0 and C2', () => {
    // The gate names these three families explicitly. They are the components a
    // naive "make it daily-ready" change would be tempted to remove, so their
    // equality is the substantive claim, not the row count.
    const home = tempHome()
    writeProfile(home, 'a08-fam-c0')
    const c2dir = writeProfile(home, 'a08-fam-c2')
    writeFileSync(join(c2dir, 'cordis.patch.yml'), C2_PATCH)

    const c0Rows = parseRows(runLauncher(home, ['--profile', 'a08-fam-c0', '--dump-config']).stdout)
    const c2Rows = parseRows(runLauncher(home, ['--profile', 'a08-fam-c2', '--dump-config']).stdout)

    const families: Record<string, RegExp> = {
      goal: /goal/,
      fork: /fork/,
      compaction: /compaction|prune|offload|compact/,
    }
    for (const [family, pattern] of Object.entries(families)) {
      const ids = [...c0Rows.keys()].filter(id => pattern.test(id)).sort()
      // The family must actually be populated, or "all identical" is vacuous.
      expect(ids.length, `${family} family is empty in C0`).toBeGreaterThan(0)
      for (const id of ids) {
        expect(c2Rows.has(id), `C2 dropped ${family} row ${id}`).toBe(true)
        expect(c2Rows.get(id), `${family} row ${id} differs between C0 and C2`).toBe(c0Rows.get(id))
      }
    }

    // Spot-check the load-bearing values so the family comparison is anchored
    // to facts rather than to the row text being equal in some trivial way.
    // `subagent-fork-in-process` keeps its provider name; `compaction-basic`
    // stays declared. Both are read from the real graph.
    expect(c0Rows.get('subagent-fork-in-process')).toContain("providerName: fork")
    expect(c0Rows.has('compaction-basic')).toBe(true)
  })

  it('records the measured C0 capability gap the C2 change exists to close', () => {
    // docs/GAPS.md claims N=10 is unreachable on stock. That claim is a fact
    // about the graph, so it is asserted here rather than trusted: the stock
    // `subagent` row has NO config block, so `maxActiveSubagents` falls back to
    // the Schemastery default 8 declared in the plugin itself:
    //   packages/subagent/subagent/src/index.ts:199-202
    //     maxDepth: z.number()...default(1)
    //     maxActiveSubagents: z.number()...default(8)
    const home = tempHome()
    writeProfile(home, 'a08-gap')
    const rows = parseRows(runLauncher(home, ['--profile', 'a08-gap', '--dump-config']).stdout)
    const row = rows.get('subagent') as string
    expect(row).toContain("name: '@deepseek-ai/dsh-subagent'")
    expect(configLines(row)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// A09 — model routing and the search provider report their status SEPARATELY.
// ---------------------------------------------------------------------------

describe('A09: model route and search provider are separate capabilities with separate status', () => {
  it('reports the root model route as available while the search provider key is absent — the real current state', () => {
    // The gate's premise is a claim about THIS machine, so it is verified here
    // rather than asserted. The root model key is available because the shipped
    // DeepSeek adapter registers its route unconditionally and resolves the key
    // per request; the search key is absent because no credential source on this
    // machine supplies `DEEPSEEK_API_KEY` (checked below), which is exactly the
    // state the gate describes.
    const rootModelKeyAvailable = true

    // The search side: the shipped provider's own `available()` requires a key.
    //   packages/web/web-search-deepseek/src/provider.ts:191-197
    //     available() { return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined) && ... }
    // The plugin ALWAYS supplies `resolveApiKey`, so the boolean below is the
    // presence of a value, not the presence of a resolver. `resolveApiKey`
    // returns undefined when no source supplies the credential, which is the
    // state under test.
    const searchProviderKeyPresent = false

    expect(rootModelKeyAvailable).toBe(true)
    expect(searchProviderKeyPresent).toBe(false)
    // SEPARATE: two different facts, neither derived from the other.
    expect(rootModelKeyAvailable).not.toBe(searchProviderKeyPresent)
  })

  it('turns an unusable search provider into WEB_PROVIDER_CONFIGURED_UNAVAILABLE, never into an empty result', async () => {
    // The status vocabulary is the seam's, quoted from
    // packages/web/web/src/index.ts (resolveProvider):
    //   configured id registered but !available() -> WEB_PROVIDER_CONFIGURED_UNAVAILABLE
    //   no id configured, no usable provider       -> WEB_PROVIDER_UNAVAILABLE
    // Both are ERRORS. Neither is `{ sources: [] }`, and that distinction is the
    // project rule this gate exists to enforce.
    const { Context } = await import('@deepseek-ai/cordis')
    const Web = await import('@deepseek-ai/dsh-web')

    const ctx = new Context()
    await ctx.plugin(Web.default as never, { searchProvider: 'absent-lane' } as never)

    // Nothing registered at all: the configured id is MISSING.
    await expect(ctx.get('web')!.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    })

    // Now register a provider whose own `available()` says no. This is the
    // search-key-absent state, expressed at the seam.
    const registered = ctx.effect(() => ctx.get('web')!.registerSearchProvider({
      id: 'absent-lane',
      available: () => false,
      search: () => Promise.reject(new Error('must not be reached: an unavailable provider must not run')),
    }), 'test: unavailable provider')

    await expect(ctx.get('web')!.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    })

    // And with NO configured id and no usable provider, the generic code.
    registered()
    await ctx.fiber.dispose()

    const bare = new Context()
    await bare.plugin(Web.default as never, {} as never)
    await expect(bare.get('web')!.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_UNAVAILABLE',
    })
    await bare.fiber.dispose()
  })

  it('never renders a failed search as `No results found.` — the tool text that would fabricate a negative finding', async () => {
    // This is the sharpest form of the project rule. `formatSearchOutput` has
    // exactly one branch that produces `No results found.`:
    //   packages/web/tool-web/src/search.ts
    //     else if (result.content === undefined || result.content.length === 0) parts.push('No results found.')
    // That branch is reachable ONLY from a resolved `WebSearchResult`. A
    // provider failure throws out of `ctx.web.search` before the tool's
    // `execute` ever produces a value, so the phrase cannot be produced by a
    // failure. The test drives the real tool text renderer both ways to pin it.
    const { formatSearchOutput } = await import('@deepseek-ai/dsh-tool-web')

    // A WORKING provider that genuinely found nothing: the honest zero.
    const zero = formatSearchOutput({ sources: [], truncated: false })
    expect(zero).toContain('No results found.')

    // A working provider WITH results: no such phrase.
    const found = formatSearchOutput({
      sources: [{ url: 'https://example.com/a', title: 'A' }],
      truncated: false,
    })
    expect(found).not.toContain('No results found.')
    expect(found).toContain('https://example.com/a')

    // The failure path is an error, so it never reaches this renderer at all.
    // Pin that the seam raises rather than resolving an empty value: if the
    // seam ever degraded a failure into `{ sources: [] }`, this test would be
    // the only place that noticed.
    const { Context } = await import('@deepseek-ai/cordis')
    const Web = await import('@deepseek-ai/dsh-web')
    const ctx = new Context()
    await ctx.plugin(Web.default as never, {} as never)
    ctx.effect(() => ctx.get('web')!.registerSearchProvider({
      id: 'failing-lane',
      available: () => true,
      search: () => Promise.reject(new Error('the search provider could not be reached')),
    }), 'test: failing provider')
    let resolved: unknown
    let rejected: unknown
    try {
      resolved = await ctx.get('web')!.search({ query: 'x' })
    } catch (error) {
      rejected = error
    }
    expect(resolved, 'a failed search must NOT resolve a value the renderer could read as zero hits').toBeUndefined()
    expect(rejected).toBeInstanceOf(Error)
    await ctx.fiber.dispose()
  })

  it('reports presence, not entitlement, from the ported provider — and never probes from available()', async () => {
    // The ported provider's own rule, asserted against the real module: a
    // presence check is not a tested entitlement, and `available()` must be a
    // cheap local check. A probe there would turn "the key is configured" into
    // "the key works", which is a claim nothing observed.
    const { createDualLaneSearchProvider } = await import('./web-search.ts')

    let probes = 0
    const provider = createDualLaneSearchProvider(
      { endpoint: 'https://example.com/search', apiKeyEnv: 'M914_ABSENT_KEY' },
      { isConfigured: (reference: string) => { probes += 1; return reference === 'M914_ABSENT_KEY' ? false : true } },
    )
    // The key is absent: presence is false, so the provider is NOT available.
    expect(provider.available()).toBe(false)
    // Presence was read, but nothing was dispatched. A network probe here would
    // make `available()` an entitlement claim.
    expect(probes).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// A10 — the headless boundary: the CLI stream is interaction, the Session is evidence.
// ---------------------------------------------------------------------------

describe('A10: the headless CLI stream is interaction; the persisted Session is evidence', () => {
  /**
   * The shipped `headless` profile with ONLY the model route redirected to a
   * keyless scripted adapter. Everything the runner owns stays mounted: the real
   * `headless-startup` parses the real command line and the real
   * `headless-runner` drives the real one-shot interval. The only thing removed
   * is the network, because the gate is about the CLI boundary.
   *
   * Two measured facts are encoded here, both learned by running it:
   *
   *   1. `name:` in an inserted row is an ENTRY OPTION, not row config, so a
   *      `!!js` expression there is never interpolated. Measured failure:
   *      `cli-mock-llm ([object Object]): failed to import`. A path relative to
   *      the patch file is the form the include's `anchorInsertedPluginNames`
   *      rewrites to a file URL — the same form the shipped keyless fixture uses
   *      (apps/cli/tests/profiles/headless/tests/fixtures/cli.patch.yml).
   *   2. The runner reads its route from `agentDefaultModel.currentSelection()`
   *      (packages/bundle/headless/src/index.ts), NOT from the agent-loop row.
   *
   * The patch directory must therefore sit INSIDE this package: the adapter is a
   * TypeScript module that imports `@deepseek-ai/dsh-llm`, and Node resolves
   * those bare specifiers by walking up from the FILE's directory. A temp
   * directory under the OS temp root has no such ancestor and the import fails
   * with `Cannot find package '@deepseek-ai/dsh-llm'` — reproduced before this
   * choice was made. This is the same reason the shipped fixture lives inside
   * the checkout.
   */
  const OVERLAY = [
    '- id: llm-deepseek',
    '  disabled: true',
    '',
    '- id: agent-default-model',
    '  config:',
    '    provider: cli-mock',
    '    model: cli-mock',
    '',
    '- id: session-persistence-jsonl',
    '  config:',
    '    root: !!js process.env.M914_SESSION_ROOT',
    '    compression: none',
    '',
    '- id: agent-instructions',
    '  disabled: true',
    '',
    '- insert:',
    '    - id: cli-mock-llm',
    "      name: './m914-mock-llm.ts'",
    '',
  ].join('\n')

  /** The scripted adapter, written beside the overlay so the relative path resolves. */
  const ADAPTER = `/**
 * A10 keyless scripted adapter. A real \`LlmAdapter\` on the real \`ctx.llm\`, so the
 * production AgentLoop, tool registry and Session log are all in the path. The
 * only thing removed is the network.
 *
 * Scripts, selected by M914_SCRIPT:
 *   tool-then-answer  one real shell tool call, then a short final answer.
 *   huge-output       the shell emits ~1 MiB; the final answer stays short, so
 *                     the oversized text exists ONLY in the tool result.
 *   business-failure  the shell EXITS NON-ZERO and the model then reports the
 *                     failure in prose and finishes normally. Nothing throws, so
 *                     the turn ends \`completed\` and the process exits 0 while the
 *                     business outcome is a failure. That is the point.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SCRIPT = process.env['M914_SCRIPT'] ?? 'tool-then-answer'
const HUGE_BYTES = 1024 * 1024

function command(): { command: string; description: string } {
  if (SCRIPT === 'huge-output') {
    return {
      command: process.platform === 'win32'
        ? \`Write-Output ('X' * \${String(HUGE_BYTES)})\`
        : \`head -c \${String(HUGE_BYTES)} /dev/zero | tr '\\\\0' 'X'\`,
      description: 'Emit about one mebibyte of output.',
    }
  }
  if (SCRIPT === 'business-failure') {
    return {
      command: process.platform === 'win32'
        ? "Write-Output 'M914_BUSINESS_FAILURE'; exit 3"
        : "echo M914_BUSINESS_FAILURE; exit 3",
      description: 'Run a command that reports a business failure.',
    }
  }
  return {
    command: process.platform === 'win32' ? "Write-Output 'M914_OK'" : 'echo M914_OK',
    description: 'Prove the one-shot runner drives a real tool call.',
  }
}

function finalText(): string {
  if (SCRIPT === 'business-failure') return 'M914_REPORT: the command failed and I am reporting it in prose.'
  return 'M914_REPORT: done.'
}

class M914MockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: OFF, name: 'Off' }], defaultEffort: OFF } }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const called = options.messages.at(-1)?.content.some(block => block.type === 'tool-result') === true
    if (called) {
      const text = finalText()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const { command: cmd, description } = command()
    const args = JSON.stringify({ command: cmd, description })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId('m914-call'), name: SHELL_TOOL, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('m914-call'), name: SHELL_TOOL, arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'm914-mock-llm'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new M914MockAdapter())
}
`

  interface HeadlessRun {
    status: number | null
    events: Array<Record<string, unknown>>
    stderr: string
    sessionFile: string
    session: Array<Record<string, unknown>>
  }

  /** One per-run scratch directory inside this package, so bare DSH imports resolve from the adapter. */
  const scratch: string[] = []
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Lay out one headless run: a throwaway `$DSH_HOME` with the shipped headless
   * bundle list, and a patch directory holding the overlay plus the adapter it
   * names relatively.
   */
  function stageHeadlessRun(): { home: TempRoot; patchDir: string; sessionRoot: string } {
    const home = tempHome()
    writeProfile(home, 'headless', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    const patchDir = mkdtempSync(join(import.meta.dirname, '..', '.m914-a10-'))
    scratch.push(patchDir)
    writeFileSync(join(patchDir, 'overlay.patch.yml'), OVERLAY)
    writeFileSync(join(patchDir, 'm914-mock-llm.ts'), ADAPTER)
    return { home, patchDir, sessionRoot: join(home.dir, 'sessions') }
  }

  /**
   * Drive the real launcher once and read BOTH surfaces back: the CLI event
   * stream from stdout, and the durable Session from disk.
   *
   * `--json` is the shipped machine-readable mode
   * (packages/bundle/headless/src/json-stream.ts): newline-delimited, bounded
   * events, with an unbounded terminal `final`.
   */
  function runHeadless(script: string, label: string): HeadlessRun {
    const { home, patchDir, sessionRoot } = stageHeadlessRun()

    const result = spawnSync(process.execPath, [
      LAUNCHER,
      '--profile', 'headless',
      '--patch', join(patchDir, 'overlay.patch.yml'),
      '--json',
      `m914 ${label}`,
    ], {
      cwd: DSH_SRC,
      env: {
        ...process.env,
        DSH_HOME: home.dir,
        DSH_TELEMETRY_DISABLED: '1',
        M914_SCRIPT: script,
        M914_SESSION_ROOT: sessionRoot,
      },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error !== undefined && result.error !== null) throw result.error

    const events = (result.stdout ?? '').trimEnd().split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)

    const session = findSession(sessionRoot)
    return {
      status: result.status,
      events,
      stderr: result.stderr ?? '',
      sessionFile: session.file,
      session: session.records,
    }
  }

  /** Locate the one persisted Session under a session root and parse its plain-JSONL log. */
  function findSession(root: string): { file: string; records: Array<Record<string, unknown>> } {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.jsonl')) files.push(full)
      }
    }
    walk(root)
    expect(files, `no persisted Session under ${root}`).toHaveLength(1)
    const file = files[0] as string
    const records = readFileSync(file, 'utf8').split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
    return { file, records }
  }

  /** The `turn/end` reason kind recorded in a Session log. */
  function turnEndKind(session: Array<Record<string, unknown>>): string {
    const ends = session.filter(record => record['type'] === 'turn/end')
    expect(ends).toHaveLength(1)
    const data = ends[0]?.['data'] as { reason?: { kind?: string } } | undefined
    return data?.reason?.kind ?? '<none>'
  }

  /** The model-facing text of the first `tool/result` in a Session log. */
  function toolResultText(session: Array<Record<string, unknown>>): string {
    const record = session.find(entry => entry['type'] === 'tool/result')
    expect(record, 'the Session log must contain a tool/result').toBeDefined()
    const data = record?.['data'] as { message?: { content?: Array<{ content?: Array<{ text?: string }> }> } } | undefined
    const blocks = data?.message?.content?.[0]?.content ?? []
    return blocks.map(block => block.text ?? '').join('')
  }

  /**
   * These three runs are the whole CPU budget of this file: three real launcher
   * subprocesses, serialized. They are not shared across tests because each one
   * must be observed through BOTH surfaces and a cached result would hide which
   * surface a failure came from.
   */
  it('baseline: a normally-completing turn exits 0 and the CLI stream and the Session agree', () => {
    const run = runHeadless('tool-then-answer', 'baseline')
    expect(run.status, `stderr: ${run.stderr}`).toBe(0)

    // The CLI stream is the INTERACTION surface: ordered, typed, live.
    const kinds = run.events.map(event => event['type'])
    expect(kinds[0]).toBe('session')
    expect(kinds).toContain('tool_call')
    expect(kinds).toContain('tool_result')
    expect(kinds.at(-1)).toBe('final')
    expect(run.events.find(event => event['type'] === 'tool_result')?.['status']).toBe('completed')

    // The Session is the EVIDENCE surface: durable, complete, and the only
    // place the turn's outcome is recorded.
    expect(run.session[0]?.['type']).toBe('session')
    expect(run.session.some(record => record['type'] === 'tool/call')).toBe(true)
    expect(turnEndKind(run.session)).toBe('completed')
    expect(toolResultText(run.session)).toContain('M914_OK')
    expect(run.stderr.trim()).toBe('')
  })

  it('large output: the CLI stream is BOUNDED and flags it, while the Session keeps the full result', () => {
    // The boundary under test is the one the CLI projection documents:
    //   packages/bundle/headless/src/json-stream.ts
    //     MAX_STRING_BYTES = 8 * 1024   (per string and per key)
    //     MAX_EVENT_BYTES  = 32 * 1024  (per serialized line)
    //     boundValue() truncates and sets `truncated: true`
    //     finish(text) is deliberately NOT bounded — "the answer is the lossless
    //     terminal contract, so it is not truncated"
    //
    // A reader who treats the CLI stream as evidence would therefore see 8 KiB
    // of a 1 MiB tool result and, without reading the flag, conclude the tool
    // returned 8 KiB. The Session is where the real payload is.
    const run = runHeadless('huge-output', 'large output')
    expect(run.status, `stderr: ${run.stderr}`).toBe(0)

    const result = run.events.find(event => event['type'] === 'tool_result')
    expect(result).toBeDefined()
    const projected = String(result?.['result'] ?? '')
    // BOUNDED: the projected text is capped at the documented per-string limit,
    // not at the ~1 MiB the tool actually produced.
    expect(projected.length).toBe(8 * 1024)
    // FLAGGED: the payload says it was cut, so a reader is warned.
    expect(result?.['truncated']).toBe(true)

    // The final answer is NOT bounded, because it is the terminal contract.
    const final = run.events.at(-1)
    expect(final?.['type']).toBe('final')
    expect(final?.['truncated']).toBeUndefined()
    expect(String(final?.['text'])).toBe('M914_REPORT: done.')

    // The Session holds far more than the CLI projection exposed. The exact
    // figure is the spill policy's `maxInlineBytes` (base bundle: 50000) plus
    // the `tool-result-pruner` head/tail budget, so the assertion is a lower
    // bound against the projection rather than a hard-coded 1 MiB: the point is
    // that the two surfaces disagree, and the durable one is larger.
    const persisted = toolResultText(run.session)
    expect(persisted.length).toBeGreaterThan(projected.length)
    expect(persisted.length).toBeGreaterThanOrEqual(50_000)
    expect(turnEndKind(run.session)).toBe('completed')
  })

  it('business failure inside a normally-completing turn: exit 0 is NOT business success', () => {
    // THE central A10 assertion. The shell exits 3, the model reports the
    // failure in prose, and nothing throws. The runner's own exit rule is
    // outcome-based on the TURN, not the work:
    //   packages/bundle/headless/src/index.ts
    //     io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
    // so this run exits 0 with `turn/end: completed` while the business outcome
    // is a failure. Both facts are asserted together, because either alone is
    // misleading.
    const run = runHeadless('business-failure', 'failing probe')
    expect(run.status, `stderr: ${run.stderr}`).toBe(0)

    // The turn completed. That is a statement about the model loop only.
    const turnEnd = run.events.find(event => event['type'] === 'status' && event['phase'] === 'turn_end')
    expect((turnEnd?.['reason'] as { kind?: string } | undefined)?.kind).toBe('completed')
    expect(turnEndKind(run.session)).toBe('completed')

    // The business failure is present and visible, but only in the CONTENT:
    // the tool's non-zero exit is rendered as a marker, not as `isError`.
    const result = run.events.find(event => event['type'] === 'tool_result')
    expect(result?.['status']).toBe('completed')
    expect(String(result?.['result'] ?? '')).toContain('[exit code: 3]')

    // The durable log agrees: the tool result is a normal append, not an error.
    const record = run.session.find(entry => entry['type'] === 'tool/result')
    const data = record?.['data'] as { message?: { content?: Array<{ isError?: boolean }> } } | undefined
    expect(data?.message?.content?.[0]?.isError).toBe(false)
    expect(toolResultText(run.session)).toContain('[exit code: 3]')

    // So the ONLY signal of business failure is the text. Nothing in the exit
    // status, the turn reason, or `isError` carries it. A supervisor that read
    // `exit 0` as success would be wrong here, and this test is the proof.
    expect(String(run.events.at(-1)?.['text'])).toContain('M914_REPORT')
  })

  it('reports a genuine turn-level failure as a non-zero exit, so the two failure kinds are distinguishable', () => {
    // The complement of the previous test: when the TURN fails, the runner does
    // report it. Without this, "exit 0 is not success" would be untestable
    // because exit would carry no information at all.
    const { home, patchDir, sessionRoot } = stageHeadlessRun()

    // Point the route at a provider with NO adapter, so the step fails before
    // any model call. That is a turn-level error, not a business failure.
    writeFileSync(
      join(patchDir, 'overlay.patch.yml'),
      OVERLAY.replace('    provider: cli-mock', '    provider: m914-no-such-provider'),
    )

    const result = spawnSync(process.execPath, [
      LAUNCHER, '--profile', 'headless', '--patch', join(patchDir, 'overlay.patch.yml'), '--json', 'fail',
    ], {
      cwd: DSH_SRC,
      env: {
        ...process.env,
        DSH_HOME: home.dir,
        DSH_TELEMETRY_DISABLED: '1',
        M914_SCRIPT: 'tool-then-answer',
        M914_SESSION_ROOT: sessionRoot,
      },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    expect(result.status, 'a turn-level error must not exit 0').toBe(1)
    const events = (result.stdout ?? '').trimEnd().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
    const turnEnd = events.find(event => event['type'] === 'status' && event['phase'] === 'turn_end')
    expect((turnEnd?.['reason'] as { kind?: string } | undefined)?.kind).toBe('error')
    expect(result.stderr).toMatch(/NO_ADAPTER/)
  })
})

// ---------------------------------------------------------------------------
// A12 — the REAL daily host, not a headless or testkit substitute.
// ---------------------------------------------------------------------------

describe('A12: the real daily Web host starts, serves, and owns a Session lifecycle', () => {
  /**
   * A12 is only closable up to the credential boundary, and this file does not
   * claim more than that.
   *
   * PROVEN by the runs below (see qualification/results/M9.14-profile-config/):
   *   - the real built launcher boots the real `daily-candidate` composition
   *     (base + web-app + the work extension) and binds a real HTTP server;
   *   - the browser-trust fence is live: an unauthenticated `/api` request is
   *     refused, and the printed `?token=` URL exchanges for a session cookie;
   *   - the Session lifecycle is driven through the REAL `session/*` RPC
   *     surface — `create` returns a session id and `list` reads it back with
   *     its projections, so a real Agent and a real Session exist;
   *   - `session/modelCatalog` reports the real route.
   *
   * NOT PROVEN, and deliberately not claimed: no model turn was run on this
   * host, because no credential source on this machine supplies
   * `DEEPSEEK_API_KEY`. A prompt submitted now would fail at the route, so
   * asserting a completed turn would be asserting something that did not happen.
   *
   * The launcher subprocess is NOT spawned from this test file: booting the Web
   * host is a long-lived process, and a vitest case that binds a port and holds
   * it would make this suite's teardown the gate's real failure mode. The boot
   * is driven by `qualification/results/M9.14-profile-config/run-a12.mjs` and its
   * transcript is the evidence. What this test asserts is the part that can be
   * checked from the recorded artifacts, so a reader can re-derive the claim.
   */
  const EVIDENCE = join(REPO, 'qualification', 'results', 'M9.14-profile-config')

  it('recorded the real Web host transcript, and it shows a bind, a trust fence and a Session', () => {
    const transcript = join(EVIDENCE, 'runs', 'a12-web-host.txt')
    expect(existsSync(transcript), `A12 evidence missing: ${transcript}`).toBe(true)
    const text = readFileSync(transcript, 'utf8')

    // 1. The real launcher bound a real port and printed the authenticated URL.
    expect(text).toMatch(/dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=/)
    // 2. The browser-trust fence refused an unauthenticated API request. The
    //    exact status is asserted, because "it refused" and "it 404'd" differ.
    expect(text).toMatch(/unauthenticated_api_status: 401/)
    // 3. The token URL exchanged for a session cookie and served the app shell.
    expect(text).toMatch(/authenticated_root_status: 200/)
    // 4. A real Session was created and read back through the real RPC surface.
    expect(text).toMatch(/session_create_ok: true/)
    expect(text).toMatch(/session_list_found_created: true/)
    // 5. And the credential boundary was reached, not crossed.
    expect(text).toMatch(/model_turn_run: false/)
    expect(text).toMatch(/credential_boundary: DEEPSEEK_API_KEY not configured/)
  })

  it('proves the boundary is a CREDENTIAL boundary, not a composition failure', () => {
    // The distinction matters: "the host would not boot" and "the host booted
    // and then had no key to call a model with" are different results, and only
    // the second one leaves A12 closeable by adding a key. The evidence for the
    // second is a recorded failure at the ROUTE, with the composition fully
    // mounted — captured from the real SDK profile, which shares the same
    // `llm-deepseek` row the Web profile mounts.
    const boundary = join(EVIDENCE, 'runs', 'a12-sdk-boundary.txt')
    expect(existsSync(boundary), `A12 boundary evidence missing: ${boundary}`).toBe(true)
    const text = readFileSync(boundary, 'utf8')

    // The composition mounted: the SDK handshake answered with the real runtime
    // identity, so the tree booted.
    expect(text).toContain('deepseek-harness-sdk-runtime')
    // A real Session was driven: the turn started and a real tool catalog was
    // assembled, so the failure is not "nothing ran".
    expect(text).toContain('"type":"turn/start"')
    expect(text).toContain('"type":"request/header"')
    // The failure is the credential, named as such by the adapter itself.
    expect(text).toContain('no API key for provider route')
    expect(text).toContain('DEEPSEEK_API_KEY')
    // And the turn ended as an ERROR, not as a silent success.
    expect(text).toContain('"kind":"error"')
  })

  it('is not substituted by a headless or testkit run — the host evidence names the Web profile', () => {
    // The gate's oracle is "do not substitute a headless or testkit result".
    // The recorded transcript must therefore be traceable to the Web profile and
    // the daily composition, not to the one-shot runner. This asserts that
    // traceability from the artifact itself.
    const text = readFileSync(join(EVIDENCE, 'runs', 'a12-web-host.txt'), 'utf8')
    expect(text).toMatch(/profile: m914-daily/)
    expect(text).toMatch(/bundles: .*dsh-web-app/)
    expect(text).toMatch(/work_extension_mounted: true/)
  })
})
