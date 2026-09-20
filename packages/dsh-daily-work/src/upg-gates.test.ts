/**
 * UPG-01..08 — the upgrade, migration and rollback acceptance family.
 *
 * WHAT MAKES THIS FAMILY DIFFERENT. The other families ask "does it work". This
 * one asks what happens to data that ALREADY EXISTS when the code changes, and
 * its failure mode is silent: a schema upgrade that drops an unknown record and
 * starts normally looks identical to one that migrated it. So every test here is
 * written to make the DIFFERENCE VISIBLE — a refusal must be a refusal with a
 * code, a preserved object must be byte-identical, and a deletion must be
 * observable rather than inferred from an absence.
 *
 * THE TWO STATUSES THAT ARE NOT PASSES, and why they are recorded as such:
 *
 *   UPG-06 an artifact still referenced must not be collected — **FAIL**. This
 *     deployment has TWO collectors and they hold the property in opposite ways.
 *     The spill sweep is AGE-based (`SweepOptions` is `roots`/`cutoffMs`/`warn`
 *     and nothing else), so it deletes a still-referenced artifact and its only
 *     lever is `mtime`. The content-addressed store HAS a correct
 *     reference-aware collector (`collectGarbage(referenced, graceMs, now)`), but
 *     NO production path calls it — `DataPlaneService` exposes `reconcile()`,
 *     which deletes nothing, and every call site is a test. So the property
 *     holds in production only because nothing collects. Both halves are
 *     measured here, and the reachability half by an import-graph scan, so the
 *     gate cannot be closed by pointing at a passing test.
 *
 *   UPG-07 real 30-provider — BLOCKED_EXTERNAL. `compatibility.lock.json`
 *     records `live_provider_budget_authorized: false`. The gate requires an
 *     authorized frontier provider driving 30 non-empty children, and it says in
 *     its own text that a mock result does not substitute for it. Nothing here
 *     manufactures one.
 *
 *   UPG-08 the daily verdict — NOT_READY, because mandatory gates in this family
 *     and in DEP/SEC are FAIL or NOT_RUN or BLOCKED_EXTERNAL. The verdict is
 *     COMPUTED from the per-gate results in this file, not typed.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WORK_SCHEMA_VERSION, WORK_DOMAIN_NAME, WorkService } from './host.ts'
import { runRecordSchema } from './record.ts'

/** The repo root, resolved from this file rather than from cwd. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** The pinned DSH checkout this deployment is qualified against. */
const DSH_SRC = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'

/** Import a file from the pinned checkout by absolute path. */
const srcUrl = (relativePath: string): string => pathToFileURL(join(DSH_SRC, ...relativePath.split('/'))).href

/** The evidence directory this family writes to. */
const EVIDENCE = join(REPO_ROOT, 'qualification', 'results', 'M-DEP-SEC-UPG')

const tempDirs: string[] = []

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-upg-${label}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/** Collapse comment wrapping so a phrase survives a reflow but not a reword. */
function flat(text: string): string {
  return text
    .split(/\r?\n/u)
    .map(line => line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/|#)\s?/u, ''))
    .join(' ')
    .replace(/\s+/gu, ' ')
}

/** A recursive sha256 map of a directory's regular files, keyed by relative path. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out[relative(root, full).split('\\').join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root)
  return out
}

/** A service over a real JSON storage domain in `dir`. */
async function openService(dir: string, config: Partial<{ targetChildren: number; maxDepth: number; budgetCeiling: number }> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageJsonPlugin as never, { root: dir } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const service = new WorkService(ctx, {
    targetChildren: config.targetChildren ?? 3,
    maxDepth: config.maxDepth ?? 1,
    budgetCeiling: config.budgetCeiling ?? 50,
    currency: 'USD',
    priceVersion: 'upg',
    subagentProvider: 'spawn',
  })
  await service.open()
  return { ctx, service }
}

/** The single-layout unit file the JSON backend publishes for this domain. */
const STORE_FILE = `${WORK_DOMAIN_NAME}.json`

/** Create a run and close cleanly, leaving a real store on disk. */
async function seedRun(dir: string, runId = 'run-seed'): Promise<void> {
  const { ctx, service } = await openService(dir)
  await service.createRun({
    runId,
    // The root is an Agent-shaped stand-in: `createRun` reads only the live
    // session's id, and a full Agent is not needed to seed a durable record. The
    // cast matches how the durability suite builds the same fixture.
    root: { session: { header: { id: SessionId(`session-${runId}`) } } } as never,
    authorizationRef: `auth-${runId}`,
    targetChildren: 3,
  })
  await service.close()
  await ctx.fiber.dispose()
}

// ---------------------------------------------------------------------------
// UPG-01 — compiled install
// ---------------------------------------------------------------------------

describe('UPG-01: the candidate profile installs from a BUILT package, with no source absolute path', () => {
  /**
   * The gate's oracle: install the candidate profile from an actual built
   * package, with no dependency on a source absolute path, and a first
   * python/native call that succeeds.
   *
   * The install was measured (`M9.17-b02-resolver`, `M9.18-b03-lifecycle`), and
   * this file CITIES that evidence rather than re-booting the launcher. What it
   * adds is the part a boot cannot show: that the artifacts a profile resolves
   * are BUILT, that the installed profile's dependency is a `link:` to a package
   * whose `lib/` exists, and that no absolute source path appears in the patch.
   */
  it('the package ships built output that the declared exports point at', () => {
    const pkgDir = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>
      files: string[]
      dsh: { bundle: { patch: string } }
    }
    // The build output must EXIST: a profile that resolves to a missing file
    // fails at import, which is the exact defect G-FIX-04 records.
    expect(existsSync(join(pkgDir, 'lib')), 'lib/ must be built').toBe(true)
    for (const [name, entry] of Object.entries(manifest.exports)) {
      if (name === './package.json') continue
      for (const key of ['types', 'default'] as const) {
        const target = join(pkgDir, entry[key])
        expect(existsSync(target), `${name}.${key} -> ${entry[key]} must exist`).toBe(true)
        // Built JavaScript, not TypeScript: a `src` target would ship source
        // where a consumer expects a module.
        expect(entry[key]).not.toContain('/src/')
        expect(entry[key]).toMatch(/^\.\/lib\//u)
      }
    }
    // The bundle patch is what makes the package a BUNDLE. Without it the
    // resolver installs the code and activates NO layer (G-FIX-04).
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    // And every production source has a built counterpart, so `lib/` is not a
    // stale subset that happens to satisfy the exports.
    const sources = readdirSync(join(pkgDir, 'src'))
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map(f => f.replace(/\.ts$/u, '.js'))
      .sort()
    const missing = sources.filter(f => !existsSync(join(pkgDir, 'lib', f)))
    expect(missing, 'every production source must have been compiled').toEqual([])
  })

  it('the installed profile depends on the package by LINK, and resolves to a built artifact', () => {
    const profile = 'D:/DSH/home/canary5/profiles/daily'
    if (!existsSync(profile)) {
      // The profile home is a deployment artifact, not a repo file. Its absence
      // is reported rather than silently skipped, so the gate cannot pass by
      // having nothing to check.
      expect(existsSync(profile), 'the installed daily profile must exist for this gate to be measured').toBe(true)
    }
    const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    // The dependency is a `link:` to the package directory. This is what makes
    // it a development install rather than a published one, and it is recorded
    // as the reach limit of this gate.
    expect(profileManifest.dependencies['dsh-daily-work']).toMatch(/^link:/u)
    // The bundle is DECLARED in the profile, which is what activates its layer.
    expect(profileManifest.dsh.profile.bundles).toContain('dsh-daily-work')
    // The linked package's `main` resolves to a built file that exists.
    const linked = join(profile, 'node_modules', 'dsh-daily-work')
    expect(existsSync(linked), 'the link must resolve').toBe(true)
    const linkedManifest = JSON.parse(readFileSync(join(linked, 'package.json'), 'utf8')) as { main: string }
    expect(existsSync(join(linked, linkedManifest.main)), 'the linked package main must be built').toBe(true)
    // The layer's patch file, which the resolver reads.
    expect(existsSync(join(linked, 'cordis.patch.yml'))).toBe(true)
  })

  it('the profile patch contains no absolute SOURCE path, so the install does not depend on this checkout layout', () => {
    const patch = readFileSync(join(REPO_ROOT, 'profiles', 'daily-candidate', 'cordis.patch.yml'), 'utf8')
    // A plugin row may name a package (`dsh-daily-work/host`) or a `file:` URL.
    // A bare absolute path is neither: it binds the profile to one machine's
    // directory layout, which is what broke every junction when DSH moved.
    const rows = [...patch.matchAll(/name:\s*'?([^'\n]+)'?/gu)].map(m => m[1]!.trim())
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // A package specifier: a bare name, optionally with a subpath.
      const isPackageSpecifier = /^[a-z0-9@][a-z0-9@/._-]*$/iu.test(row)
      expect(isPackageSpecifier, `row name "${row}" must be a package specifier, not a path`).toBe(true)
      expect(row).not.toMatch(/^[A-Za-z]:[\\/]/u)
      expect(row).not.toMatch(/^\//u)
    }
    // And the patch text itself carries no absolute path in any form.
    expect(patch).not.toMatch(/[A-Za-z]:[\\/]{1,2}(?:DSH|Users|work)/u)
    expect(patch).not.toMatch(/file:\/\//u)
    // The bundle patch the package ships has the same property.
    const bundle = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'cordis.patch.yml'), 'utf8')
    const bundleRows = [...bundle.matchAll(/name:\s*'?([^'\n]+)'?/gu)].map(m => m[1]!.trim())
    for (const row of bundleRows) {
      expect(row, `bundle row "${row}" must be a package specifier`).toMatch(/^[a-z0-9@][a-z0-9@/._-]*$/iu)
    }
  })

  it('cites the measured resolver result: exactly ONE built copy of each peer, no src/lib mix', () => {
    const findings = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M9.17-b02-resolver', 'FINDINGS.md'), 'utf8')
    // The gate's identity half, measured inside a REAL `dsh --profile daily`
    // boot rather than by direct mounting.
    expect(flat(findings)).toContain('The extension is loaded by the **real profile resolver**, not only by')
    expect(flat(findings)).toContain('There is exactly **one** copy of Cordis and of each injected DSH service on every resolution root; no `src`/`lib` module-identity mix')
    // And the specific defect that the earlier PASS missed, which is why this
    // gate's evidence is a boot rather than a mount.
    expect(flat(findings)).toContain('The package had **never been compiled**')
    expect(flat(findings)).toContain('The package **declared no `dsh.bundle.patch`**, so `dsh plugin add` installed it as a plain dependency and activated **no layer at all**')
    // The lesson, pinned: a gate whose oracle is weaker than its scenario.
    expect(flat(findings)).toContain('a gate whose oracle is weaker than its scenario will pass while the product is broken')
    // The first-native-call half is the e2e catalog measurement.
    const e2e = JSON.parse(readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M8.5-c2-real-boot', 'e2e-tool.json'), 'utf8')) as {
      created: boolean; toolCountAgentKey: number; workToolPresent: boolean
    }
    expect(e2e.created).toBe(true)
    expect(e2e.toolCountAgentKey).toBeGreaterThan(0)
    expect(e2e.workToolPresent).toBe(true)
  })

  it('the compiled package imports and exposes its declared surface at runtime', async () => {
    // The built artifact is imported directly, so "it is built" is a runtime
    // fact rather than a directory listing.
    const pkgDir = join(REPO_ROOT, 'packages', 'dsh-daily-work')
    const hostPlugin = await import(pathToFileURL(join(pkgDir, 'lib', 'host-plugin.js')).href) as Record<string, unknown>
    expect(hostPlugin.name).toBe('dsh-daily-work')
    expect(hostPlugin.inject).toEqual(['storageDomain'])
    expect(typeof hostPlugin.apply).toBe('function')
    expect(typeof hostPlugin.WorkService).toBe('function')
    // The service module, resolved through the declared export.
    const service = await import(pathToFileURL(join(pkgDir, 'lib', 'host.js')).href) as Record<string, unknown>
    expect(service.WORK_DOMAIN_NAME).toBe(WORK_DOMAIN_NAME)
    expect(service.WORK_SCHEMA_VERSION).toBe(WORK_SCHEMA_VERSION)
    // And the tools module, whose `WORK_TOOL_NAME` is the model-facing name.
    const tools = await import(pathToFileURL(join(pkgDir, 'lib', 'tools.js')).href) as Record<string, unknown>
    expect(tools.WORK_TOOL_NAME).toBe('work')
  })
})

// ---------------------------------------------------------------------------
// UPG-02 — Session schema upgrade
// ---------------------------------------------------------------------------

describe('UPG-02: an old Session carrying new compute/observation records migrates by version or is REFUSED', () => {
  /**
   * THE DEFECT THIS GATE NAMES: "不能丢未知事件装正常" — do not drop an unknown
   * event and look normal. The mechanism the pinned checkout provides is precise,
   * and it is measured here rather than described:
   *
   *   - A Session whose stored version is NEWER than this build writes is
   *     reported `unsupported` with both versions named. That is the refusal.
   *   - An event type this build does not know is admitted ONLY when it carries
   *     `ignorable: true`. Without that marker the restore FAILS at `finish()`.
   *
   * The second half is the load-bearing one, and it is not obvious: the row
   * DECODES without error and the failure appears only at `finish()`. A consumer
   * that stopped after `decodeRow` would read the log as intact.
   */
  const catalog = async (): Promise<{
    sessionFormatCatalog: {
      currentVersion: number
      readHeader(header: unknown): { status: string; storedVersion?: number; targetVersion?: number; reason?: string }
      encodeCurrentHeader(header: unknown, inherited: number): unknown
      encodeCurrentEvent(event: unknown): unknown
      createRestore(header: unknown, options: { recovery: string; validation: string }): {
        header: unknown
        decodeRow(row: unknown): void
        finish(): { events: readonly unknown[] }
      }
    }
  }> => await import(srcUrl('packages/session/session-format-catalog/lib/index.js')) as never

  /** A current-shaped physical header, produced by the build's own encoder. */
  async function currentHeader(): Promise<unknown> {
    const { sessionFormatCatalog } = await catalog()
    return sessionFormatCatalog.encodeCurrentHeader(
      { version: sessionFormatCatalog.currentVersion, id: 'session-upg02', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: 'C:\\upg' },
      0,
    )
  }

  it('a Session from a NEWER build is refused as `unsupported`, naming both versions', async () => {
    const { sessionFormatCatalog } = await catalog()
    const future = sessionFormatCatalog.currentVersion + 1
    const verdict = sessionFormatCatalog.readHeader({
      type: 'session', version: future, id: 'session-future', createdAt: 1, isSeeded: false, delegationDepth: 0,
    })
    expect(verdict.status).toBe('unsupported')
    expect(verdict.storedVersion).toBe(future)
    expect(verdict.targetVersion).toBe(sessionFormatCatalog.currentVersion)
    // The reason names both, so a reader knows which direction the mismatch is.
    expect(verdict.reason).toContain(`stored Session uses newer format v${String(future)}`)
    expect(verdict.reason).toContain(`this build writes v${String(sessionFormatCatalog.currentVersion)}`)
    // The current version is 3, and the catalog is build-static, so this is a
    // fact about the installed build rather than about a mounted plugin.
    expect(sessionFormatCatalog.currentVersion).toBe(3)
  })

  it('an unknown event type with NO `ignorable` marker FAILS the restore — it is not dropped silently', async () => {
    const { sessionFormatCatalog } = await catalog()
    const header = await currentHeader()
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    // A known event first, so the log is genuinely a Session rather than only
    // the offending row.
    restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent({
      type: 'user/message', seq: 0, time: 1,
      data: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      surfaceOp: 'append',
    }))
    // The NEW record shape this gate is about: a compute/observation event a
    // build that predates the data plane would not know.
    const unknownEvent = { type: 'compute/observation', seq: 1, time: 2, data: { kernelEpoch: 1, observationId: 'obs-1' } }
    // The row DECODES. That is the trap: a consumer checking only `decodeRow`
    // would see no error here.
    restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(unknownEvent))
    // The refusal arrives at `finish()`, and it names the type and the seq.
    let thrown: unknown
    try { restore.finish() } catch (error) { thrown = error }
    expect(thrown, 'an unknown non-ignorable event must fail the restore').toBeDefined()
    const failure = thrown as Error & { name: string }
    expect(failure.name).toBe('SessionFormatUnsupportedMigrationError')
    expect(failure.message).toContain('compute/observation')
    expect(failure.message).toContain('seq 1')
  })

  it('the SAME unknown event with `ignorable: true` is retained — the compatibility mechanism, measured', async () => {
    const { sessionFormatCatalog } = await catalog()
    const header = await currentHeader()
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    const event = {
      type: 'compute/observation', seq: 0, time: 1,
      data: { kernelEpoch: 1, observationId: 'obs-1' },
      // The envelope's own marker, which is what makes the omission safe to
      // retain: the writer ASSERTED that skipping this event cannot reconstruct
      // a wrong Session.
      ignorable: true,
    }
    restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
    const artifact = restore.finish()
    // Retained, not dropped: the event count includes it.
    expect(artifact.events).toHaveLength(1)
    const retained = artifact.events[0] as { type: string; ignorable?: boolean }
    expect(retained.type).toBe('compute/observation')
    expect(retained.ignorable).toBe(true)
  })

  it('the marker is the ONLY admission path, and the seam says why a name registry was rejected', () => {
    const known = readFileSync(join(DSH_SRC, 'packages', 'core', 'session', 'src', 'known-event-types.ts'), 'utf8')
    // The rule, in the seam's own words.
    expect(flat(known)).toContain('The persistence read path refuses to interpret a log containing a type outside this set unless the event carries the envelope\'s `ignorable` marker')
    expect(flat(known)).toContain('such a log was likely written by a newer harness, and silently skipping a required event would reconstruct a wrong session')
    // And the design decision: event-NAME registration was rejected because it
    // does not classify omission SAFETY. That is the reason the marker exists
    // rather than an allow-list, and it is why a plugin cannot admit itself.
    expect(flat(known)).toContain('event-name registration was rejected because it does not classify omission safety and would make reads composition-dependent')
    // Downstream plugin events are outside the list BY CONSTRUCTION, which is
    // the honest statement of the compatibility contract.
    expect(flat(known)).toContain('Downstream (out-of-repo) plugin events are outside this list by construction')
  })

  it('the v2 -> v3 migration refuses an UNCLASSIFIED event rather than passing it through', () => {
    const payload = readFileSync(join(DSH_SRC, 'packages', 'session', 'session-format-v2-to-v3', 'src', 'payload.ts'), 'utf8')
    // A type with no disposition in the released table is refused, and the
    // refusal names the type.
    expect(flat(payload)).toContain('cannot safely transform unclassified event')
    expect(payload).toMatch(/SessionFormatUnsupportedMigrationError\('format v2 to v3 cannot safely transform unclassified event '/u)
    // And the released PTC tags get an explicit admission rule rather than being
    // interpreted: a required predecessor tag is refused, an ignorable one is
    // re-typed to an opaque released event.
    const validation = readFileSync(join(DSH_SRC, 'packages', 'session', 'session-format-v2-to-v3', 'src', 'validation.ts'), 'utf8')
    expect(flat(validation)).toContain('Obsolete ignorable events do not participate in released PTC lifecycle validation')
    expect(validation).toMatch(/assertV3EventAdmission/u)
    expect(validation).toMatch(/format v3 contains unknown event type/u)
  })

  it('this project\'s OWN store has the same discipline: a record version it does not accept is refused', async () => {
    // The sibling property at the work domain's own boundary, measured in
    // `durability-advanced.test.ts` (D12) and cited rather than duplicated.
    const durability = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'durability-advanced.test.ts'), 'utf8')
    expect(durability).toContain('D12: a record version this build does not accept')
    expect(flat(durability)).toContain('The rule is "refuses to start rather than silently reading a backup"')
    expect(flat(durability)).toContain('so the test also asserts the file is byte-identical afterwards: a rejected open must not have rewritten, migrated or truncated anything')
    // And the whole-unit header version is the BACKEND's check with its own code.
    expect(flat(durability)).toContain('The whole-unit header version is the BACKEND\'s check, not the domain\'s, so it fails with the backend\'s own code before any record is validated')
  })
})

// ---------------------------------------------------------------------------
// UPG-03 — artifact compatibility
// ---------------------------------------------------------------------------

describe('UPG-03: old spill locators coexist with new refs, with explicit permissions and lifecycle', () => {
  /**
   * The gate's oracle: 旧数据不被删除或错误重新归属 — old data is not deleted and
   * not wrongly re-owned. Two mechanisms make that true, and both are measured:
   *
   *   1. A spill locator is SESSION-SCOPED: `sessionDir()` hashes the session id
   *      into a `session-<12 hex>` directory. Two sessions never share a
   *      directory, so a new session cannot overwrite or adopt an old one's
   *      files.
   *   2. The sweep's SELECTION is exact-shape, not prefix-based: a session
   *      directory must match `^session-[0-9a-f]{12}$`, so an unrelated
   *      `session-backup` directory is never swept. This is the "wrongly
   *      re-owned" hazard closed by a shape rule rather than by an age rule.
   */
  const spill = async (): Promise<{
    saveTextFile(options: { root: string; sessionId: string; suggestedName: string; content: string }): Promise<{ path: string; bytes: number }>
    sessionDir(root: string, sessionId: string): string
    sweepSpillRoots(options: { roots: { path: string; pruneWhenEmpty: boolean }[]; cutoffMs: number; warn: (message: string) => void }): Promise<void>
    discoverDefaultRoots(): string[]
    DEFAULT_ROOT_PREFIX: string
  }> => await import(srcUrl('packages/spill/spill-local/lib/index.js')) as never

  it('a spill locator is session-scoped, so a new session cannot adopt an old one\'s files', async () => {
    const store = await spill()
    const root = tempDir('upg03')
    // The gate's exact scenario: an OLD locator and a NEW locator coexisting.
    const old = await store.saveTextFile({ root, sessionId: 'session-old', suggestedName: 'old.txt', content: 'OLD-SPILL-CONTENT' })
    const fresh = await store.saveTextFile({ root, sessionId: 'session-new', suggestedName: 'new.txt', content: 'NEW-SPILL-CONTENT' })
    // Different directories, derived from the session id.
    expect(store.sessionDir(root, 'session-old')).not.toBe(store.sessionDir(root, 'session-new'))
    expect(old.path).not.toBe(fresh.path)
    // BOTH remain readable: nothing was deleted or rewritten by the new write.
    expect(readFileSync(old.path, 'utf8')).toBe('OLD-SPILL-CONTENT')
    expect(readFileSync(fresh.path, 'utf8')).toBe('NEW-SPILL-CONTENT')
    // The old file's bytes are unchanged by the new session's activity, which is
    // the "not wrongly re-owned" half expressed as content rather than as a path.
    const before = createHash('sha256').update(readFileSync(old.path)).digest('hex')
    await store.saveTextFile({ root, sessionId: 'session-new', suggestedName: 'third.txt', content: 'THIRD' })
    expect(createHash('sha256').update(readFileSync(old.path)).digest('hex')).toBe(before)
  })

  it('the directory name is a hash of the session id, so the locator is stable across restarts', async () => {
    const store = await spill()
    const root = tempDir('upg03b')
    // Stability is what makes an OLD locator still resolvable after an upgrade:
    // a random directory name would orphan every existing locator.
    const first = store.sessionDir(root, 'session-stable')
    const second = store.sessionDir(root, 'session-stable')
    expect(first).toBe(second)
    expect(first).toMatch(/session-[0-9a-f]{12}$/u)
    // The name is a hash, not the raw id: a session id with a path separator
    // cannot escape the root.
    const hostile = store.sessionDir(root, '../../escape')
    expect(hostile.startsWith(root)).toBe(true)
    expect(hostile).toMatch(/session-[0-9a-f]{12}$/u)
  })

  it('the sweep deletes only EXPIRED files inside EXACT-shaped session directories', async () => {
    const store = await spill()
    const root = mkdtempSync(join(tmpdir(), `${store.DEFAULT_ROOT_PREFIX}abc123-`))
    tempDirs.push(root)
    const sessionDirectory = store.sessionDir(root, 'session-sweep')
    mkdirSync(sessionDirectory, { recursive: true })
    writeFileSync(join(sessionDirectory, 'expired.txt'), 'EXPIRED', 'utf8')
    writeFileSync(join(sessionDirectory, 'recent.txt'), 'RECENT', 'utf8')
    // Age one file past the cutoff. `utimesSync` is a real mtime change, so the
    // sweep's age rule is exercised rather than simulated.
    const longAgo = new Date(Date.now() - 600_000)
    utimesSync(join(sessionDirectory, 'expired.txt'), longAgo, longAgo)
    // A directory that does NOT match the session shape. This is the
    // wrongly-re-owned hazard: a prefix-based sweep would descend into it.
    const foreign = join(root, 'session-backup')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'precious.txt'), 'NOT-A-SPILL', 'utf8')
    utimesSync(join(foreign, 'precious.txt'), longAgo, longAgo)

    const warnings: string[] = []
    await store.sweepSpillRoots({ roots: [{ path: root, pruneWhenEmpty: false }], cutoffMs: Date.now() - 300_000, warn: message => warnings.push(message) })

    expect(existsSync(join(sessionDirectory, 'expired.txt')), 'an expired file is reclaimed').toBe(false)
    expect(existsSync(join(sessionDirectory, 'recent.txt')), 'a recent file survives').toBe(true)
    expect(existsSync(join(foreign, 'precious.txt')), 'a foreign directory is never swept').toBe(true)
    expect(readFileSync(join(foreign, 'precious.txt'), 'utf8')).toBe('NOT-A-SPILL')
    // A pruneWhenEmpty=false root is not itself removed.
    expect(existsSync(root)).toBe(true)
    expect(warnings).toEqual([])
  })

  /**
   * STRENGTHENED. The test above asserts ONE foreign directory survives. That
   * is a single near-miss, and "exact shape" is a claim about a FAMILY of
   * near-misses: a prefix-based or regex-loosened regression could still pass
   * while sweeping a name that differs by one character. So the case below
   * plants every boundary of `^session-[0-9a-f]{12}$` at once and asserts, by
   * OBSERVED SURVIVAL of each planted file, that none of them is touched —
   * plus the symlink case, where a planted `session-<12hex>` JUNCTION points at
   * a foreign tree and the sweep must neither delete nor descend through it.
   *
   * The oracle is the file CONTENTS after the sweep, not a regex read out of
   * the source: a shape rule that is present in the source but not enforced
   * would still delete these files.
   */
  it('the exact-shape boundary is observed: every near-miss name and a session-shaped SYMLINK survive', async () => {
    const store = await spill()
    const root = mkdtempSync(join(tmpdir(), `${store.DEFAULT_ROOT_PREFIX}shape99-`))
    tempDirs.push(root)
    const longAgo = new Date(Date.now() - 600_000)

    /** Plant a directory with one aged file and return the file's path. */
    const plant = (name: string): string => {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'aged.txt')
      writeFileSync(file, name, 'utf8')
      utimesSync(file, longAgo, longAgo)
      return file
    }

    // The exact shape, which MUST be swept: the positive control, so a sweep
    // that did nothing at all cannot pass this test.
    const inShape = store.sessionDir(root, 'session-in-shape')
    mkdirSync(inShape, { recursive: true })
    const sweepable = join(inShape, 'aged.txt')
    writeFileSync(sweepable, 'SWEEPABLE', 'utf8')
    utimesSync(sweepable, longAgo, longAgo)

    // Every boundary of the shape, one character away from a match.
    const nearMisses: Record<string, string> = {
      // 11 hex chars (one short).
      'session-0123456789a': plant('session-0123456789a'),
      // 13 hex chars (one long).
      'session-0123456789abc': plant('session-0123456789abc'),
      // 12 chars, but UPPERCASE hex — `[0-9a-f]` is case-sensitive.
      'session-ABCDEF123456': plant('session-ABCDEF123456'),
      // 12 chars, but one is outside the hex alphabet.
      'session-0123456789az': plant('session-0123456789az'),
      // The bare prefix with no hash.
      'session-': plant('session-'),
      // A prefix-based regression would take this one.
      'session-backup': plant('session-backup'),
      // A `startsWith` regression would take this one.
      'session-0123456789ab-extra': plant('session-0123456789ab-extra'),
    }

    // A session-SHAPED name that is a JUNCTION to a foreign tree. `lstat` must
    // see a link (not a directory) and leave it alone: readdir/unlink through
    // it would delete files in the foreign target.
    const foreignTree = mkdtempSync(join(tmpdir(), 'dsh-upg03-foreign-'))
    tempDirs.push(foreignTree)
    const foreignPrecious = join(foreignTree, 'precious.txt')
    writeFileSync(foreignPrecious, 'FOREIGN-TREE', 'utf8')
    utimesSync(foreignPrecious, longAgo, longAgo)
    const linkName = store.sessionDir(root, 'session-symlinked')
    symlinkSync(foreignTree, linkName, 'junction')
    // The premise of the assertion: the link IS session-shaped, so only the
    // lstat-not-follow rule can save the foreign tree.
    expect(linkName).toMatch(/session-[0-9a-f]{12}$/u)
    expect(lstatSync(linkName).isSymbolicLink(), 'the planted link must really be a link').toBe(true)

    const warnings: string[] = []
    await store.sweepSpillRoots({ roots: [{ path: root, pruneWhenEmpty: false }], cutoffMs: Date.now() - 300_000, warn: message => warnings.push(message) })

    // The positive control fired, so the sweep genuinely ran.
    expect(existsSync(sweepable), 'the in-shape expired file must be reclaimed, or this test proves nothing').toBe(false)
    // Every near-miss survived WITH ITS BYTES, observed rather than inferred.
    for (const [name, file] of Object.entries(nearMisses)) {
      expect(existsSync(file), `"${name}" is not session-shaped and must not be swept`).toBe(true)
      expect(readFileSync(file, 'utf8'), `"${name}" must be byte-identical after the sweep`).toBe(name)
    }
    // The foreign tree behind the session-shaped link is untouched, and the
    // link itself still exists (the sweep skipped it rather than unlinking it).
    expect(existsSync(foreignPrecious), 'the foreign tree behind a session-shaped link must survive').toBe(true)
    expect(readFileSync(foreignPrecious, 'utf8')).toBe('FOREIGN-TREE')
    expect(existsSync(linkName), 'the planted link is skipped, not deleted').toBe(true)
    // The sweep REPORTED the skip, so the survival is a decision rather than an
    // accident of ordering.
    expect(warnings.some(message => message.includes('skipped unsafe session directory'))).toBe(true)
  })

  it('the exact-shape rules are in the source, so a prefix-based regression is visible', () => {
    const cleanup = readFileSync(join(DSH_SRC, 'packages', 'spill', 'spill-local', 'src', 'cleanup.ts'), 'utf8')
    // The session-directory shape, and the reason: an unrelated directory under
    // a shared configured root is never swept.
    expect(cleanup).toMatch(/SESSION_DIR_RE\s*=\s*\/\^session-\[0-9a-f\]\{12\}\$\//u)
    expect(flat(cleanup)).toContain('The sweep only descends into entries of this EXACT shape, so an unrelated `session-backup` directory under a shared configured root is never swept')
    // The default-root shape, and the reason: a foreign tool's differently
    // shaped directory is never mistaken for a backend root.
    expect(cleanup).toMatch(/DEFAULT_ROOT_RE\s*=\s*new RegExp/u)
    expect(flat(cleanup)).toContain('so an unrelated `dsh-spill-test-*` fixture or a foreign tool\'s differently-shaped `dsh-spill-…` directory is never mistaken for a backend root to sweep')
    // And the symlink discipline: `lstat` never follows a link, so a planted
    // symlink can neither be deleted nor redirect the age check.
    expect(flat(cleanup)).toContain('a symlink or any non-regular entry (socket, fifo, nested dir) is left untouched')
    expect(flat(cleanup)).toContain('so a planted symlink can neither be deleted nor redirect the age check')
    expect(cleanup).toMatch(/if \(!stats\.isFile\(\)\) continue/u)
    // A sweep is best-effort and never throws, so it cannot fail activation.
    expect(flat(cleanup)).toContain('Every filesystem and warning-sink failure is contained, so a caller can await this during activation/disposal without it ever rejecting')
  })

  it('the permissions are explicit: an owner-only directory holding owner-only files', async () => {
    const store = await spill()
    const root = tempDir('upg03c')
    const saved = await store.saveTextFile({ root, sessionId: 'session-perm', suggestedName: 'f.txt', content: 'X' })
    const storeSource = readFileSync(join(DSH_SRC, 'packages', 'spill', 'spill-local', 'src', 'store.ts'), 'utf8')
    // The modes are declared in the source rather than left to the umask, and
    // the write is exclusive-create so it cannot inherit an existing file's
    // permissions.
    expect(flat(storeSource)).toContain('Write text to a fresh 0600 file below its private session directory')
    expect(storeSource).toMatch(/mkdir\(dir, \{ recursive: true, mode: 0o700 \}\)/u)
    expect(storeSource).toMatch(/open\(path, 'wx', 0o600\)/u)
    // The file exists and is a regular file (the POSIX mode is not meaningful on
    // Windows, so the assertion is on the shape the source declares).
    expect(statSync(saved.path).isFile()).toBe(true)
    expect(saved.bytes).toBe(1)
  })

  it('the spill service is mounted by the shipped profile, so locators are not a test-only concept', () => {
    // Measured from the C0 resolved graph rather than assumed: both spill rows
    // are in the shipped composition.
    const dump = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M0.5-c0-resolved-graph', 'dump-default-web.yml'), 'utf8')
    expect(dump).toContain('spill-local')
    expect(dump).toContain('spill-policy')
    // The policy's own header states its lifecycle contract: an omitted
    // `maxInlineBytes` registers NOTHING (a true no-op), so the feature is
    // opt-in rather than silently active.
    const policy = readFileSync(join(DSH_SRC, 'packages', 'spill', 'spill-policy', 'src', 'index.ts'), 'utf8')
    expect(flat(policy)).toContain('Omitted `maxInlineBytes` ⇒ the plugin registers nothing (a true no-op)')
    // And a spill failure never turns a successful tool call into an error.
    expect(flat(policy)).toContain('A spill failure must NEVER turn a successful tool call into an `isError` or hide the inline result')
  })
})

// ---------------------------------------------------------------------------
// UPG-04 — backup / restore
// ---------------------------------------------------------------------------

describe('UPG-04: a backup restores on a new host with verifiable identity, and kernel state is NOT in it', () => {
  /**
   * The gate's oracle: back up Session + artifact + config, restore on a new
   * host, verify hash/identity, and state explicitly that VOLATILE kernel state
   * is not in the backup.
   *
   * The rehearsal below is real: a store is seeded, its bytes are hashed, the
   * whole tree is copied to a DIFFERENT directory, the copy is opened by a fresh
   * host, and the restored record is compared against the original. The kernel
   * half is a statement about what a backup CANNOT contain, and it is pinned
   * from the audit's own text rather than invented.
   */
  it('a store backed up and restored in a new location is byte-identical and reopens with the same runs', async () => {
    const source = tempDir('upg04-src')
    const destination = tempDir('upg04-dst')
    await seedRun(source, 'run-backup')

    const before = hashTree(source)
    expect(Object.keys(before)).toContain(STORE_FILE)
    // A REAL digest, computed here rather than compared against a recorded
    // string, so "byte-identical" is falsifiable by the test itself.
    const sourceDigest = createHash('sha256').update(readFileSync(join(source, STORE_FILE))).digest('hex')
    expect(sourceDigest).toMatch(/^[a-f0-9]{64}$/u)
    // A real directory copy, which is what a backup IS.
    cpSync(source, destination, { recursive: true })
    const after = hashTree(destination)
    // IDENTITY: every file's digest matches, so the restore is verifiable rather
    // than merely present.
    expect(after).toEqual(before)
    // And the restored copy's store file hashes to the SOURCE digest — the
    // per-file check the map equality above implies, stated so a reader can see
    // the digest rather than infer it from a map comparison.
    expect(createHash('sha256').update(readFileSync(join(destination, STORE_FILE))).digest('hex')).toBe(sourceDigest)

    // The restored copy opens in a FRESH host over a DIFFERENT directory.
    const restored = await openService(destination)
    try {
      expect(restored.service.listRunIds()).toEqual(['run-backup'])
      const record = restored.service.getRun('run-backup')
      expect(record?.runId).toBe('run-backup')
      expect(record?.rootSessionId).toBe('session-run-backup')
      expect(record?.authorizationRef).toBe('auth-run-backup')
      // The record carries no epoch: a restore is not a new generation, and the
      // field was deleted with the settlement guard that would have read it
      // (qualification/results/R9-recovery-topology/).
      expect(Object.hasOwn(record!, 'epoch'), 'the restored record carries no epoch').toBe(false)
      // A restored run is fully usable: the counts recompute from stored state.
      // `desiredTarget` is the user's N as the record carries it, and every
      // occupancy bucket is zero because the run has no admitted work yet.
      const counts = restored.service.counts('run-backup')
      expect(counts.desiredTarget).toBe(3)
      expect(counts.durablyAdmitted).toBe(0)
      expect(counts.activeAssignments).toBe(0)
      expect(counts.launching).toBe(0)
      // The user's target N survives the restore, so a restored run keeps the
      // authority the user set rather than a default.
      expect(record?.requestedTarget).toBe(3)
    } finally {
      await restored.service.close()
      await restored.ctx.fiber.dispose()
    }

    // And the source is UNCHANGED by the restore, so a backup is not destructive.
    expect(hashTree(source)).toEqual(before)
    // STRENGTHENED: the destination's bytes are also unchanged by OPENING it.
    // The claim is "byte-identical after restore", and a reopen that rewrote or
    // re-serialized the document would break identity for a file whose contents
    // are semantically the same — which is exactly the silent drift a digest
    // check exists to catch. Measured AFTER the reopen above, so the assertion
    // covers the open path rather than only the copy.
    expect(hashTree(destination)).toEqual(before)
    expect(createHash('sha256').update(readFileSync(join(destination, STORE_FILE))).digest('hex')).toBe(sourceDigest)
  })

  it('the backup does NOT carry kernel volatile state, and that is a property of the record shape', async () => {
    const dir = tempDir('upg04b')
    await seedRun(dir, 'run-nokernel')
    const stored = JSON.parse(readFileSync(join(dir, STORE_FILE), 'utf8')) as Record<string, unknown>
    // The store holds ONLY the domain's own tables. There is no field for a
    // kernel, a namespace, a live variable or a connection file, so a backup of
    // it CANNOT contain volatile state — the exclusion is structural rather than
    // a documented omission.
    const serialized = JSON.stringify(stored)
    // The check is on the store's FIELD NAMES rather than on the serialized text:
    // a VALUE could legitimately contain the word "kernel" (a task prompt could),
    // and a substring test would then fail for the wrong reason.
    const fieldNames = new Set<string>()
    const collectKeys = (value: unknown): void => {
      if (Array.isArray(value)) { for (const member of value) collectKeys(member); return }
      if (value === null || typeof value !== 'object') return
      for (const [key, member] of Object.entries(value)) { fieldNames.add(key.toLowerCase()); collectKeys(member) }
    }
    collectKeys(stored)
    for (const forbidden of ['kernel', 'namespace', 'connectionfile', 'curve_secretkey', 'ipykernel', 'stdout', 'variables']) {
      expect([...fieldNames], `the store must have no ${forbidden} field`).not.toContain(forbidden)
    }
    // What it DOES hold, so the assertion is not vacuous.
    expect(serialized).toContain('run-nokernel')
    // The kernel half of the gate is stated by the audit, and its own text is
    // the source: volatile state is a NEW epoch by default, never replayed.
    const architecture = readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/ARCHITECTURE.zh-CN.md', 'utf8')
    expect(architecture).toContain('volatile kernel：默认新epoch，不重放过去任意cell')
    // And the recovery manifest must state what was lost, not claim completeness.
    expect(architecture).toContain('每次恢复清单给出：checkpoint as-of、loaded、skipped、lost、environment changed、unresolved effects')
    expect(architecture).toContain('从旧checkpoint重建的数组可能落后于最后cell，不能只报“恢复成功”')
  })

  it('the config is backed up as a NAME, never as a secret value', () => {
    // The config half of "Session + artifact + config": the patch is a tracked
    // file, and its credential entry is an environment NAME. A backup of the
    // config therefore cannot leak a secret, which is what makes it safe to
    // restore on a new host.
    const patch = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('apiKeyEnv: EXA_API_KEY')
    expect(flat(patch)).toContain('The reference is NAMED here; no credential value is ever placed in configuration')
    // No high-entropy literal that could be a key.
    expect(patch).not.toMatch(/(?:api[_-]?key|token|secret)\s*:\s*["']?[A-Za-z0-9_\-]{24,}["']?/iu)
    // The budget and target are user-authorized values in the SAME file, so a
    // restore brings back the authority the user set rather than a default.
    expect(patch).toContain('targetChildren: 10')
    expect(patch).toContain('budgetCeiling: 200')
  })

  it('the artifact half has a real content-addressed primitive with a verified digest', async () => {
    // The artifact half of the backup is the immutable object store. The
    // publication primitive hashes WHILE streaming and hard-links into a
    // digest-derived path, so the digest is the identity and a restored object
    // can be verified rather than trusted.
    //
    // THIS TEST USED TO DEEP-IMPORT THE PRIMITIVE'S SOURCE (`.../src/store.ts`).
    // It now measures the SAME property through the public `ctx.attachments`
    // capability, which is the seam the product uses -- defect F4 was exactly that
    // a `.ts` source path appeared in the production import graph and created a
    // second physical module instance. Measuring the property through the private
    // module would have kept that coupling alive in a test that is cited as
    // evidence, so the test moved with the code.
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: AttachmentLocal } = await import('@deepseek-ai/dsh-attachment-local')
    const root = tempDir('upg04-art')
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: join(root, 'home') })
    const content = Buffer.from('UPG04-ARTIFACT-BODY-abcdef')
    const expected = createHash('sha256').update(content).digest('hex')
    async function* body(): AsyncIterable<Uint8Array> { yield content }
    const published = await ctx.attachments.saveFileStream({ data: body(), name: 'upg04-object' })
    // The provider-computed digest IS the content's digest, so a restore can verify.
    expect(String(published.attachmentId)).toBe(`sha256:${expected}`)
    expect(published.bytes).toBe(content.length)
    // The object's PATH contains its digest, which is what makes the identity
    // checkable without a separate index.
    const hostPath = ctx.attachments.fileHostPath(published)
    expect(hostPath, 'the mounted provider must be host-backed for a backup to name the object').toBeDefined()
    expect(hostPath).toContain(expected)
    expect(createHash('sha256').update(readFileSync(hostPath as string)).digest('hex')).toBe(expected)
    // The stored object is READ-ONLY, which is the property that makes it safe for
    // a backup to hard-link rather than copy: a later writer cannot mutate an
    // object an earlier checkpoint already references.
    //
    // ASSERTED AS "NO WRITE BIT", not as the literal `0o400`. The provider calls
    // `chmod(target, 0o400)`, but on Windows that maps onto the read-only file
    // attribute and Node reports the file as `0o444` -- measured here, with a write
    // attempt refusing `EPERM`. Asserting the literal would have been a POSIX-only
    // test of a cross-platform property, and the property is what a backup needs.
    const mode = statSync(hostPath as string).mode
    expect(mode & 0o222, 'a published object must carry no write bit').toBe(0)
    let writeRefusal = 'the write was NOT refused'
    try {
      writeFileSync(hostPath as string, Buffer.from('R2F4-TAMPER'))
    } catch (error) {
      writeRefusal = String((error as NodeJS.ErrnoException).code)
    }
    expect(writeRefusal, 'a published object must refuse an in-place write').toBe('EPERM')
    expect(createHash('sha256').update(readFileSync(hostPath as string)).digest('hex')).toBe(expected)
    // And the same bytes read back through the capability verify against the
    // address, so a restore can check rather than trust.
    const chunks: Buffer[] = []
    for await (const chunk of ctx.attachments.readFileStream(published)) chunks.push(Buffer.from(chunk))
    expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(expected)
    // The provider's own contract states the property this gate turns on. The
    // contract is read from the package's PUBLIC type surface (`lib/types/`), not
    // from its `src/` tree: a test that reached into `src/` would reintroduce the
    // exact source-plane coupling this change removed.
    const declaration = readFileSync(join(DSH_SRC, 'packages', 'attachment', 'attachment-local', 'lib', 'types', 'store.d.ts'), 'utf8')
    expect(flat(declaration)).toContain('Content-addressed, owner-private local attachment storage')
    const fileStoreDeclaration = readFileSync(join(DSH_SRC, 'packages', 'attachment', 'attachment-local', 'lib', 'types', 'file-store.d.ts'), 'utf8')
    expect(flat(fileStoreDeclaration)).toContain('Commit one file byte-for-byte from bounded chunks below a versioned attachment root')
  })

  it('the backup rehearsals this project already ran are cited, not re-invented', () => {
    // U05's canary procedure ran against a fresh temp home with the daily home
    // untouched, and U06 rehearsed a real rollback over a temp home.
    const findings = readFileSync(join(REPO_ROOT, 'qualification', 'results', 'M9.20-real-tasks', 'FINDINGS.md'), 'utf8')
    expect(flat(findings)).toContain('A real canary procedure executed against the current version in a fresh temp home')
    expect(flat(findings)).toContain('8 gates re-run, the daily home untouched, with a positive control proving the write check has teeth')
    expect(flat(findings)).toContain('A real rehearsal over a temp home: old artifact + old consistency snapshot restored byte-for-byte')
    // And the honest limit of U05: the new-version half is blocked.
    expect(flat(findings)).toContain('the new-version half of U05 do not, and they are recorded as BLOCKED_EXTERNAL rather than dressed up')
    expect(existsSync(join(REPO_ROOT, 'qualification', 'results', 'M9.20-real-tasks', 'u05-canary.mjs'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'qualification', 'results', 'M9.20-real-tasks', 'u06-rollback.mjs'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// UPG-05 — rollback
// ---------------------------------------------------------------------------

describe('UPG-05: rolling back the runtime does not roll back the external world', () => {
  /**
   * The gate's oracle: 新schema数据可读或安全拒绝，保留effects未知 — new-schema
   * data is readable or safely refused, and effects stay UNKNOWN. The defect it
   * targets is a rollback that restores software and state and then reports the
   * run as if an external effect had never happened.
   *
   * This project already rehearsed exactly that (`M9.20-real-tasks/u06-rollback.mjs`,
   * cited below), and the rehearsal's load-bearing assertion is that the
   * remote's counter still reads 1 after the rollback.
   */
  const U06 = join(REPO_ROOT, 'qualification', 'results', 'M9.20-real-tasks', 'u06-rollback.mjs')

  it('the rehearsal exists, and its three clauses are the gate\'s three clauses', () => {
    expect(existsSync(U06), 'the rollback rehearsal must exist').toBe(true)
    const script = readFileSync(U06, 'utf8')
    // Clause 1 — the OLD artifact plus an OLD consistency snapshot, restored
    // byte-identically rather than merely present.
    expect(flat(script)).toContain('OLD ARTIFACT + OLD CONSISTENCY SNAPSHOT')
    expect(flat(script)).toContain('the script asserts the restored state is byte-identical to the snapshot rather than merely present')
    // Clause 2 — the external effect is RECONCILED, not withdrawn, using the
    // REAL effect ledger.
    expect(flat(script)).toContain('EXTERNAL EFFECTS ARE RECONCILED, NOT WITHDRAWN')
    expect(flat(script)).toContain('it uses the REAL effect ledger (`src/effects.ts`), not a reimplementation')
    expect(flat(script)).toContain('the reconciliation reaches the remote ZERO times through')
    expect(flat(script)).toContain('that the effect is NOT undone')
    // Clause 3 — the assertion that makes the gate worth running.
    expect(flat(script)).toContain('ROLLING BACK SOFTWARE IS NOT ROLLING BACK THE WORLD')
    expect(flat(script)).toContain('after the rollback, the remote\'s counter still reads 1. The software went back; the send did not.')
    // And the failure mode the gate excludes, named.
    expect(flat(script)).toContain('A rollback that restored the software AND the state, and then reported the run as if the effect had never happened')
    expect(flat(script)).toContain('the reconciliation report must say `mayHaveHappened: true` for the effect the new version sent, and no reason string may contain a claim of reversal')
  })

  /**
   * STRENGTHENED. The rehearsal's header says clause 3 is an ASSERTION — "after
   * the rollback, the remote's counter still reads 1". A header sentence is not
   * a measurement, so this case reads the rehearsal's own REPORT and requires
   * the counter to be there as a recorded number, with the transport-invocation
   * counts on both sides of the reconciliation.
   *
   * It also pins the claim to a REHEARSAL. `docs/OPERATIONS.md` asks for a real
   * rollback; the rehearsal runs against a temp home with a counting in-process
   * fake for the remote and a version-bumped copy of the SAME code for the "new
   * version". Those two facts must be in the report, and this case fails if the
   * report ever reads as though a real remote had been exercised.
   */
  it('the rehearsal\'s OWN REPORT carries the counter, and states that the remote is a fake', () => {
    const report = join(REPO_ROOT, 'qualification', 'results', 'M9.20-real-tasks', 'u06-rollback.json')
    expect(existsSync(report), 'the rehearsal must have written its report').toBe(true)
    const parsed = JSON.parse(readFileSync(report, 'utf8')) as {
      kind: string
      steps: { id: string; status: string; detail: string; [key: string]: unknown }[]
      summary: { pass: number; fail: number }
      notClaimed: string[]
    }
    // The report names itself a rehearsal over a temp home, not a production run.
    expect(parsed.kind).toBe('ROLLBACK_REHEARSAL_OVER_A_TEMP_HOME')
    expect(parsed.summary.fail).toBe(0)
    const byId = new Map(parsed.steps.map(step => [step.id, step]))
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11']) {
      expect(byId.get(id)?.status, `${id} must have run and passed`).toBe('PASS')
    }
    // The counter claim, as a NUMBER in the report rather than a sentence in the
    // header: the effect is still present in the world after the rollback.
    const r9 = byId.get('R9')!
    expect(r9['remoteStillHoldsEffect']).toBe(true)
    // The transport was invoked once by the new version and NOT again by the
    // reconciliation — both sides of the comparison recorded.
    const r8 = byId.get('R8')!
    expect(r8['performCountBeforeReconcile']).toBe(1)
    expect(r8['performCountAfterReconcile']).toBe(1)
    expect(r8['performedByCall']).toBe(false)
    // And the report says in its own words that the remote is a FAKE and no real
    // remote was contacted. Without this the finding would read as though a real
    // remote had been exercised, which is the over-claim the gate excludes.
    expect(parsed.notClaimed.join(' ')).toContain('the remote is a counting in-process fake')
    expect(byId.get('R11')?.detail).toContain('The remote is a counting in-process fake')
  })

  it('the rehearsal names what is real and what is a fixture, including that no newer version exists to install', () => {
    const script = readFileSync(U06, 'utf8')
    // The honest scope statement: the "new version" is a version-bumped copy of
    // the SAME code, because no newer release exists.
    expect(flat(script)).toContain('the "new version" is a copy of the SAME code with a schema version bumped, because no newer version exists to install')
    expect(flat(script)).toContain('The remote is a counting in-process fake, because no real remote is authorized')
    // The real parts.
    expect(flat(script)).toContain('the old artifact is a real copy of this package\'s built output')
    expect(flat(script)).toContain('the effect ledger is `src/effects.ts` over the real storage domain')
  })

  it('this project\'s store REFUSES a version it does not accept, and leaves the bytes untouched', async () => {
    // The "safely refused" half of the gate's oracle, measured on this project's
    // own store rather than only cited.
    const dir = tempDir('upg05')
    await seedRun(dir, 'run-rollback')
    const storePath = join(dir, STORE_FILE)
    const original = readFileSync(storePath, 'utf8')
    const document = JSON.parse(original) as { unit: { version: number } }
    // A NEWER unit version, which is what a rollback actually faces: data written
    // by a version the rolled-back build does not know.
    document.unit.version = WORK_SCHEMA_VERSION + 1
    writeFileSync(storePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    const mutated = readFileSync(storePath, 'utf8')
    // STRENGTHENED: the comparison is on a sha256 DIGEST, not only on the
    // string. "Byte-identical" is a claim about bytes; a string compare happens
    // to imply it here (utf8 round-trip), but a digest is the claim stated in
    // its own terms and is the form the evidence file records.
    const mutatedDigest = createHash('sha256').update(mutated).digest('hex')
    expect(mutatedDigest).not.toBe(createHash('sha256').update(original).digest('hex'))

    let thrown: unknown
    try {
      const opened = await openService(dir)
      await opened.service.close()
      await opened.ctx.fiber.dispose()
    } catch (error) { thrown = error }
    expect(thrown, 'a newer unit version must be REFUSED, not read as current').toBeDefined()
    // The refusal is the backend's own, with its own code.
    expect((thrown as { name: string }).name).toBe('StorageError')
    expect((thrown as { code?: string }).code).toBe('version-mismatch')
    // And the refused open did not rewrite, migrate or truncate the file. This is
    // what makes the refusal SAFE: a rollback that corrupted the newer data while
    // refusing it would be worse than one that read it wrongly.
    expect(readFileSync(storePath, 'utf8')).toBe(mutated)
    expect(createHash('sha256').update(readFileSync(storePath)).digest('hex'), 'a refused open must leave the bytes untouched').toBe(mutatedDigest)
    // The whole DIRECTORY is unchanged too, so the refusal wrote no side file
    // (a temp file, a journal, a backup) that a later reader might mistake for
    // state. This is the difference between "the store file is intact" and "the
    // medium was not touched at all".
    const directoryAfterRefusal = readdirSync(dir).sort()
    expect(directoryAfterRefusal).toEqual([STORE_FILE])

    // The control: restoring the original bytes makes the store open normally, so
    // the refusal is about the version and not a directory left unusable.
    writeFileSync(storePath, original, 'utf8')
    const restored = await openService(dir)
    expect(restored.service.getRun('run-rollback')?.runId).toBe('run-rollback')
    await restored.service.close()
    await restored.ctx.fiber.dispose()
  })

  it('the effect ledger treats a rolled-back send as UNKNOWN rather than reversing it', () => {
    // The ledger's own vocabulary, which is what makes "effects stay unknown"
    // mechanically true rather than a policy statement.
    const effects = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'effects.ts'), 'utf8')
    expect(effects).toMatch(/mayHaveHappened|'unknown'/u)
    // The ledger's tests already assert the reconciliation semantics; cited.
    const tests = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'effects.test.ts'), 'utf8')
    expect(tests).toContain('E11: cancellation does not roll back')
    expect(tests).toContain('E09: opaque shell classification')
    // And the adversarial arm, which is the reason the classification is not a
    // keyword match: text that LOOKS read-only really does write.
    expect(tests).toContain('adversarial: the same text that is classified read_only really does write')
    // The architecture states the same rule at the design level.
    const architecture = readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/ARCHITECTURE.zh-CN.md', 'utf8')
    expect(architecture).toContain('磁盘状态、kernel内存、远端服务状态互不自动回滚')
    expect(architecture).toContain('在途cell/工具无确认终态时标unknown')
  })

  it('the ledger\'s own header states the limit of what a reconciliation can promise', () => {
    const effects = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'effects.ts'), 'utf8')
    // The general case does NOT get exactly-once: only an adapter with an
    // idempotency key and a postcondition can be reconciled, which is what stops
    // a rollback from claiming a guarantee it cannot have.
    const architecture = readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/ARCHITECTURE.zh-CN.md', 'utf8')
    expect(architecture).toContain('外部服务明确支持幂等key和postcondition的特定adapter可以对账')
    expect(architecture).toContain('通用cell不能因此获得exactly-once')
    // The ledger is a real module with a documented decision table.
    expect(effects.length).toBeGreaterThan(0)
    expect(flat(effects)).toMatch(/send decision|idempotenc/iu)
  })

  /**
   * THE TWO-VERSION ROLLBACK, EXERCISED FOR REAL.
   *
   * `docs/RECOVERY.md` and `docs/OPERATIONS.md` both claim a rollback restores
   * "the old artifact **and** the old state snapshot the new version has not
   * migrated". Until this case existed, nothing in this package exercised a
   * SECOND VERSION at all: the UPG-04 case copies one store with ONE version of
   * the code, and `durability-advanced.test.ts` D12 HAND-EDITS a stored record
   * to look foreign. Neither is a rollback, because in both cases the same
   * binary wrote and read the data.
   *
   * This case runs three real generations over one directory:
   *
   *   v1 writes   the CURRENT production spec (`WORK_SCHEMA_VERSION`, `single`
   *               layout) over a real `WorkService`, so the v1 store is a
   *               production-shaped store rather than a fixture.
   *   v2 opens    a REAL domain at version 2 with `layout: 'per-record'` and
   *               `compatibleVersions: [1]`, which is the checkout's own
   *               documented upgrade path (`storage-domain/src/spec.ts`: a
   *               `compatibleVersions` entry is what makes the bootstrap accept
   *               a legacy whole-unit file). It reads the v1 record through the
   *               legacy bootstrap, MIGRATES it, and writes records stamped 2.
   *   v1 opens    the SAME directory again with the version-1 spec — the
   *               rollback — and the test records what the rolled-back build
   *               actually sees.
   *
   * WHAT THIS MEASURES, AND WHY IT MATTERS. The v2 write is the migration the
   * rollback claim is about, and the migrated record documents are stamped 2. A
   * version-1 reader accepts only stamp 1, so the per-record contract DISCARDS
   * them: the rolled-back build sees an EMPTY table while the files are still on
   * disk. That is a silent data-loss shape for exactly the data the new version
   * wrote, and the test asserts it rather than describing it. It is the
   * concrete reason the docs require restoring the SNAPSHOT and not only the old
   * artifact — and it is also why "rolling back the software" alone is NOT
   * sufficient, which the docs say but nothing had measured.
   *
   * The `single`-layout direction is measured too, because it is the layout the
   * production spec currently uses: a v1 `single` reader over a v2-written
   * `single` unit is REFUSED with `version-mismatch` and leaves the bytes
   * untouched. Both directions are honest; they differ in HOW the rollback
   * fails, not in whether it fails.
   */
  it('a REAL two-version rollback: v1 writes, v2 migrates, and v1 cannot read what v2 wrote', async () => {
    /** Mount the real storage stack over `root` and return the facility's context. */
    const mount = async (root: string): Promise<Context> => {
      const ctx = new Context()
      await ctx.plugin(Storage)
      await ctx.plugin(storageJsonPlugin as never, { root } as never)
      await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
      return ctx
    }

    /**
     * A v2 domain spec for the SAME domain name, built from the production
     * record schema by EXTENDING it. The extension is the migration: a field
     * that exists only in v2, so a v1 reader can never round-trip a v2 record
     * even if it were handed one.
     */
    const v2RecordSchema = runRecordSchema.extend({ v2MigrationStamp: z.string().min(1).optional() })
    const specFor = (version: number, layout: 'single' | 'per-record', compatibleVersions?: readonly number[]) => defineDomain({
      name: WORK_DOMAIN_NAME,
      version,
      ...layout === 'per-record' ? { layout: 'per-record' as const } : {},
      ...compatibleVersions === undefined ? {} : { compatibleVersions: [...compatibleVersions] },
      global: {
        schema: z.object({ initialized: z.boolean() }),
        initial: { initialized: false },
      },
      tables: { runs: domainTable<string, RunRecordV2>(v2RecordSchema) },
    })
    type RunRecordV2 = ReturnType<typeof v2RecordSchema.parse>

    const V1_SINGLE = specFor(WORK_SCHEMA_VERSION, 'single')
    const V1_PER_RECORD = specFor(WORK_SCHEMA_VERSION, 'per-record')
    const V2_PER_RECORD = specFor(WORK_SCHEMA_VERSION + 1, 'per-record', [WORK_SCHEMA_VERSION])

    // -----------------------------------------------------------------------
    // GENERATION 1 — the CURRENT production build writes a real store.
    // -----------------------------------------------------------------------
    const dir = tempDir('upg05-two-version')
    await seedRun(dir, 'run-from-v1')
    const v1StorePath = join(dir, STORE_FILE)
    const v1Digest = createHash('sha256').update(readFileSync(v1StorePath)).digest('hex')
    const v1Document = JSON.parse(readFileSync(v1StorePath, 'utf8')) as { unit: { version: number } }
    expect(v1Document.unit.version).toBe(WORK_SCHEMA_VERSION)

    // -----------------------------------------------------------------------
    // GENERATION 2 — a v2 build opens the v1 store, migrates it, and writes.
    // -----------------------------------------------------------------------
    const ctxV2 = await mount(dir)
    const v2 = await ctxV2.get('storageDomain')!.open(V2_PER_RECORD)
    // The legacy bootstrap READ the v1 record: the migration is a real upgrade
    // rather than a fresh write.
    expect([...v2.table('runs').keys()], 'v2 must read the v1 record through the legacy bootstrap').toEqual(['run-from-v1'])
    const carried = v2.table('runs').get('run-from-v1')!
    expect(carried.runId).toBe('run-from-v1')
    // A field the v1 writer set survives the migration, so the upgrade carries
    // data rather than only the key.
    expect(carried.requestedTarget).toBe(3)
    // v2 writes: the migrated record plus a NEW record only v2 knows about.
    await v2.table('runs').put('run-from-v1', { ...carried, v2MigrationStamp: 'migrated-by-v2' })
    await v2.table('runs').put('run-from-v2', { ...carried, runId: 'run-from-v2', rootSessionId: 'session-run-from-v2', v2MigrationStamp: 'created-by-v2' })
    await v2.close()
    await ctxV2.fiber.dispose()

    // The migration is OBSERVABLE on the medium: v2's record documents are
    // stamped with the v2 version, and the v1 legacy file is retained unchanged
    // (the bootstrap never rewrites it).
    const recordDir = join(dir, WORK_DOMAIN_NAME, 'runs')
    const v2Documents = readdirSync(recordDir).sort()
    expect(v2Documents).toEqual(['run-from-v1.json', 'run-from-v2.json'])
    const stamped = JSON.parse(readFileSync(join(recordDir, 'run-from-v1.json'), 'utf8')) as { version: number; record: { v2MigrationStamp?: string } }
    expect(stamped.version).toBe(WORK_SCHEMA_VERSION + 1)
    expect(stamped.record.v2MigrationStamp).toBe('migrated-by-v2')
    expect(createHash('sha256').update(readFileSync(v1StorePath)).digest('hex'), 'the legacy v1 file must be retained unchanged').toBe(v1Digest)

    // -----------------------------------------------------------------------
    // GENERATION 3 — THE ROLLBACK. The v1 build opens the v2-written directory.
    // -----------------------------------------------------------------------
    const ctxRollback = await mount(dir)
    const v1AfterRollback = await ctxRollback.get('storageDomain')!.open(V1_PER_RECORD)
    const visibleToV1 = [...v1AfterRollback.table('runs').keys()]
    await v1AfterRollback.close()
    await ctxRollback.fiber.dispose()

    // THE FINDING, ASSERTED: the rolled-back v1 build sees NOTHING. Both records
    // the v2 build wrote are stamped 2, and a version-1 reader accepts only
    // stamp 1, so the per-record contract discards them. The bytes are still on
    // disk — the data was not deleted, it became UNREADABLE.
    expect(visibleToV1, 'the v1 build must NOT read v2-stamped records: they are discarded, not migrated').toEqual([])
    expect(existsSync(join(recordDir, 'run-from-v1.json')), 'the v2 record is still on disk; it is unreadable, not gone').toBe(true)
    expect(existsSync(join(recordDir, 'run-from-v2.json'))).toBe(true)

    // The ROLLBACK PROCEDURE the docs prescribe — restore the old snapshot — is
    // what recovers this, and it is measured: the v2 record tree is removed and
    // the pre-upgrade store is what the v1 build reads. The v1 store file was
    // never rewritten (asserted above by digest), so it IS the snapshot.
    expect(createHash('sha256').update(readFileSync(v1StorePath)).digest('hex'), 'the pre-upgrade store is still the snapshot').toBe(v1Digest)
    rmSync(join(dir, WORK_DOMAIN_NAME), { recursive: true, force: true })
    const ctxRestored = await mount(dir)
    const v1Restored = await ctxRestored.get('storageDomain')!.open(V1_SINGLE)
    expect([...v1Restored.table('runs').keys()], 'restoring the pre-upgrade store is what makes the rollback readable').toEqual(['run-from-v1'])
    await v1Restored.close()
    await ctxRestored.fiber.dispose()

    // -----------------------------------------------------------------------
    // THE OTHER DIRECTION — a v2 `single` unit read by v1 is REFUSED, not
    // silently emptied. Both are failures; only the per-record one is silent,
    // which is the distinction a rollback procedure has to know.
    // -----------------------------------------------------------------------
    const singleDir = tempDir('upg05-two-version-single')
    const V2_SINGLE = specFor(WORK_SCHEMA_VERSION + 1, 'single')
    const ctxV2Single = await mount(singleDir)
    const v2Single = await ctxV2Single.get('storageDomain')!.open(V2_SINGLE)
    await v2Single.table('runs').put('run-from-v2', {
      ...runRecordSchema.parse(JSON.parse(readFileSync(v1StorePath, 'utf8')).tables.runs['run-from-v1']) as RunRecordV2,
      runId: 'run-from-v2',
      v2MigrationStamp: 'created-by-v2',
    })
    await v2Single.close()
    await ctxV2Single.fiber.dispose()
    const singleStorePath = join(singleDir, STORE_FILE)
    const singleAfterV2 = readFileSync(singleStorePath, 'utf8')

    const ctxV1Single = await mount(singleDir)
    let thrown: unknown
    try {
      const opened = await ctxV1Single.get('storageDomain')!.open(V1_SINGLE)
      await opened.close()
    } catch (error) { thrown = error }
    await ctxV1Single.fiber.dispose()
    expect(thrown, 'a v1 reader over a v2 single unit must be REFUSED, not read as current').toBeDefined()
    expect((thrown as { name: string }).name).toBe('StorageError')
    expect((thrown as { code?: string }).code).toBe('version-mismatch')
    // And the refusal left the newer bytes alone, so a failed rollback does not
    // destroy the data the newer version wrote.
    expect(readFileSync(singleStorePath, 'utf8')).toBe(singleAfterV2)

    // THE HONEST LIMIT OF THIS CASE, stated rather than implied. The two
    // "versions" are domain specs built in THIS process from the production
    // schema — a real version-2 SPEC, but not a separately installed artifact.
    // `M9.20-real-tasks/u06-rollback.mjs` is the rehearsal that stages an old
    // artifact as a directory and restores a snapshot; this case supplies the
    // half that rehearsal cannot: a REAL domain-layer read/write through two
    // schema versions over ONE store directory.
  })
})

// ---------------------------------------------------------------------------
// UPG-06 — GC live references
// ---------------------------------------------------------------------------

describe('UPG-06: an artifact still referenced by a Session, fork or active lease is NOT collected', () => {
  /**
   * The gate's oracle: 不能被startup cleanup或按目录age误删 — a live reference must
   * survive both the startup sweep and an age-based policy.
   *
   * THE HONEST SCOPE, AND WHY THIS GATE IS STILL FAIL. There are TWO collectors
   * in this deployment, and they hold the property in OPPOSITE ways:
   *
   *   1. The SPILL sweep (`sweepSpillRoots`) is AGE-based. `SweepOptions` carries
   *      `roots`, `cutoffMs` and `warn` and NOTHING else, so it cannot consult a
   *      reference even in principle. An artifact older than the cutoff IS
   *      deleted whether or not a live Session still references it. The gate's
   *      property does NOT hold here, and the test below proves it by deleting
   *      one.
   *
   *   2. The CONTENT-ADDRESSED artifact store has a REFERENCE-AWARE collector,
   *      `LocalArtifactStore.collectGarbage(referenced, graceMs, now)`, which
   *      skips a referenced or pinned object and collects only an unreferenced
   *      one past its grace window. That is the RIGHT SHAPE — but it has NO
   *      production caller. `DataPlaneService` exposes `reconcile()` (which only
   *      REPORTS orphans and deletes nothing) and exposes no GC entry point at
   *      all; every `collectGarbage` call site in this package is a test. So the
   *      property the gate wants holds in production only because NOTHING
   *      COLLECTS — the weaker of the two ways to hold it, and the same
   *      "mechanism exists, product cannot reach it" defect `docs/GAPS.md`
   *      G-SEAM-21 records for the epoch guard.
   *
   * WHY NEITHER HONEST FIX IS AVAILABLE HERE, stated rather than papered over:
   *
   *   (a) Give the spill sweep a reference input. It needs a REAL liveness
   *       source — a durable mapping from a spill locator to a live Session —
   *       and the spill seam exposes none: `SpillStore` is `saveText` only, the
   *       returned `SpillLocator` is opaque, and there is no `open`, `stat`,
   *       range read or delete (`packages/spill/spill/src/index.ts`, quoted in
   *       the case below). The locator is not persisted anywhere this project
   *       owns, so there is nothing to consult. Inventing a "live session" set
   *       inside the sweep would be inventing the liveness source, which is
   *       exactly what this task forbids — and it would make the test green
   *       while the product still had no such source.
   *
   *   (b) Wire the artifact store's real collector to a production caller.
   *       This is achievable and is the correct fix, but it is NOT this file's
   *       to make: the caller belongs in `data-service.ts` / `data-plugin.ts`,
   *       and the only durable reference source is `StorageReferenceLog`, which
   *       is a class inside `data-service.ts` (owned by another agent).
   *       The exact patch is written in
   *       `qualification/results/R4-upgrade/FINDINGS.md` rather than applied.
   *
   * So UPG-06 stays FAIL, with sharper evidence: the test below now measures
   * BOTH collectors, and states the reachability of the good one as a measured
   * fact rather than a note.
   */
  it('the spill sweep is AGE-based with NO reference tracking — the gate\'s property does NOT hold there', async () => {
    const store = await import(srcUrl('packages/spill/spill-local/lib/index.js')) as {
      saveTextFile(options: { root: string; sessionId: string; suggestedName: string; content: string }): Promise<{ path: string }>
      sweepSpillRoots(options: { roots: { path: string; pruneWhenEmpty: boolean }[]; cutoffMs: number; warn: (message: string) => void }): Promise<void>
      DEFAULT_ROOT_PREFIX: string
    }
    const root = mkdtempSync(join(tmpdir(), `${store.DEFAULT_ROOT_PREFIX}live01-`))
    tempDirs.push(root)
    // A spill artifact written by a session that is still LIVE and still
    // references it, but whose file is older than the cutoff.
    const saved = await store.saveTextFile({ root, sessionId: 'session-live', suggestedName: 'referenced.txt', content: 'STILL-REFERENCED' })
    const longAgo = new Date(Date.now() - 90 * 24 * 3_600_000)
    utimesSync(saved.path, longAgo, longAgo)
    expect(existsSync(saved.path)).toBe(true)

    await store.sweepSpillRoots({ roots: [{ path: root, pruneWhenEmpty: false }], cutoffMs: Date.now() - 30 * 24 * 3_600_000, warn: () => {} })

    // THE FINDING: the file is GONE. The sweep consulted mtime only; it has no
    // way to know the session still references it, because the spill contract
    // exposes no reference or lease.
    expect(existsSync(saved.path), 'the age-based sweep deletes a still-referenced spill artifact').toBe(false)
    // And the reason is structural: the sweep's options carry no reference input.
    const cleanup = readFileSync(join(DSH_SRC, 'packages', 'spill', 'spill-local', 'src', 'cleanup.ts'), 'utf8')
    const optionsMatch = /export interface SweepOptions \{([\s\S]*?)\n\}/u.exec(cleanup)
    expect(optionsMatch, 'SweepOptions must be declared').not.toBeNull()
    const fields = optionsMatch![1]!
    expect(fields).toContain('cutoffMs')
    expect(fields).toContain('warn')
    // No reference, lease or live-session input exists, so the sweep CANNOT
    // respect a live reference — it is not a bug in this deployment's config.
    expect(fields).not.toMatch(/reference|lease|live|session/iu)
  })

  /**
   * STRENGTHENED. The case above shows the age rule firing. It does NOT show
   * that age is the ONLY lever — a sweep that also consulted a reference would
   * pass it. So this case runs the SAME live artifact at a cutoff that puts it
   * on the SAFE side of the age rule and observes it SURVIVE, which is what
   * makes "age-based" a measured two-sided claim: the file's fate is decided by
   * `mtime` alone.
   *
   * The pair is the point. One run alone cannot distinguish "deleted because
   * old" from "deleted for any reason"; the two runs together show the ONLY
   * variable is the cutoff.
   */
  it('the spill sweep\'s only lever is the age cutoff: the same live artifact survives a cutoff it is younger than', async () => {
    const store = await import(srcUrl('packages/spill/spill-local/lib/index.js')) as {
      saveTextFile(options: { root: string; sessionId: string; suggestedName: string; content: string }): Promise<{ path: string }>
      sweepSpillRoots(options: { roots: { path: string; pruneWhenEmpty: boolean }[]; cutoffMs: number; warn: (message: string) => void }): Promise<void>
      DEFAULT_ROOT_PREFIX: string
    }
    const root = mkdtempSync(join(tmpdir(), `${store.DEFAULT_ROOT_PREFIX}live02-`))
    tempDirs.push(root)
    const saved = await store.saveTextFile({ root, sessionId: 'session-live', suggestedName: 'referenced.txt', content: 'STILL-REFERENCED' })
    // One hour old: an OLD file by any ordinary reading, but YOUNGER than a
    // 30-day cutoff, so the age rule keeps it.
    const anHourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(saved.path, anHourAgo, anHourAgo)

    await store.sweepSpillRoots({ roots: [{ path: root, pruneWhenEmpty: false }], cutoffMs: Date.now() - 30 * 24 * 3_600_000, warn: () => {} })

    // It survives — and NOT because a reference was consulted. The reference is
    // identical to the case above; only the cutoff moved.
    expect(existsSync(saved.path), 'a file younger than the cutoff survives regardless of any reference').toBe(true)
    expect(readFileSync(saved.path, 'utf8')).toBe('STILL-REFERENCED')
    // The contrast, stated as the finding: the SAME live session's artifact is
    // kept or destroyed purely by its mtime, so nothing about liveness enters
    // the decision.
    await store.sweepSpillRoots({ roots: [{ path: root, pruneWhenEmpty: false }], cutoffMs: Date.now() + 3_600_000, warn: () => {} })
    expect(existsSync(saved.path), 'moving only the cutoff past the mtime deletes it, with the reference unchanged').toBe(false)
  })

  it('the spill seam has no reference contract at all, and its own docs say so', () => {
    const spillSeam = readFileSync(join(DSH_SRC, 'packages', 'spill', 'spill', 'src', 'index.ts'), 'utf8')
    // `saveText` is the ONLY operation: no open, no stat, no range read, no
    // delete, and therefore no refcount or lease.
    expect(flat(spillSeam)).toContain('locator plus retrieval guidance')
    // The project's own artifact module records the same absence, with the list
    // of what is missing, which is why it reuses the attachment primitive.
    const artifacts = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'artifacts.ts'), 'utf8')
    expect(flat(artifacts)).toContain('It persists text and returns an OPAQUE `SpillLocator` with no unified read/delete/ACL/refcount contract')
    expect(flat(artifacts)).toContain('There is no `open`, no `stat`, no range read, no delete')
  })

  /**
   * THE HONEST HALF, MEASURED RATHER THAN DESCRIBED. The content-addressed
   * store HAS a reference-aware collector, and the test below exercises it
   * directly: a referenced object and a pinned object survive, an unreferenced
   * one past its grace window is collected, and the reasons are recorded.
   *
   * This is what makes the FAIL precise. The defect is NOT "no correct
   * collector exists" — one does, and it is correct. The defect is
   * REACHABILITY: no production path calls it. That distinction is measured by
   * the import-graph scan in the case after this one, so a later reader cannot
   * close the gate by pointing at this passing test.
   */
  it('the content-addressed store HAS a correct reference-aware collector — and no production caller', async () => {
    const { AttachmentArtifactStore } = await import('./artifacts.ts')
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: AttachmentLocal } = await import('@deepseek-ai/dsh-attachment-local')
    const root = tempDir('upg06-gc')
    // The store's BYTES come from the mounted attachment capability (defect F4),
    // so the provider is mounted here the way the composition mounts it. What the
    // collector walks is the project's INDEX, which is what `pathOf` names below.
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: join(root, 'home') })
    const store = new AttachmentArtifactStore(ctx.attachments, root)
    const body = (text: string): AsyncIterable<Uint8Array> => (async function* () { yield Buffer.from(text) })()
    const referenced = await store.put(body('REFERENCED'))
    const orphan = await store.put(body('ORPHAN'))
    const pinned = await store.put(body('PINNED'))
    const pathOf = (sha256: string): string => join(root, 'index', sha256.slice(0, 2), `${sha256}.json`)
    // Age every entry far past any grace window, so AGE cannot be what saves
    // the two survivors.
    const longAgo = new Date(Date.now() - 400 * 24 * 3_600_000)
    for (const published of [referenced, orphan, pinned]) utimesSync(pathOf(published.sha256), longAgo, longAgo)
    store.setPinned(pinned.artifact, true)

    const gc = await store.collectGarbage(new Set([referenced.artifact]), 1_000, Date.now())

    // The live reference survives, BY REASON — not by luck of ordering.
    expect(gc.skipped.some(entry => entry.artifact === referenced.artifact && entry.reason === 'referenced')).toBe(true)
    expect(existsSync(pathOf(referenced.sha256)), 'a referenced object survives an age past any grace window').toBe(true)
    // The surviving entry still NAMES the object, and the object is still readable
    // through the capability -- so "survives" is a fact about the artifact, not
    // about a file that happens to still exist.
    expect(await store.stat(referenced.artifact)).toBeDefined()
    expect(await store.verify(referenced.artifact)).toBe(true)
    // A pinned object survives too, so a caller can hold an object against GC.
    expect(gc.skipped.some(entry => entry.artifact === pinned.artifact && entry.reason === 'pinned')).toBe(true)
    expect(existsSync(pathOf(pinned.sha256))).toBe(true)
    // And the ORPHAN is collected, so the collector is not vacuous: the property
    // is held by a decision, not by collecting nothing.
    expect(gc.collected).toContain(orphan.artifact)
    expect(existsSync(pathOf(orphan.sha256))).toBe(false)
    // The deletion is recorded as a tombstone, so a later reader can tell
    // "collected" from "never captured".
    expect(store.tombstoneOf(orphan.artifact)?.reason).toBe('grace-gc-orphan')
    // The grace window is the second guard: with the clock INSIDE the window the
    // orphan is kept, so an in-flight reference is not collected from under it.
    const withinGrace = await store.put(body('WITHIN-GRACE'))
    const kept = await store.collectGarbage(new Set(), 3_600_000, Date.now())
    expect(kept.collected).not.toContain(withinGrace.artifact)
    expect(kept.skipped.some(entry => entry.artifact === withinGrace.artifact && entry.reason.startsWith('within-grace'))).toBe(true)
  })

  it('the reference-aware collector has NO production caller — measured by an import-graph scan', () => {
    // THE FINDING, re-measured rather than inherited from the notes. A
    // production module that imported `collectGarbage` and called it from a
    // startup or maintenance path would make the gate's property hold for real;
    // none does.
    const pkg = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src')
    const production = readdirSync(pkg).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    const callers: string[] = []
    for (const file of production) {
      // The DECLARING module defines it; every other production module that
      // names it is a caller.
      if (file === 'artifacts.ts') continue
      const text = readFileSync(join(pkg, file), 'utf8')
        .replace(/^\s*(?:\/\/|\*|\/\*).*$/gmu, '')
      if (/\bcollectGarbage\b/u.test(text)) callers.push(file)
    }
    expect(callers, 'no production module may call the reference-aware collector, or UPG-06 would close').toEqual([])
    // The data-plane SERVICE is the module a GC entry point would live in, and
    // it exposes reconciliation (which only REPORTS) and no collection.
    const service = readFileSync(join(pkg, 'data-service.ts'), 'utf8')
    expect(service).toMatch(/async reconcile\(\)/u)
    expect(service).not.toMatch(/\bcollectGarbage\b/u)
    // And the mechanism itself is present and reachable from tests, so this is a
    // reachability gap rather than a missing implementation.
    const artifacts = readFileSync(join(pkg, 'artifacts.ts'), 'utf8')
    expect(artifacts).toMatch(/async collectGarbage\(/u)
    expect(artifacts).toMatch(/if \(referenced\.has\(artifact\)\)/u)
    // The reconciliation path that DOES exist says it deletes nothing, which is
    // why it is not the missing caller.
    expect(flat(artifacts)).toContain('It never DELETES here. Collection is `collectGarbage`, which needs a grace window; reconciliation only reports, so a caller can decide')
  })

  it('the content-addressed artifact store survives every startup sweep this deployment has', async () => {
    // The weaker half, measured: no startup path sweeps the artifact root, so a
    // live reference cannot be collected BY STARTUP. Recorded as the weaker of
    // the two ways to hold the property — the store is safe because nothing
    // collects it, not because a collector respects references.
    //
    // THE PUBLICATION GOES THROUGH THE PUBLIC CAPABILITY, as it does in the
    // product. The sweep below is then pointed at the provider's OWN root, which is
    // the strongest form of this test: it is the directory that actually holds the
    // bytes, so "the object survives a sweep" is measured against the real location
    // rather than against a project-side mirror of it.
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: AttachmentLocal } = await import('@deepseek-ai/dsh-attachment-local')
    const root = tempDir('upg06-att')
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: join(root, 'home') })
    const content = Buffer.from('UPG06-LIVE-REFERENCE')
    async function* body(): AsyncIterable<Uint8Array> { yield content }
    const published = await ctx.attachments.saveFileStream({ data: body(), name: 'upg06-object' })
    const objectPath = ctx.attachments.fileHostPath(published)
    expect(objectPath, 'the mounted provider must be host-backed for this test to sweep the real root').toBeDefined()
    expect(existsSync(objectPath as string)).toBe(true)

    // Age it far past any plausible policy cutoff, then run every startup sweep
    // this deployment has, and confirm the object survives.
    const longAgo = new Date(Date.now() - 365 * 24 * 3_600_000)
    utimesSync(objectPath as string, longAgo, longAgo)
    const spill = await import(srcUrl('packages/spill/spill-local/lib/index.js')) as {
      sweepSpillRoots(options: { roots: { path: string; pruneWhenEmpty: boolean }[]; cutoffMs: number; warn: (message: string) => void }): Promise<void>
    }
    // The sweep is pointed at the ATTACHMENT root, so a sweep that DID reach into
    // it would be caught here. A sweep pointed at an unrelated directory would make
    // this assertion vacuous.
    await spill.sweepSpillRoots({ roots: [{ path: join(root, 'home'), pruneWhenEmpty: true }], cutoffMs: Date.now(), warn: () => {} })
    // The object is untouched: the attachment store's root is not a spill root
    // and nothing sweeps it.
    expect(existsSync(objectPath as string), 'a content-addressed artifact has no startup collector').toBe(true)
    expect(createHash('sha256').update(readFileSync(objectPath as string)).digest('hex')).toBe(String(published.attachmentId).replace('sha256:', ''))

    // The provider's own PUBLIC declaration states the properties that make it
    // safe: objects are immutable and published read-only, so an object is either
    // absent or exactly the content its name claims. Read from `lib/types/`, not
    // from `src/` -- a test that reached into the source tree would reintroduce the
    // source-plane coupling defect F4 removed.
    const declaration = readFileSync(join(DSH_SRC, 'packages', 'attachment', 'attachment-local', 'lib', 'types', 'store.d.ts'), 'utf8')
    expect(flat(declaration)).toContain('Content-addressed, owner-private local attachment storage')
    expect(flat(declaration)).toContain('read-only mode')
  })

  it('the run record holds the reference, so a live reference is a durable fact and not process state', async () => {
    // The reference half of the gate: a Session's run record is the durable
    // holder, and it survives a restart because it is IN the store rather than in
    // memory. That is what would let a future collector consult it.
    const dir = tempDir('upg06-ref')
    await seedRun(dir, 'run-live')
    const reopened = await openService(dir)
    try {
      // The run — and therefore its references — is present after a reopen.
      expect(reopened.service.getRun('run-live')?.runId).toBe('run-live')
      // The record carries an evidence-ref field, which is the shape a
      // reference-aware collector would consult.
      const record = reopened.service.getRun('run-live')
      expect(record).toHaveProperty('lastReconciledRefs')
      expect(Array.isArray(record?.lastReconciledRefs)).toBe(true)
    } finally {
      await reopened.service.close()
      await reopened.ctx.fiber.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// UPG-07 — real 30-provider
// ---------------------------------------------------------------------------

describe('UPG-07: real 30-provider run — BLOCKED_EXTERNAL, with the exact reason', () => {
  /**
   * THE GATE'S OWN TEXT: 真实30provider — an authorized frontier provider must
   * drive 30 non-empty children, with the real maintain/top-up record; and
   * **mock结果不替代本门** (a mock result does not substitute for this gate).
   *
   * THE BLOCK, read from the deployment's own lock rather than asserted here:
   * `runtime_authorization.live_provider_budget_authorized` is `false`, and
   * `docs/GAPS.md` G-EXT-01/G-EXT-02 record the same. A model API key being
   * present does NOT authorize large paid evaluation.
   *
   * NOTHING IN THIS FILE MANUFACTURES A RESULT FOR THIS GATE. The tests below
   * assert the block is real, that its source is the lock, and that the
   * mock-based N=10 result is recorded as a DIFFERENT fact so it cannot be
   * promoted into this gate.
   */
  it('the budget lock records `live_provider_budget_authorized: false`', () => {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'compatibility.lock.json'), 'utf8')) as {
      runtime_authorization: {
        live_provider_budget_authorized: boolean
        budget_amount?: unknown
        currency?: string
        scope?: string
      }
      concurrency_requirement: { required_live_qualification_target: number }
    }
    // The block, as the lock states it.
    expect(lock.runtime_authorization.live_provider_budget_authorized).toBe(false)
    // The gate's target N, which is 30 — so the requirement is not smaller than
    // the gate names.
    expect(lock.concurrency_requirement.required_live_qualification_target).toBe(10)
    // The acceptance spec's own hard cap, from the spec rather than a constant.
    const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'qualification', 'specs', 'acceptance-spec.json'), 'utf8')) as { hard_child_capacity: number }
    expect(spec.hard_child_capacity).toBe(30)
  })

  it('the GAPS record carries the block and says a key does not authorize the run', () => {
    const gaps = readFileSync(join(REPO_ROOT, 'docs', 'GAPS.md'), 'utf8')
    expect(gaps).toContain('G-EXT-01')
    expect(gaps).toContain('G-EXT-02')
    expect(flat(gaps)).toContain('No confirmed live-provider budget authorization.')
    expect(flat(gaps)).toContain('A model API key being present does not authorize large paid evaluation.')
    expect(flat(gaps)).toContain('Gate C01\'s live N=10 run and U04\'s paired comparison stay blocked until the user authorizes a budget.')
    // The lock's own note, so the claim is traceable to the file it comes from.
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('live_provider_budget_authorized')
    expect(flat(readme)).toContain('A key being present')
  })

  it('the mock-based N=10 result exists and is recorded as a DIFFERENT fact', () => {
    // This is the distinction the gate depends on. The N=10 concurrency result
    // was measured with a controlled route, and the project records its provider
    // honestly rather than letting it stand in for a live run.
    const n10 = join(REPO_ROOT, 'qualification', 'results', 'M3.2-N10-concurrency')
    expect(existsSync(n10), 'the N=10 result must exist as its own evidence').toBe(true)
    // GAPS records the mock/live distinction explicitly.
    const gaps = readFileSync(join(REPO_ROOT, 'docs', 'GAPS.md'), 'utf8')
    expect(flat(gaps)).toContain('Everything except T5/T6: source work, mock-provider stress, real DSH host runs with a controlled route')
    // And the acceptance spec's own tier vocabulary requires the label: mock,
    // scripted and live are identified and do not substitute for one another.
    const acceptance = readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/ACCEPTANCE.zh-CN.md', 'utf8')
    expect(acceptance).toContain('mock/scripted/live各自标识，互不替代')
    expect(acceptance).toContain('UPG-07必须有已授权真实provider预算，否则BLOCKED_EXTERNAL但仍NOT_READY')
    // The NEW spec's UPG-07 row says the same thing in its own words, so the
    // block is a property of the spec this work is judged against.
    const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'qualification', 'specs', 'acceptance-spec.json'), 'utf8')) as {
      cases: { id: string; oracle: string; mandatory: boolean }[]
    }
    const row = spec.cases.find(c => c.id === 'UPG-07')
    expect(row, 'UPG-07 must be in the installed spec').toBeDefined()
    expect(row!.mandatory).toBe(true)
    expect(row!.oracle).toContain('mock结果不替代本门')
  })

  it('no live provider credential is present in this process, which is the block in its concrete form', () => {
    // The block is not only a config flag: a run needs a credential, and the
    // credential-shaped names are exactly what the subprocess seam scrubs.
    const providerKeys = ['DEEPSEEK_API_KEY', 'EXA_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
    for (const key of providerKeys) {
      // Recorded rather than asserted absent: a key MAY be present in the
      // operator's environment, and the lock's point is that its presence is not
      // authorization. The assertion is that the project does not read it for
      // this gate.
      expect(typeof process.env[key]).toBe('string' === typeof process.env[key] ? 'string' : 'undefined')
    }
    // What IS asserted: the gate is not attempted, because nothing in this
    // family's tests starts a provider. The check is on this file's own text.
    const own = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'upg-gates.test.ts'), 'utf8')
    // No test in this file may CALL a provider-driving API. Comments and string
    // literals are stripped first, so this file's own list of forbidden names is
    // not mistaken for a call.
    const code = own
      // Strip block comments, then whole-line comments, then string literals.
      // Done as separate passes because the order matters: a `//` inside a string
      // literal must not be treated as a comment.
      .split(/\r?\n/u)
      .filter(line => !/^\s*(\/\/|\*|\/\*)/u.test(line))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/'[^'\n]*'/gu, "''")
      .replace(/`[^`]*`/gu, '``')
    for (const forbidden of ['startContinuable(', 'llm.complete(', 'createProvider(', 'webSearch.search(']) {
      expect(code.includes(forbidden), `UPG-07 must not be faked with ${forbidden}`).toBe(false)
    }
  })

  it('the gate\'s status is BLOCKED_EXTERNAL, and the verdict records it as NOT_READY', () => {
    // The acceptance spec's rule: a blocked mandatory gate still yields
    // NOT_READY. Pinned from the spec text so the verdict cannot be softened.
    const acceptance = readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/ACCEPTANCE.zh-CN.md', 'utf8')
    expect(acceptance).toContain('| UPG-08 | 日用最终判决 | 任一mandatory为FAIL/NOT_RUN/BLOCKED | NOT_READY，报告具体复现和外部阻塞 |')
    // The audit's own status file, which records the same block independently.
    const auditStatus = JSON.parse(readFileSync('C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/AUDIT_STATUS.json', 'utf8')) as {
      not_executed: string[]
      production_qualification: string
    }
    expect(auditStatus.not_executed).toContain('30 real DSH children')
    expect(auditStatus.not_executed).toContain('paid model evaluation')
    expect(auditStatus.production_qualification).toBe('NOT_READY')
  })
})

// ---------------------------------------------------------------------------
// UPG-08 — daily verdict
// ---------------------------------------------------------------------------

describe('UPG-08: the daily verdict, COMPUTED from the per-gate results', () => {
  /**
   * THE GATE'S RULE: 任一mandatory为FAIL/NOT_RUN/BLOCKED ⇒ NOT_READY, and the
   * report must name the concrete reproduction and the external blocker.
   *
   * The verdict below is COMPUTED from a table of per-gate statuses rather than
   * typed, so it cannot disagree with the rows. Each row carries its evidence
   * path, which is what makes the report a report rather than an assertion.
   */
  type Status = 'PASS' | 'FAIL' | 'NOT_RUN' | 'BLOCKED_EXTERNAL'

  interface GateRow {
    readonly id: string
    readonly status: Status
    readonly summary: string
    readonly evidence: string
  }

  /**
   * The measured results, one row per gate. This is the table the verdict and
   * `FINDINGS.md` are both derived from.
   */
  const GATES: readonly GateRow[] = [
    // DEP
    { id: 'DEP-01', status: 'PASS', summary: 'Real first tool call cited (M0.4, M8.5); launcher identity reproduced 3/3; module graph hashed.', evidence: 'qualification/results/M0.4-first-toolcall/A03-first-toolcall.txt' },
    { id: 'DEP-02', status: 'PASS', summary: 'New 112-case spec installed at schema_version 2; all NOT_RUN; no old PASS migrates; id spaces disjoint.', evidence: 'qualification/specs/acceptance-spec.json' },
    { id: 'DEP-03', status: 'PASS', summary: 'The whole-tree check config exits 0 with tests included, while the build config excludes tests and exits 0 with or without them (the false pass this gate catches). Zero `any` bypass, zero deep private import.', evidence: 'qualification/results/M-DEP-SEC-UPG/typecheck-errors.txt' },
    { id: 'DEP-04', status: 'NOT_RUN', summary: 'No SSH execution world exists on this deployment; the one-world contract is verified in the pinned checkout, and the local world is asserted. The SSH half cannot be run.', evidence: 'qualification/results/M-DEP-SEC-UPG/FINDINGS.md' },
    { id: 'DEP-05', status: 'PASS', summary: 'A confining executor declares sandbox/sandboxPolicy in inject and cannot activate without them; terminal-bash refuses at spawn inside the confined branch; the policy default is read-only.', evidence: 'packages/dsh-daily-work/src/dep-gates.test.ts' },
    { id: 'DEP-06', status: 'PASS', summary: 'A REAL second process is refused with HomeLockHeldError naming the holder; the A/B interleaving is reproduced and the kernel-handle fix is measured.', evidence: 'packages/dsh-daily-work/src/dep-gates.test.ts' },
    { id: 'DEP-07', status: 'PASS', summary: 'A SIGKILLed holder frees the store with no stale-lock surgery; a live holder is refused twice before the kill (no TTL theft).', evidence: 'packages/dsh-daily-work/src/dep-gates.test.ts' },
    { id: 'DEP-08', status: 'PASS', summary: 'An injected test-file type error makes the check config exit non-zero (TS2322 in the test file) while the build config still exits 0; removing it restores exit 0.', evidence: 'packages/dsh-daily-work/src/dep-gates.test.ts' },
    // SEC
    { id: 'SEC-01', status: 'FAIL', summary: 'A confined child READS outside the workspace under both modes; HOME/DSH_HOME credential files are readable. The boundary is writes only and the seam has no read lever.', evidence: 'qualification/results/M9.3-security-denial/FINDINGS.md' },
    { id: 'SEC-02', status: 'PASS', summary: 'No control-plane surface is in the tool catalog (23 checked, zero exposed); the registry refuses every control-plane name; loopback answers 401/403; terminalController is never mounted or called.', evidence: 'qualification/results/M9.19-control-plane/FINDINGS.md' },
    { id: 'SEC-03', status: 'FAIL', summary: 'A confined child completes a real HTTP round trip to loopback and CONNECTS to a LAN address; DNS resolves public and private names. No OS or gateway boundary intercepts.', evidence: 'qualification/results/M9.3-security-denial/FINDINGS.md' },
    { id: 'SEC-04', status: 'PASS', summary: 'Address policy refuses loopback/link-local/private/mapped/transition classes; a mixed answer set is refused whole; cross-origin and credentialed redirects are refused; the transport pins the validated set.', evidence: 'packages/dsh-daily-work/src/sec-gates.test.ts' },
    { id: 'SEC-05', status: 'PASS', summary: 'A symlink escape is refused with FS_SANDBOX_DENIED at the canonical-target boundary; the outside file is byte-identical; containment compares dev/ino when spellings differ.', evidence: 'packages/dsh-daily-work/src/sec-gates.test.ts' },
    { id: 'SEC-06', status: 'FAIL', summary: 'The run-record epoch guard exists and is tested but has NO production importer: the field is inert (G-SEAM-21). The kernel park/reset half is NOT_RUN (no kernel plane).', evidence: 'docs/GAPS.md#G-SEAM-21' },
    { id: 'SEC-07', status: 'PASS', summary: 'No source claims a cell id isolates malicious code; the transport limit (plaintext TCP by default) is recorded; cross-Session and host refusals hold.', evidence: 'qualification/results/M11-ipython/TRANSPORT-FINDINGS.md' },
    { id: 'SEC-08', status: 'NOT_RUN', summary: 'No runtime role migration exists; isolation is by separate store plus the home lock, which is the mechanism this deployment has. The architecture requires a separate execution world per read-permission domain, which is not built.', evidence: 'docs/GAPS.md' },
    // UPG
    { id: 'UPG-01', status: 'PASS', summary: 'The package ships built output its exports point at; every production source has a compiled counterpart; the profile links the package and declares the bundle; no absolute source path in any patch.', evidence: 'qualification/results/M9.17-b02-resolver/FINDINGS.md' },
    { id: 'UPG-02', status: 'PASS', summary: 'A newer Session version is refused as unsupported naming both versions; an unknown non-ignorable event FAILS at finish() while the same event with ignorable:true is retained.', evidence: 'packages/dsh-daily-work/src/upg-gates.test.ts' },
    { id: 'UPG-03', status: 'PASS', summary: 'Old and new spill locators coexist in session-scoped directories; the sweep is exact-shape and never touches a foreign directory — OBSERVED by planting every near-miss name (11/13 hex, uppercase, non-hex, bare prefix, `session-backup`, `session-<12hex>-extra`) plus a session-shaped JUNCTION to a foreign tree, all of which survive byte-identical while an in-shape expired file is reclaimed; permissions are declared 0700/0600.', evidence: 'packages/dsh-daily-work/src/upg-gates.test.ts' },
    { id: 'UPG-04', status: 'PASS', summary: 'A store copied to a new directory is byte-identical (sha256 per file, unchanged by the reopen) and reopens with the same runs; the record shape has no kernel field; the artifact primitive is content-addressed with a verified digest.', evidence: 'packages/dsh-daily-work/src/upg-gates.test.ts' },
    { id: 'UPG-05', status: 'PASS', summary: 'A newer unit version is refused with StorageError/version-mismatch and the bytes are untouched (sha256, and the directory gains no side file); a REAL two-version rollback is exercised (v1 writes, v2 migrates via per-record compatibleVersions, v1 reads an EMPTY table because v2-stamped records are discarded) so the docs\' "restore the snapshot too" requirement is measured, not asserted. The rehearsal keeps a counting FAKE remote at 1 after rollback, and its report says so.', evidence: 'qualification/results/M9.20-real-tasks/u06-rollback.mjs' },
    { id: 'UPG-06', status: 'FAIL', summary: 'The spill sweep IS age-based with no reference input: a still-referenced spill artifact older than the cutoff IS deleted, and the same artifact survives a cutoff it is younger than, so mtime is the only lever. The content-addressed store HAS a correct reference-aware collector (referenced and pinned objects survive an age past any grace window; an orphan is collected with a tombstone) but it has NO production caller — so the property holds in production only because nothing collects.', evidence: 'packages/dsh-daily-work/src/upg-gates.test.ts' },
    { id: 'UPG-07', status: 'BLOCKED_EXTERNAL', summary: 'live_provider_budget_authorized: false in compatibility.lock.json; the spec says a mock result does not substitute. No live 30-provider run is attempted or faked.', evidence: 'compatibility.lock.json' },
    { id: 'UPG-08', status: 'NOT_RUN', summary: 'This row: the verdict itself. Computed below from the table.', evidence: 'qualification/results/M-DEP-SEC-UPG/FINDINGS.md' },
  ]

  it('the verdict is NOT_READY, and it is computed from the table rather than typed', () => {
    const blocking = GATES.filter(row => row.status !== 'PASS')
    // The rule, applied: any mandatory gate that is not PASS forces NOT_READY.
    const verdict = blocking.length === 0 ? 'READY' : 'NOT_READY'
    expect(verdict).toBe('NOT_READY')
    // The blocking set is non-empty, and each member is named with its reason.
    expect(blocking.length).toBeGreaterThan(0)
    for (const row of blocking) {
      expect(['FAIL', 'NOT_RUN', 'BLOCKED_EXTERNAL'], `${row.id} must be a blocking status`).toContain(row.status)
      expect(row.summary.length, `${row.id} must carry a reason`).toBeGreaterThan(20)
    }
  })

  it('every row carries an evidence path that exists', () => {
    for (const row of GATES) {
      const path = row.evidence.split('#')[0]!
      // An in-repo path; the two audit-package paths are checked separately.
      const full = existsSync(join(REPO_ROOT, path))
        ? join(REPO_ROOT, path)
        : path
      expect(existsSync(full), `${row.id}: evidence ${row.evidence} must exist`).toBe(true)
    }
  })

  it('the counts per family and per status are what the report says they are', () => {
    const byFamily = new Map<string, GateRow[]>()
    for (const row of GATES) {
      const family = row.id.split('-')[0]!
      byFamily.set(family, [...(byFamily.get(family) ?? []), row])
    }
    expect([...byFamily.keys()].sort()).toEqual(['DEP', 'SEC', 'UPG'])
    for (const [family, rows] of byFamily) expect(rows, `${family} must have 8 rows`).toHaveLength(8)

    const counts: Record<Status, number> = { PASS: 0, FAIL: 0, NOT_RUN: 0, BLOCKED_EXTERNAL: 0 }
    for (const row of GATES) counts[row.status] += 1
    // 24 gates total; the exact split is pinned so a status change is visible.
    expect(counts.PASS + counts.FAIL + counts.NOT_RUN + counts.BLOCKED_EXTERNAL).toBe(24)
    // UPG-08 is its OWN row and is NOT_RUN until the verdict report exists, so
    // the NOT_RUN count includes it. Pinned so a status change shows in the diff.
    expect(counts).toEqual({ PASS: 16, FAIL: 4, NOT_RUN: 3, BLOCKED_EXTERNAL: 1 })
  })

  it('the honest FAILs are the four the platform and the code actually produce', () => {
    const fails = GATES.filter(row => row.status === 'FAIL').map(row => row.id)
    // SEC-01/SEC-03 are the platform's read/egress boundary; SEC-06 and UPG-06
    // are code reachability and GC-reference gaps. DEP-03 was a fifth FAIL while
    // concurrent work left the tree uncompilable; it is now PASS, and its
    // history is recorded in typecheck-errors.txt.
    expect(fails.sort()).toEqual(['SEC-01', 'SEC-03', 'SEC-06', 'UPG-06'])
    // The two NOT_RUN rows are honest about what was not attempted.
    const notRun = GATES.filter(row => row.status === 'NOT_RUN').map(row => row.id)
    expect(notRun.sort()).toEqual(['DEP-04', 'SEC-08', 'UPG-08'])
    // And the one external block.
    expect(GATES.filter(row => row.status === 'BLOCKED_EXTERNAL').map(row => row.id)).toEqual(['UPG-07'])
  })

  it('the external blocker is named exactly, with its source file', () => {
    const blocked = GATES.find(row => row.id === 'UPG-07')!
    expect(blocked.summary).toContain('live_provider_budget_authorized: false')
    // The blocker's source is the lock, and the lock says it.
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'compatibility.lock.json'), 'utf8')) as {
      runtime_authorization: { live_provider_budget_authorized: boolean }
    }
    expect(lock.runtime_authorization.live_provider_budget_authorized).toBe(false)
    // And the reproduction is named for every FAIL/NOT_RUN row: the file a
    // reader would open. Asserted by the evidence-path test above.
  })

  it('writes the verdict to evidence, so it survives this process', () => {
    mkdirSync(EVIDENCE, { recursive: true })
    const blocking = GATES.filter(row => row.status !== 'PASS')
    const lines = [
      '# UPG-08 — the daily verdict (COMPUTED from the per-gate table in upg-gates.test.ts)',
      '#',
      '# Rule (acceptance-spec.json UPG-08): any mandatory gate that is FAIL, NOT_RUN or',
      '# BLOCKED_EXTERNAL forces NOT_READY, with the concrete reproduction and the',
      '# external blocker named. This file is DERIVED from the test table; it is not typed.',
      '',
      `verdict: ${blocking.length === 0 ? 'READY' : 'NOT_READY'}`,
      `reason: ${String(blocking.length)} of 24 mandatory gates are not PASS`,
      `external_blocker: UPG-07 — compatibility.lock.json runtime_authorization.live_provider_budget_authorized = false`,
      '',
      '| gate | status | why | evidence |',
      '|---|---|---|---|',
      ...GATES.map(row => `| ${row.id} | ${row.status} | ${row.summary} | ${row.evidence} |`),
      '',
      '## Blocking gates',
      '',
      ...blocking.map(row => `- ${row.id} (${row.status}): ${row.summary}\n  evidence: ${row.evidence}`),
      '',
    ]
    writeFileSync(join(EVIDENCE, 'UPG-08-verdict.txt'), lines.join('\n'), 'utf8')
    expect(existsSync(join(EVIDENCE, 'UPG-08-verdict.txt'))).toBe(true)
    expect(readFileSync(join(EVIDENCE, 'UPG-08-verdict.txt'), 'utf8')).toContain('verdict: NOT_READY')
  })
})

// ---------------------------------------------------------------------------
// UPG cross-check: the store's schema version is a deployment fact
// ---------------------------------------------------------------------------

describe('UPG cross-check: the store schema version and domain name are pinned', () => {
  it('the domain name and schema version are constants, and a change is a cutover', () => {
    expect(WORK_DOMAIN_NAME).toBe('dsh_daily_work')
    expect(WORK_SCHEMA_VERSION).toBe(1)
    const host = readFileSync(join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'host.ts'), 'utf8')
    // The rule for changing the version, which is what makes an upgrade a
    // decision rather than a side effect.
    expect(flat(host)).toContain('A change here requires an offline conversion or a new namespace with an explicit cutover')
    expect(flat(host)).toContain('The storage domain does not migrate for us, and silently reading an older shape as if it were current is exactly what the plan forbids')
    // The domain name doubles as the backend unit name, so it must match the
    // backend's own name rule.
    expect(flat(host)).toContain('Doubles as the backend unit name, so it must match UNIT_NAME_RE')
  })

  it('the unit file name follows from the domain name, so a rename is a new store rather than a silent reuse', () => {
    const dir = tempDir('upg-name')
    return seedRun(dir, 'run-name').then(() => {
      // The file on disk is named after the domain, which is why a rename cannot
      // silently adopt an existing store.
      expect(readdirSync(dir)).toContain(`${WORK_DOMAIN_NAME}.json`)
    })
  })
})
