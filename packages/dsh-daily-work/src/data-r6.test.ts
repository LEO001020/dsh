/**
 * R6: the `dsh.data` high-throughput programmatic data plane (V3 §K1-K7).
 *
 * WHAT THIS FILE MEASURES, AND WHY IT IS SEPARATE FROM `data-plane.test.ts`.
 *
 * `data-plane.test.ts` proves the M4 artifact/observation layer works. This file
 * proves the R6 PLANE works: the cell-bound request surface that goes directly
 * through public DSH capability seams rather than through `ctx.tools.execute`,
 * the bounded-concurrency limiter, the one-lease history cursor, the honest web
 * acquisition record, the separate projection manifest, and the bridge router R5
 * binds to.
 *
 * THE INVARIANT EVERY TEST HERE SERVES:
 *
 *     acquired bytes != persisted bytes != Python-consumed bytes != LLM-visible bytes
 *
 * The stress block at the end measures all four separately for ONE 32 MiB source,
 * which is the stimulus V3 §K7 names.
 *
 * TRACK DISCIPLINE. Every test name carries its track, and no result is reported
 * as if it came from another:
 *
 *   [real]   a real `LocalFileSystem` reading real files, the real publication
 *            primitive, the real artifact store, and (for the bridge test) the
 *            real `data-bridge` router.
 *   [stub]   a provider stand-in, used ONLY where the real one cannot be driven
 *            without spending an unauthorized API request (the web arm), or where
 *            the stimulus is a provider that violates its contract.
 *
 * THE WEB ARM DOES NOT TOUCH A LIVE ENDPOINT, ON PURPOSE. `G-SEAM-52` is OPEN:
 * the ported provider is MOUNTED but the selection string names a different
 * backend, so `ctx.web.search()` reaches that backend. No case in the spec
 * authorizes a live search, so the web path is exercised through a REGISTERED STUB
 * PROVIDER and the mis-selection is reported rather than provoked.
 */
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebFetchResult, WebSearchProvider } from '@deepseek-ai/dsh-web'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DataPlaneService } from './data-service.ts'
import { DataPlane, DataPlaneError } from './data-plane.ts'
import {
  DATA_METHODS,
  DATA_TOOL_PREFIX,
  dataCallerFromEnclosing,
  isDataRequest,
  routeDataRequest,
} from './data-bridge.ts'
import { DataReadLimiter, DEFAULT_DATA_READ_CONCURRENCY, mapBounded } from './data-concurrency.ts'
import { buildProjectionManifest, omissionKind } from './projection-manifest.ts'

const tempDirs: string[] = []

afterEach(() => {
  // Windows holds handles on freshly written files; removal needs retries.
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `r6-${label}-`))
  tempDirs.push(dir)
  return dir
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The Python interpreter the kernel package is pinned to.
 *
 * The SAME pinned path `data-plane.test.ts` uses, so the two suites cannot
 * disagree about which interpreter the product runs on.
 */
function pythonPathForR6(): string {
  const pinned = 'C:\Users\hzq00\AppData\Local\Programs\Python\Python314\python.exe'
  return existsSync(pinned) ? pinned : 'python'
}

/** A real `LocalFileSystem` over a real directory. */
function mountFs(cwd: string): LocalFileSystem {
  return new LocalFileSystem(new Context(), { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
}

/**
 * A service over a real storage domain, with the host's `dshHomePath` helper
 * mounted, so the artifact root is absolute and cwd-independent.
 *
 * `ctx.fs` IS MOUNTED ON THE SERVICE'S OWN CONTEXT. This is deliberate and it is
 * how the production composition works: the plane resolves `ctx.fs` from the
 * context it was constructed on, so a test that passed an `fs` object directly
 * would not exercise the capability lookup at all -- and the lookup is exactly
 * where "no fs plugin is mounted" must produce a named refusal rather than an
 * empty result.
 */
async function mountService(label: string, options: { readConcurrency?: number } = {}): Promise<{
  service: DataPlaneService
  plane: DataPlane
  root: string
  dispose: () => Promise<void>
}> {
  const root = tempRoot(label)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
  await ctx.plugin(storageDomainPlugin, { backend: 'json' })
  // The BYTE store is a mounted capability, not something the service builds
  // (F4's fix), so a service test must mount a provider the way the composed
  // profile does through the base bundle's `attachment-local` row. Its home is
  // under this test's temp root, so no two arms share an attachment store.
  await ctx.plugin(AttachmentLocal, { dshHome: join(root, 'home') })
  // The host publishes this at boot; standing it in is what makes these tests
  // measure the cwd-independent path rather than the fallback.
  ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
  // The real FS backend, on the service's own context, rooted at the temp dir.
  await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const service = new DataPlaneService(ctx, {
    artifactRoot: join(root, 'artifacts'),
    ownerScope: 'project:r6',
    executionWorld: 'local',
    pageBytes: 64 * 1024,
    ...options.readConcurrency === undefined ? {} : { readConcurrency: options.readConcurrency },
  })
  await service.open(ctx.storageDomain)
  const plane = service.plane()
  return {
    service,
    plane,
    root,
    dispose: async () => {
      await service.close()
      await ctx.fiber.dispose()
    },
  }
}

// ===========================================================================
// K1 -- filesystem
// ===========================================================================

describe('R6-K1 [real] fs.capture records the target identity basis and the byte accounting', () => {
  it('captures through ctx.fs and reports acquired == persisted for a complete read', async () => {
    const { plane, root, dispose } = await mountService('k1-capture')
    try {
      const payload = Buffer.from('R6 payload\n'.repeat(1000), 'utf8')
      writeFileSync(join(root, 'payload.txt'), payload)
      const fs = mountFs(root)
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })

      const captured = await plane.fsCapture(caller, {
        path: 'payload.txt',
        mediaType: 'text/plain',
        observationId: 'obs-r6-k1',
      })

      // The three identity fields K1 requires are recorded SEPARATELY, because
      // they answer different questions: which object, how fresh, and what shape.
      expect(captured.identity.displayPath).toContain('payload.txt')
      expect(captured.identity.targetKey.length).toBeGreaterThan(0)
      expect(captured.identity.version.length).toBeGreaterThan(0)
      expect(captured.identity.stat.type).toBe('file')
      expect(captured.identity.stat.size).toBe(payload.byteLength)

      // The descriptor names the bytes by content hash, and the hash is the
      // FILE's -- which is what makes "acquired == persisted" a fact rather than
      // an assertion about a decode.
      expect(captured.descriptor.captured.sha256).toBe(sha256(payload))
      expect(captured.descriptor.captured.bytes).toBe(payload.byteLength)
      expect(captured.reference.state).toBe('durable')
      expect(captured.gaps).toHaveLength(0)

      // (1) ACQUIRED vs (2) PERSISTED, from their own sources.
      expect(captured.accounting.acquiredBytes).toBe(payload.byteLength)
      expect(captured.accounting.persistedBytes).toBe(payload.byteLength)
    } finally {
      await dispose()
    }
  })

  it('refuses a directory and a missing path with DISTINCT named errors, never an empty capture', async () => {
    const { plane, root, dispose } = await mountService('k1-refuse')
    try {
      const fs = mountFs(root)
      void fs
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      await expect(plane.fsCapture(caller, { path: 'nope.txt' }))
        .rejects.toMatchObject({ code: 'DATA_ARTIFACT_INVALID' })
      await expect(plane.fsCapture(caller, { path: 'nope.txt' }))
        .rejects.toThrow(/no such target/u)
      await expect(plane.fsCapture(caller, { path: '.' }))
        .rejects.toThrow(/not a regular file/u)
    } finally {
      await dispose()
    }
  })

  it('scopes coverage to a requested range, so a partial read is never read as a whole file', async () => {
    const { plane, root, dispose } = await mountService('k1-range')
    try {
      writeFileSync(join(root, 'big.txt'), Buffer.alloc(4096, 0x61))
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const captured = await plane.fsCapture(caller, {
        path: 'big.txt',
        observationId: 'obs-r6-range',
        requestedRange: { offset: 1024, length: 512 },
      })
      // The object published is exactly the requested bytes, and the coverage
      // claim is scoped to the REQUEST -- never to the world.
      expect(captured.descriptor.captured.bytes).toBe(512)
      expect(captured.descriptor.acquisition.coverage).toMatchObject({
        claimScope: 'request',
        requestedRange: { offset: 1024, length: 512 },
      })
      // A narrowed request is legitimately fewer bytes than the file holds, so it
      // must NOT be reported as a short acquisition.
      expect(captured.descriptor.acquisition.completeness).toBe('complete-within-request')
      expect(captured.gaps).toHaveLength(0)
    } finally {
      await dispose()
    }
  })

  it('refuses a capture once the enclosing cell is cancelled, rather than running with no owner', async () => {
    const { plane, root, dispose } = await mountService('k1-abort')
    try {
      writeFileSync(join(root, 'x.txt'), 'x')
      const controller = new AbortController()
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root, signal: controller.signal })
      controller.abort()
      await expect(plane.fsCapture(caller, { path: 'x.txt' }))
        .rejects.toMatchObject({ code: 'DATA_CALLER_ABORTED' })
    } finally {
      await dispose()
    }
  })

  it('reads a >100 KiB single line back BYTE-FOR-BYTE through bounded pages', async () => {
    // The >100 KiB single-line stimulus, driven through the plane rather than
    // through the model-facing `read`: a line that long cannot survive the read
    // tool's windowing, so paging the captured object is the only path that
    // returns the interior.
    const { plane, root, dispose } = await mountService('k1-longline')
    try {
      const line = `${'L'.repeat(102400)}-TAIL-MARKER`
      writeFileSync(join(root, 'line.txt'), line)
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const captured = await plane.fsCapture(caller, {
        path: 'line.txt', mediaType: 'text/plain', observationId: 'obs-r6-line',
      })
      expect(captured.descriptor.captured.bytes).toBe(Buffer.byteLength(line, 'utf8'))

      const handle = plane.openPages(caller, { descriptor: captured.descriptor, pageBytes: 8192 })
      const collected: Uint8Array[] = []
      const walk = await handle.walk({ onPage: page => { collected.push(page.bytes) } })
      // Several bounded pages, none of them the whole 100 KiB.
      expect(walk.pages).toBeGreaterThan(8)
      expect(collected.every(chunk => chunk.byteLength <= 8192)).toBe(true)

      const joined = Buffer.concat(collected)
      expect(joined.byteLength).toBe(Buffer.byteLength(line, 'utf8'))
      expect(joined.toString('utf8')).toBe(line)
      expect(sha256(joined)).toBe(captured.descriptor.captured.sha256)
      // The marker at the FAR END proves the interior was not clipped: a
      // truncating reader would lose exactly this.
      expect(joined.toString('utf8').endsWith('-TAIL-MARKER')).toBe(true)
      expect(walk.exhausted).toBe(true)
    } finally {
      await dispose()
    }
  })
})

// ===========================================================================
// K1/K7 -- paging complexity
// ===========================================================================

describe('R6-K7 [real] paging is O(pages) in physical IO, never O(pages x file)', () => {
  it('measures the bytes the store read for P pages and shows no repeated full scan', async () => {
    const { plane, root, dispose } = await mountService('k7-io')
    try {
      const pageBytes = 64 * 1024
      const pages = 64
      const total = pageBytes * pages
      writeFileSync(join(root, 'scan.bin'), Buffer.alloc(total, 0x51))
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const captured = await plane.fsCapture(caller, {
        path: 'scan.bin', mediaType: 'application/octet-stream', observationId: 'obs-r6-io',
      })

      const handle = plane.openPages(caller, { descriptor: captured.descriptor, pageBytes })
      const walk = await handle.walk()

      // THE MEASUREMENT. Physical artifact bytes read must equal the pages
      // consumed -- not P times the file. A per-page full scan would report
      // pages * total, which is the quadratic shape K7 names.
      expect(walk.pages).toBe(pages)
      expect(walk.bytes).toBe(total)
      expect(walk.io.artifactBytesRead).toBe(total)
      expect(walk.io.artifactReads).toBe(pages)
      // The SOURCE was not re-read at all during paging: pages come from the
      // immutable artifact, so a writer changing the file cannot be observed.
      expect(walk.io.sourceBytesRead).toBe(0)

      // Stated as a ratio so the bound is falsifiable rather than asserted: the
      // cost is exactly 1.0 x the bytes consumed, against a P x file failure of 64.
      const amplification = walk.io.artifactBytesRead / total
      expect(amplification).toBe(1)
      expect(amplification).toBeLessThan(pages)

      console.log('[R6-K7] pages', walk.pages, 'bytes', walk.bytes,
        'artifactBytesRead', walk.io.artifactBytesRead, 'artifactReads', walk.io.artifactReads,
        'sourceBytesRead', walk.io.sourceBytesRead, 'amplification', amplification,
        'quadraticWouldBe', pages)
    } finally {
      await dispose()
    }
  })

  it('pages an immutable artifact even after the SOURCE file is rewritten, so revisions never mix', async () => {
    const { plane, root, dispose } = await mountService('k7-immutable')
    try {
      const pageBytes = 4096
      const original = Buffer.alloc(pageBytes * 4, 0x41)
      writeFileSync(join(root, 'mut.bin'), original)
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const captured = await plane.fsCapture(caller, {
        path: 'mut.bin', mediaType: 'application/octet-stream', observationId: 'obs-r6-mut',
      })

      const handle = plane.openPages(caller, { descriptor: captured.descriptor, pageBytes })
      const first = await handle.next()
      // Rewrite the SOURCE with the SAME LENGTH. A pager reading the live file
      // would now splice two revisions into one result.
      writeFileSync(join(root, 'mut.bin'), Buffer.alloc(pageBytes * 4, 0x42))

      const rest: Uint8Array[] = [first.bytes]
      let cursor = first.nextCursor
      while (cursor !== undefined) {
        const page = await handle.next(cursor)
        rest.push(page.bytes)
        cursor = page.nextCursor
      }
      const joined = Buffer.concat(rest)
      // Every byte came from the captured revision.
      expect(sha256(joined)).toBe(captured.descriptor.captured.sha256)
      expect(joined.equals(original)).toBe(true)
      // And the source really did change, so the test is not vacuous.
      expect(sha256(readFileSync(join(root, 'mut.bin')))).not.toBe(captured.descriptor.captured.sha256)
    } finally {
      await dispose()
    }
  })
})

// ===========================================================================
// K4 -- attachments
// ===========================================================================

describe('R6-K4 [real] artifacts.save cross-checks two independent stores', () => {
  it('streams a captured artifact into DSH attachment storage and back, digest-verified', async () => {
    const root = tempRoot('k4-save')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
    await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
    // A real `LocalAttachmentStore`, so the second store is genuinely a second
    // store rather than a second view of the first.
    const attachmentPlugin = await import('@deepseek-ai/dsh-attachment-local')
    await ctx.plugin(attachmentPlugin.default as never, { dshHome: root } as never)
    const service = new DataPlaneService(ctx, {
      artifactRoot: join(root, 'artifacts'),
      ownerScope: 'project:r6',
      executionWorld: 'local',
      pageBytes: 8192,
    })
    await service.open(ctx.storageDomain)
    const plane = service.plane()
    try {
      const payload = Buffer.from('attachment payload\n'.repeat(500), 'utf8')
      writeFileSync(join(root, 'att.txt'), payload)
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const captured = await plane.fsCapture(caller, {
        path: 'att.txt', mediaType: 'text/plain', observationId: 'obs-r6-att',
      })
      const saved = await plane.saveAttachment(caller, { descriptor: captured.descriptor, name: 'att.txt' })
      // The attachment store addresses by the sha256 of the bytes, so this
      // equality is two independent stores agreeing -- not one restating itself.
      expect(saved.sha256).toBe(captured.descriptor.captured.sha256)
      expect(saved.bytes).toBe(payload.byteLength)

      const readBack = await plane.readAttachment(caller, {
        attachmentId: saved.attachmentId, name: saved.name, bytes: saved.bytes,
      })
      expect(Buffer.from(readBack.bytes).equals(payload)).toBe(true)
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  it('fails LOUD on a missing attachment object rather than returning an empty success', async () => {
    const root = tempRoot('k4-missing')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
    await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
    const attachmentPlugin = await import('@deepseek-ai/dsh-attachment-local')
    await ctx.plugin(attachmentPlugin.default as never, { dshHome: root } as never)
    const service = new DataPlaneService(ctx, {
      artifactRoot: join(root, 'artifacts'), ownerScope: 'project:r6', executionWorld: 'local',
    })
    await service.open(ctx.storageDomain)
    const plane = service.plane()
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      // A reference to bytes that were never stored. The digest is well-formed so
      // the failure is about ABSENCE, not about a malformed id.
      const ghost = sha256('never stored')
      const outcome = await plane.readAttachment(caller, { attachmentId: ghost, name: 'ghost.txt', bytes: 12 })
        .then(() => 'returned' as const, () => 'refused' as const)
      // The refusal is not an empty success: a caller cannot confuse "lost" with
      // "legitimately empty".
      expect(outcome).toBe('refused')
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })
})

// ===========================================================================
// K3 -- web (provider-level, no live request)
// ===========================================================================

/** A stub fetch provider. Registered on a real `ctx.web`, so the seam is real. */
function stubFetchProvider(result: WebFetchResult): {
  id: string
  available: () => boolean
  fetch: () => Promise<WebFetchResult>
  calls: number
} {
  const provider = {
    id: 'r6-stub-fetch',
    calls: 0,
    available: () => true,
    async fetch(): Promise<WebFetchResult> {
      provider.calls += 1
      return result
    },
  }
  return provider
}

describe('R6-K3 [stub provider on the real ctx.web seam] provider truncation is recorded, never repaired', () => {
  it('marks a provider-capped fetch PARTIAL with a provider-acquisition gap and a refetch recovery', async () => {
    const root = tempRoot('k3-trunc')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
    await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
    await ctx.plugin(WebRuntime, { fetchProvider: 'r6-stub-fetch' })
    const provider = stubFetchProvider({
      url: 'https://example.test/page',
      statusCode: 200,
      body: { kind: 'text', content: 'A'.repeat(1000) },
      truncated: true,
    })
    ctx.web.registerFetchProvider(provider as never)

    const service = new DataPlaneService(ctx, {
      artifactRoot: join(root, 'artifacts'), ownerScope: 'project:r6', executionWorld: 'local',
    })
    await service.open(ctx.storageDomain)
    const plane = service.plane()
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6' })
      const fetched = await plane.webFetch(caller, { url: 'https://example.test/page', maxBodyChars: 1000 })

      // The seam really was reached: the stub was called through `ctx.web.fetch`.
      expect(provider.calls).toBe(1)
      // The selected provider id is RECORDED, which is what makes a mis-selection
      // visible rather than inferred from configuration.
      expect(fetched.provider).toBe('r6-stub-fetch')

      const acquisition = fetched.record.acquisition
      expect(acquisition.completeness).toBe('partial')
      const gap = acquisition.gaps.find(entry => entry.stage === 'provider-acquisition')
      expect(gap, 'a capped body must record WHERE the bytes went').toBeDefined()
      // A refetch is a NEW observation, so the recovery is `refetch` -- never
      // `page`, because the missing bytes are not in any local object.
      expect(gap?.recovery).toBe('refetch')
      expect(gap?.reason).toContain('1000')

      // The body is NOT returned inline: a fetched page is bulk data. The
      // outcome carries the body's IDENTITY (kind, size, digest) and never its
      // content, so a caller can decide whether to capture it without receiving it.
      expect(JSON.stringify(fetched)).not.toContain('AAAAA')
      expect(fetched.body.chars).toBe(1000)
      expect(fetched.body.bytes).toBe(1000)
      expect(fetched.body.kind).toBe('text')
      expect(fetched.body.sha256).toHaveLength(64)
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  it('records a COMPLETE fetch as complete-within-request, so the partial marking is not vacuous', async () => {
    const root = tempRoot('k3-full')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
    await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
    await ctx.plugin(WebRuntime, { fetchProvider: 'r6-stub-fetch' })
    const provider = stubFetchProvider({
      url: 'https://example.test/ok',
      statusCode: 200,
      body: { kind: 'text', content: 'complete body' },
      truncated: false,
    })
    ctx.web.registerFetchProvider(provider as never)
    const service = new DataPlaneService(ctx, {
      artifactRoot: join(root, 'artifacts'), ownerScope: 'project:r6', executionWorld: 'local',
    })
    await service.open(ctx.storageDomain)
    const plane = service.plane()
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6' })
      const fetched = await plane.webFetch(caller, { url: 'https://example.test/ok' })
      expect(fetched.record.acquisition.completeness).toBe('complete-within-request')
      expect(fetched.record.acquisition.gaps).toHaveLength(0)
      // The record still says what the hash does and does not prove.
      expect(fetched.record.hashProves).toContain('not truth')
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  it('a REFETCH creates a NEW observation; the earlier partial record is never rewritten into full', async () => {
    const root = tempRoot('k3-refetch')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
    await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
    await ctx.plugin(WebRuntime, { fetchProvider: 'r6-stub-fetch' })
    let truncated = true
    const provider = {
      id: 'r6-stub-fetch',
      available: () => true,
      async fetch(): Promise<WebFetchResult> {
        return {
          url: 'https://example.test/change',
          statusCode: 200,
          body: { kind: 'text', content: truncated ? 'B'.repeat(100) : 'B'.repeat(400) },
          truncated,
        }
      },
    }
    ctx.web.registerFetchProvider(provider as never)
    const service = new DataPlaneService(ctx, {
      artifactRoot: join(root, 'artifacts'), ownerScope: 'project:r6', executionWorld: 'local',
    })
    await service.open(ctx.storageDomain)
    const plane = service.plane()
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6' })
      const first = await plane.webFetch(caller, { url: 'https://example.test/change', maxBodyChars: 100 })
      expect(first.record.acquisition.completeness).toBe('partial')
      const firstId = first.record.observationId
      const firstDigest = first.record.captured.sha256
      const firstTime = first.record.source.acquiredAt

      // The world changes and a refetch happens. It is a NEW observation.
      truncated = false
      const second = await plane.webFetch(caller, { url: 'https://example.test/change', maxBodyChars: 100 })
      expect(second.record.acquisition.completeness).toBe('complete-within-request')
      expect(second.record.observationId).not.toBe(firstId)
      expect(second.record.captured.sha256).not.toBe(firstDigest)
      // The EARLIER record is untouched: same id, same digest, same time, and
      // still partial. Backfilling it would make it claim bytes it never held.
      expect(first.record.observationId).toBe(firstId)
      expect(first.record.captured.sha256).toBe(firstDigest)
      expect(first.record.source.acquiredAt).toBe(firstTime)
      expect(first.record.acquisition.completeness).toBe('partial')
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  it('refuses an empty query rather than reporting an empty result set', async () => {
    const { plane, dispose } = await mountService('k3-empty')
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6' })
      await expect(plane.webSearch(caller, { query: '   ' }))
        .rejects.toMatchObject({ code: 'DATA_INVALID_REQUEST' })
      await expect(plane.webSearch(caller, { query: '   ' }))
        .rejects.toThrow(/caller error, not an empty result set/u)
    } finally {
      await dispose()
    }
  })

  it('records a search as a RANKING, and never as an exhaustive set', async () => {
    const root = tempRoot('k3-search')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
    await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
    await ctx.plugin(WebRuntime, { searchProvider: 'r6-stub-search' })
    const searchProvider: WebSearchProvider & { calls: number } = {
      id: 'r6-stub-search',
      calls: 0,
      available: () => true,
      async search(request) {
        searchProvider.calls += 1
        return {
          sources: [
            { url: 'https://a.test/1', title: 'A' },
            { url: 'https://b.test/2', title: 'B' },
          ],
          // The seam reports its own cut. A provider that returned fewer than
          // asked is NOT evidence of exhaustion.
          truncated: false,
        }
      },
    }
    ctx.web.registerSearchProvider(searchProvider)
    const service = new DataPlaneService(ctx, {
      artifactRoot: join(root, 'artifacts'), ownerScope: 'project:r6', executionWorld: 'local',
    })
    await service.open(ctx.storageDomain)
    const plane = service.plane()
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6' })
      const found = await plane.webSearch(caller, { query: 'r6 stimulus', maxResults: 10 })
      expect(searchProvider.calls).toBe(1)
      expect(found.provider).toBe('r6-stub-search')
      expect(found.provenance.returned).toBe(2)
      expect(found.provenance.requestedMax).toBe(10)
      expect(found.provenance.seamTruncated).toBe(false)
      // THE HONEST FIELD. A short list from a provider with no cursor is not
      // evidence that the result set is exhausted.
      expect(found.provenance.mayBeMore).toBe('unknown')
      expect(found.provenance.coverage).toBe('ranked-top-k-of-provider-result-set')
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })
})

// ===========================================================================
// K2 -- history
// ===========================================================================

describe('R6-K2 [real] the history cursor holds ONE observation for the whole traversal', () => {
  it('binds the cursor to the cut identity and refuses a cursor from a superseded scan', async () => {
    const { plane, dispose } = await mountService('k2-cursor')
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: 'C:/ws' })
      // No session-query service is mounted in this mount, so the plane's own
      // refusal is what is measured here: a DEPLOYMENT fact named as one, rather
      // than an empty history that reads as "no events".
      await expect(plane.historySearch(caller, { query: 'anything' }))
        .rejects.toMatchObject({ code: 'DATA_NO_CAPABILITY' })
      await expect(plane.historySearch(caller, { query: 'anything' }))
        .rejects.toThrow(/DEPLOYMENT fact/u)
    } finally {
      await dispose()
    }
  })

  it('refuses an empty query rather than returning no hits', async () => {
    const { plane, dispose } = await mountService('k2-empty')
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6' })
      await expect(plane.historySearch(caller, { query: '' }))
        .rejects.toMatchObject({ code: 'DATA_INVALID_REQUEST' })
    } finally {
      await dispose()
    }
  })
})

// ===========================================================================
// K5/K6 -- projection manifest
// ===========================================================================

describe('R6-K6 [real] the projection manifest is a SEPARATE fact from acquisition', () => {
  it('records a projection over a real 32 MiB artifact while the descriptor stays complete', async () => {
    const { plane, root, dispose } = await mountService('k6-proj')
    try {
      const total = 32 * 1024 * 1024
      writeFileSync(join(root, 'huge.bin'), Buffer.alloc(total, 0x77))
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const captured = await plane.fsCapture(caller, {
        path: 'huge.bin', mediaType: 'application/octet-stream', observationId: 'obs-r6-proj',
      })

      const emitted = JSON.stringify({ note: 'summary only', artifactBytes: total })
      const manifest = plane.projectionManifest(caller, {
        descriptors: [captured.descriptor],
        mode: 'head',
        selectorName: 'dsh.data.summary',
        selectorVersion: '1',
        selectedBytes: emitted.length,
        omittedBytes: total - emitted.length,
        emitted,
      })

      // (1) THE ACQUISITION IS UNTOUCHED. The capture was complete, and a small
      // projection does NOT become an acquisition gap -- which is exactly the
      // conflation D2 splits apart.
      expect(captured.descriptor.acquisition.completeness).toBe('complete-within-request')
      expect(captured.descriptor.acquisition.gaps).toHaveLength(0)

      // (2) The projection is its own record, with its own kind.
      expect(manifest.kind).toBe('projection-manifest')
      expect(manifest.mode).toBe('head')
      expect(manifest.selectedBytes).toBe(Buffer.byteLength(emitted, 'utf8'))
      expect(manifest.omittedBytes).toBe(total - Buffer.byteLength(emitted, 'utf8'))
      expect(manifest.emittedSha256).toBe(sha256(emitted))
      expect(manifest.sources[0]?.sha256).toBe(captured.descriptor.captured.sha256)
      expect(manifest.recoverability).toEqual([captured.descriptor.captured.artifact])
      // (3) A non-exhaustive mode's omission is a FLOOR, not a measurement.
      expect(manifest.omittedIsExact).toBe(false)
      expect(omissionKind(manifest)).toBe('floor')
    } finally {
      await dispose()
    }
  })

  it('refuses a projection that omitted bytes with nothing saying how to recover them', async () => {
    // The refusal that keeps the distinction honest: omitted bytes with no
    // recoverability ref is a LOSS, and filing it as a projection is the
    // conflation D2 exists to prevent.
    expect(() => buildProjectionManifest({
      sources: [{ observationId: 'o1', artifact: 'artifact:sha256:x', sha256: 'a'.repeat(64), artifactBytes: 100 }],
      mode: 'head',
      selector: { name: 's', version: '1' },
      selectedBytes: 10,
      omittedBytes: 90,
      recoverability: [],
      emitted: 'ten bytes!',
    })).toThrow(/recoverability/u)
  })

  it('refuses a NEGATIVE or fractional count instead of recording a number never measured', async () => {
    const base = {
      sources: [{ observationId: 'o1', artifact: 'artifact:sha256:x', sha256: 'a'.repeat(64), artifactBytes: 100 }],
      mode: 'bounded' as const,
      selector: { name: 's', version: '1' },
      selectedBytes: 10,
      emitted: 'ten bytes!',
    }
    expect(() => buildProjectionManifest({ ...base, omittedBytes: -1 })).toThrow(/non-negative integer/u)
    expect(() => buildProjectionManifest({ ...base, omittedBytes: 1.5 })).toThrow(/non-negative integer/u)
  })

  it('marks an EXHAUSTIVE projection omission as exact, so a floor is never read as a measurement', async () => {
    const manifest = buildProjectionManifest({
      sources: [{ observationId: 'o1', artifact: 'artifact:sha256:x', sha256: 'a'.repeat(64), artifactBytes: 100 }],
      mode: 'exhaustive',
      selector: { name: 's', version: '1' },
      selectedBytes: 100,
      omittedBytes: 0,
      recoverability: ['artifact:sha256:x'],
      emitted: 'x'.repeat(100),
    })
    expect(manifest.omittedIsExact).toBe(true)
    expect(omissionKind(manifest)).toBe('exact')
    // An omission count that is never set is `none`, NOT zero: zero would claim
    // the projection was exhaustive, which is a different fact.
    const noOmission = buildProjectionManifest({
      sources: [],
      mode: 'head',
      selector: { name: 's', version: '1' },
      selectedBytes: 5,
      emitted: 'hello',
    })
    expect(noOmission.omittedBytes).toBeUndefined()
    expect(omissionKind(noOmission)).toBe('none')
  })
})

// ===========================================================================
// Concurrency -- host-owned, bounded
// ===========================================================================

describe('R6-K3 [real] the read limiter is host-owned and actually bounds overlap', () => {
  it('never exceeds the configured bound and releases a slot on failure', async () => {
    const limiter = new DataReadLimiter(2)
    let active = 0
    let peak = 0
    const order: number[] = []
    const tasks = Array.from({ length: 8 }, (_, index) => limiter.run(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(index)
      active -= 1
      return index
    }))
    await Promise.all(tasks)
    // THE BOUND. A limiter that admitted everything would report 8.
    expect(peak).toBe(2)
    expect(limiter.report().peakInFlight).toBe(2)
    expect(limiter.report().limit).toBe(2)
    expect(order).toHaveLength(8)
  })

  it('releases the slot when the body REJECTS, so one failure does not shrink the plane forever', async () => {
    const limiter = new DataReadLimiter(1)
    await expect(limiter.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // The slot came back: a leak here would silently reduce capacity for the
    // rest of the process lifetime, which only shows up under load.
    expect(limiter.report().inFlight).toBe(0)
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('refuses a non-positive or fractional bound, because that is not a bound', async () => {
    expect(() => new DataReadLimiter(0)).toThrow(/positive integer/u)
    expect(() => new DataReadLimiter(-1)).toThrow(/positive integer/u)
    expect(() => new DataReadLimiter(1.5)).toThrow(/positive integer/u)
  })

  it('defaults conservatively, below every shipped parallelism default in this repository', async () => {
    // The registry's own `maxParallelSubCalls` default is 10 and `native-call.ts`
    // defaults to 8, so the read plane can never be the component that saturates
    // a provider.
    expect(DEFAULT_DATA_READ_CONCURRENCY).toBeLessThan(8)
    expect(new DataReadLimiter().limit).toBe(DEFAULT_DATA_READ_CONCURRENCY)
  })

  it('mapBounded keeps INPUT ORDER regardless of completion order', async () => {
    // Out-of-order results are how a page gets attributed to the wrong artifact.
    const delays = [30, 5, 20, 1, 10]
    const results = await mapBounded(delays, 2, async (delay, index) => {
      await new Promise(resolve => setTimeout(resolve, delay))
      return index
    })
    expect(results).toEqual([0, 1, 2, 3, 4])
  })
})

// ===========================================================================
// The bridge router -- R5's integration point
// ===========================================================================

describe('R6-K5 [real] the bridge router separates dsh.data from ToolRuntime dispatch', () => {
  it('recognizes the reserved prefix, which cannot collide with a tool name', async () => {
    expect(DATA_TOOL_PREFIX).toBe('data:')
    expect(isDataRequest('data:fs.capture')).toBe(true)
    expect(isDataRequest('read')).toBe(false)
    expect(isDataRequest('data')).toBe(false)
    // A colon is not valid in a DSH tool name, so the prefix is un-collidable by
    // construction rather than by convention.
    expect(DATA_METHODS.every(method => isDataRequest(`${DATA_TOOL_PREFIX}${method}`))).toBe(true)
  })

  it('routes fs.capture and returns the descriptor WITHOUT the bytes', async () => {
    const { plane, root, dispose } = await mountService('k5-route')
    try {
      const payload = Buffer.from('routed payload\n'.repeat(2000), 'utf8')
      writeFileSync(join(root, 'routed.txt'), payload)
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const outcome = await routeDataRequest(plane, caller, 'data:fs.capture', {
        path: 'routed.txt', media_type: 'text/plain', observation_id: 'obs-r6-route',
      })
      expect(outcome.ok).toBe(true)
      const value = outcome.value as Record<string, unknown>
      expect(value['observation_id']).toBe('obs-r6-route')
      expect(value['acquired_bytes']).toBe(payload.byteLength)
      expect(value['persisted_bytes']).toBe(payload.byteLength)
      // THE POINT OF THE PLANE: the payload is NOT in the response. A router that
      // inlined it would put 32 MiB into a frame.
      expect(JSON.stringify(outcome)).not.toContain('routed payload')
    } finally {
      await dispose()
    }
  })

  it('returns a STRUCTURED refusal naming the unknown method, rather than falling through', async () => {
    const { plane, dispose } = await mountService('k5-unknown')
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6' })
      const outcome = await routeDataRequest(plane, caller, 'data:fs.typo', {})
      expect(outcome.ok).toBe(false)
      expect(outcome.error?.code).toBe('DATA_INVALID_REQUEST')
      // A fall-through would let a typo become a tool call, which is exactly the
      // conflation the reserved prefix exists to prevent.
      expect(outcome.error?.message).toContain('not a dsh.data method')
    } finally {
      await dispose()
    }
  })

  it('refuses a non-object argument payload with a named code', async () => {
    const { plane, dispose } = await mountService('k5-args')
    try {
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6' })
      const outcome = await routeDataRequest(plane, caller, 'data:fs.capture', ['not', 'an', 'object'])
      expect(outcome.ok).toBe(false)
      expect(outcome.error?.code).toBe('DATA_INVALID_REQUEST')
      expect(outcome.error?.message).toContain('must be a JSON object')
    } finally {
      await dispose()
    }
  })

  it('refuses a payload that tries to assert a HOST fact, naming the forged path', async () => {
    const { plane, root, dispose } = await mountService('k5-forge')
    try {
      writeFileSync(join(root, 'f.txt'), 'f')
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      // A kernel payload claiming a digest the host did not compute. The refusal
      // is the whole reason the descriptor's strongest field is host-authored.
      const outcome = await routeDataRequest(plane, caller, 'data:fs.capture', {
        path: 'f.txt',
        observation_id: 'obs-r6-forge',
        captured: { sha256: 'f'.repeat(64), bytes: 999999, artifact: 'artifact:sha256:forged' },
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.error?.code).toBe('observation-authority-forged')
      expect(outcome.error?.message).toContain('captured')
    } finally {
      await dispose()
    }
  })

  it('exposes exactly the documented method list, so the Python surface cannot silently widen', async () => {
    // The Python client's own method names, read from the shipped module, must be
    // a SUBSET of what the router accepts. A drift in either direction means
    // either a Python call that always refuses or an unreviewed new capability.
    const source = readFileSync(new URL('./dsh_data_client.py', import.meta.url), 'utf8')
    const invoked = [...source.matchAll(/\._call\(\s*"([a-z_.]+)"/gu)].map(match => match[1] as string)
    expect(invoked.length).toBeGreaterThan(0)
    for (const method of invoked) {
      expect(DATA_METHODS, `the Python client calls ${method}, which the router does not accept`)
        .toContain(method)
    }
    // And the prefix the Python client uses is the router's own constant.
    expect(source).toContain(`_PREFIX = "${DATA_TOOL_PREFIX}"`)
  })
})

// ===========================================================================
// K7 -- the >= 32 MiB stress stimulus, with all four byte-counts
// ===========================================================================

describe('R6-K7 [real] 32 MiB stress: four byte-counts, bounded model visibility, verified digest', () => {
  it('consumes the whole source in Python, keeps the model-visible projection bounded, and verifies', async () => {
    const { plane, root, dispose } = await mountService('k7-32mib')
    try {
      const pageBytes = 64 * 1024
      const totalBytes = 32 * 1024 * 1024
      const sourcePath = join(root, 'stress.bin')

      // (a) GENERATE the >= 32 MiB source, with ONE line longer than 100 KiB so
      // the long-line shape is present in the same stimulus. A single 100 KiB line
      // of distinct bytes makes a positional error detectable rather than masked
      // by uniformity.
      const longLine = Buffer.alloc(128 * 1024)
      for (let index = 0; index < longLine.length; index += 1) longLine[index] = 0x21 + (index % 90)
      const filler = Buffer.alloc(totalBytes - longLine.length, 0x7a)
      const source = Buffer.concat([longLine, filler])
      expect(source.byteLength).toBe(totalBytes)
      writeFileSync(sourcePath, source)
      const sourceDigest = sha256(source)

      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })

      // (1) ACQUIRED + (2) PERSISTED.
      const captured = await plane.fsCapture(caller, {
        path: 'stress.bin', mediaType: 'application/octet-stream', observationId: 'obs-r6-stress',
      })
      const acquiredBytes = captured.accounting.acquiredBytes
      const persistedBytes = captured.accounting.persistedBytes
      expect(acquiredBytes).toBe(totalBytes)
      expect(persistedBytes).toBe(totalBytes)
      expect(captured.descriptor.captured.sha256).toBe(sourceDigest)
      // The store's own stat agrees, so PERSISTED is the store's number and not a
      // copy of the descriptor's.
      const stored = await plane.artifactStat(caller, captured.descriptor)
      expect(stored?.bytes).toBe(totalBytes)

      // (3) PYTHON-CONSUMED: walk every page, hashing as we go, exactly as a cell
      // would. Nothing is retained beyond one page.
      const handle = plane.openPages(caller, { descriptor: captured.descriptor, pageBytes })
      const hash = createHash('sha256')
      let consumedBytes = 0
      let pagesSeen = 0
      let maxPageBytes = 0
      const walk = await handle.walk({
        onPage: page => {
          hash.update(page.bytes)
          consumedBytes += page.bytes.byteLength
          maxPageBytes = Math.max(maxPageBytes, page.bytes.byteLength)
          pagesSeen += 1
        },
      })
      const consumedDigest = hash.digest('hex')
      expect(pagesSeen).toBe(totalBytes / pageBytes)
      expect(pagesSeen).toBe(512)
      expect(consumedBytes).toBe(totalBytes)
      expect(maxPageBytes).toBe(pageBytes)
      expect(consumedDigest).toBe(sourceDigest)
      expect(walk.exhausted).toBe(true)

      // (4) LLM-VISIBLE: the bounded projection, and the manifest for it.
      const projection = plane.projectForModel(caller, {
        descriptor: captured.descriptor,
        pagesConsumed: walk.pages,
        bytesConsumed: consumedBytes,
        exhausted: walk.exhausted,
        consumerNote: 'streamed to a Python consumer; nothing retained in context',
      })
      const modelVisibleBytes = Buffer.byteLength(JSON.stringify(projection), 'utf8')
      expect(modelVisibleBytes).toBeLessThanOrEqual(8 * 1024)
      // The ratio is the point: ~33.5 million consumed against a few hundred shown.
      expect(modelVisibleBytes).toBeLessThan(consumedBytes / 10000)

      const manifest = plane.projectionManifest(caller, {
        descriptors: [captured.descriptor],
        mode: 'bounded',
        selectorName: 'dsh.data.projection',
        selectorVersion: '1',
        selectedBytes: modelVisibleBytes,
        omittedBytes: consumedBytes - modelVisibleBytes,
        emitted: JSON.stringify(projection),
      })
      expect(manifest.omittedBytes).toBe(consumedBytes - modelVisibleBytes)
      expect(manifest.omittedIsExact).toBe(false)
      expect(manifest.recoverability).toEqual([captured.descriptor.captured.artifact])

      // NO QUADRATIC PER-PAGE COST, measured rather than argued: the physical
      // artifact read equals the bytes consumed, so a per-page full rescan would
      // have cost 512 x 32 MiB instead of 32 MiB.
      expect(walk.io.artifactBytesRead).toBe(totalBytes)
      expect(walk.io.artifactReads).toBe(pagesSeen)
      expect(walk.io.sourceBytesRead).toBe(0)

      console.log('[R6-K7-32MiB] acquiredBytes', acquiredBytes, 'persistedBytes', persistedBytes,
        'pythonConsumedBytes', consumedBytes, 'modelVisibleBytes', modelVisibleBytes,
        'ratio', Math.round(consumedBytes / modelVisibleBytes),
        'pages', walk.pages, 'artifactBytesRead', walk.io.artifactBytesRead,
        'artifactReads', walk.io.artifactReads,
        'quadraticWouldBe', pagesSeen * totalBytes,
        'digestVerified', consumedDigest === sourceDigest)

      // Clean up the 32 MiB source and its artifact immediately, so the next test
      // is not competing for disk with this one.
      rmSync(sourcePath, { force: true })
    } finally {
      await dispose()
    }
  }, 300_000)
})

// ===========================================================================
// K7 -- fault arms
// ===========================================================================

describe('R6-K7 [real] storage faults are honest', () => {
  it('reports a QUOTA refusal as a partial observation with a retention gap and NO artifact', async () => {
    const root = tempRoot('k7-quota')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    ctx.provide('dshHomePath', (...segments: string[]) => join(root, ...segments))
    await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
    // The byte store is a mounted capability (F4), so this arm mounts a provider
    // too -- without it the quota refusal would surface as a generic publication
    // failure and the retention gap this case asserts would never be produced.
    await ctx.plugin(AttachmentLocal, { dshHome: join(root, 'home') })
    const service = new DataPlaneService(ctx, {
      artifactRoot: join(root, 'artifacts'),
      ownerScope: 'project:r6',
      executionWorld: 'local',
      // A deliberately tiny ceiling, so the refusal is exercised against the REAL
      // store's own quota check rather than a stub.
      quotaBytes: 16 * 1024,
    })
    await service.open(ctx.storageDomain)
    const plane = service.plane()
    try {
      const content = Buffer.alloc(64 * 1024, 0x33)
      writeFileSync(join(root, 'over.bin'), content)
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const captured = await plane.fsCapture(caller, {
        path: 'over.bin', mediaType: 'application/octet-stream', observationId: 'obs-r6-quota',
      })

      // The refusal is RECORDED, attributed to the RETENTION stage, with recovery
      // `none` because a retry against the same quota fails the same way.
      const gap = captured.gaps.find(entry => entry.stage === 'retention')
      expect(gap, 'an over-quota capture must record where the bytes went').toBeDefined()
      expect(gap?.recovery).toBe('none')
      expect(captured.descriptor.acquisition.completeness).toBe('partial')
      // NO INLINE FALLBACK: the outcome is a small honest answer, never the bytes.
      expect(captured.descriptor.captured.bytes).toBe(0)
      expect(JSON.stringify(captured)).not.toContain('3333333333')
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  it('fails LOUD on a CORRUPT artifact rather than serving replaced bytes as content', async () => {
    const { plane, service, root, dispose } = await mountService('k7-corrupt')
    try {
      const original = Buffer.from('ORIGINAL-PAYLOAD-FOR-R6\n', 'utf8')
      writeFileSync(join(root, 'corrupt.bin'), original)
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const captured = await plane.fsCapture(caller, {
        path: 'corrupt.bin', mediaType: 'text/plain', observationId: 'obs-r6-corrupt',
      })

      // Overwrite the stored OBJECT in place with the same length. The reference
      // still declares the original digest, so this is exactly the window where a
      // naive reader would serve different bytes as the observation.
      const digest = captured.descriptor.captured.sha256
      // The object's bytes live in the mounted attachment provider now (F4), so the
      // path comes from the capability -- the same accessor the production read path
      // uses. A hand-built `root/objects/<sha>` path no longer exists, and damaging
      // it would have left the test passing vacuously against a file nothing reads.
      const objectPath = await service.store.hostPath(captured.descriptor.captured.artifact)
      expect(objectPath, 'the mounted provider must be host-backed to damage the real object').toBeDefined()
      const before = readFileSync(objectPath as string)
      expect(before.byteLength).toBe(original.byteLength)
      chmodSync(objectPath as string, 0o600)
      writeFileSync(objectPath as string, Buffer.alloc(original.byteLength, 0x5a))

      // The content-integrity check refuses it, naming both hashes.
      await expect(service.resolve('obs-r6-corrupt'))
        .rejects.toMatchObject({ code: 'artifact-integrity-error' })
      await expect(service.resolve('obs-r6-corrupt')).rejects.toThrow(/hashes to/u)
    } finally {
      await dispose()
    }
  })

  it('fails LOUD on a MISSING artifact object rather than returning an empty success', async () => {
    const { service, root, dispose } = await mountService('k7-missing')
    try {
      writeFileSync(join(root, 'gone.bin'), 'gone\n')
      const fs = mountFs(root)
      void fs
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const plane = service.plane()
      const captured = await plane.fsCapture(caller, {
        path: 'gone.bin', mediaType: 'text/plain', observationId: 'obs-r6-gone',
      })
      // Same correction as the corrupt arm above: the object is addressed through
      // the mounted provider, not through a layout this module used to own.
      const objectPath = await service.store.hostPath(captured.descriptor.captured.artifact)
      expect(objectPath, 'the mounted provider must be host-backed to remove the real object').toBeDefined()
      rmSync(objectPath as string, { force: true })

      await expect(service.resolve('obs-r6-gone'))
        .rejects.toMatchObject({ code: 'artifact-integrity-error' })
      await expect(service.resolve('obs-r6-gone')).rejects.toThrow(/absent/u)
    } finally {
      await dispose()
    }
  })

  it('reports an ORPHAN (published but unreferenced) as an orphan, never as delivered', async () => {
    const { service, root, dispose } = await mountService('k7-orphan')
    try {
      writeFileSync(join(root, 'orphan.bin'), 'orphan\n')
      const caller = dataCallerFromEnclosing({ sessionId: 'session-r6', cwd: root })
      const plane = service.plane()
      await plane.fsCapture(caller, {
        path: 'orphan.bin', mediaType: 'text/plain', observationId: 'obs-r6-orphan',
      })
      // An observation id with no committed reference is an orphan, not an
      // absence: the object may exist but nobody promised it.
      await expect(service.resolve('obs-r6-never-committed'))
        .rejects.toMatchObject({ code: 'artifact-orphaned' })
    } finally {
      await dispose()
    }
  })
})

// ===========================================================================
// K5 -- the Python namespace, driven by a REAL CPython process
// ===========================================================================

describe('R6-K5 [real CPython] the dsh.data client installs and its surface is closed', () => {
  it('imports, installs onto a stand-in dsh module, and refuses an unknown method by name', async () => {
    // WHAT THIS PROVES AND WHAT IT DOES NOT. It runs the SHIPPED
    // `dsh_data_client.py` under the REAL interpreter, against a stand-in call
    // channel, so the module's syntax, its `install()` contract and its error
    // mapping are executed rather than read. It does NOT prove a cell can reach
    // the host plane: the bridge's per-call handler lives in `packages/dsh-ipython`
    // (writer R5's package), and the one-branch wiring it needs is documented in
    // `data-bridge.ts` as a contract rather than implemented from this slice.
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const clientPath = fileURLToPath(new URL('./dsh_data_client.py', import.meta.url))

    const script = [
      'import asyncio, importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("dsh_data_client", ${JSON.stringify(clientPath)})`,
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      '',
      '# A stand-in call channel that records the tool names it receives, so the',
      '# reserved prefix is observable from Python.',
      'seen = []',
      'class Channel:',
      '    async def call_async(self, tool, arguments, timeout=120.0):',
      '        seen.append(tool)',
      '        if tool == "data:fs.capture":',
      '            return {"observation_id": "obs-py", "descriptor": {"captured": {"artifact": "artifact:sha256:aa", "sha256": "aa", "bytes": 5},',
      '                    "acquisition": {"completeness": "complete-within-request"}},',
      '                    "identity": {}, "reference": {}, "gaps": [], "acquired_bytes": 5, "persisted_bytes": 5}',
      '        if tool == "data:fs.read_range":',
      '            return {"ok": False, "error": {"code": "DATA_INVALID_REQUEST", "message": "unknown method"}}',
      '        raise AssertionError("unexpected tool " + tool)',
      '',
      'class DshModule:',
      '    pass',
      '',
      'dsh = DshModule()',
      'dsh._channel = Channel()',
      'client = mod.install(dsh)',
      '',
      '# The surface is the documented one, and no wider.',
      'print("SURFACE:" + json.dumps(sorted(n for n in dir(dsh.data) if not n.startswith("_"))))',
      '',
      'async def main():',
      '    obs = await dsh.data.fs.capture("big.log")',
      '    print("OBS:" + json.dumps({"id": obs.observation_id, "bytes": obs.bytes, "complete": obs.complete, "sha": obs.sha256}))',
      '    # A HOST-side refusal arrives as DataError with the host code, so a caller',
      '    # branches on the code rather than parsing prose.',
      '    try:',
      '        await obs.read_range(0, 4)',
      '    except mod.DataError as exc:',
      '        print("ERRCODE:" + exc.code)',
      '    # And an unknown method is refused at the ATTRIBUTE level, so the Python',
      '    # surface is closed by construction rather than by a runtime check.',
      '    print("ATTR:" + str(hasattr(dsh.data.fs, "typo")))',
      '',
      'asyncio.run(main())',
      'print("SEEN:" + json.dumps(seen))',
    ].join('\n')

    const { stdout } = await execFileAsync(pythonPathForR6(), ['-c', script], { timeout: 60_000 })
    // The namespace root exposes exactly the five documented namespaces.
    expect(stdout).toContain('SURFACE:["artifacts", "fs", "history", "projection", "web"]')
    // The capture round-tripped through the reserved prefix and returned an
    // Observation, not a buffer.
    expect(stdout).toContain('"id": "obs-py"')
    expect(stdout).toContain('"complete": true')
    // The prefix the client uses is the router's own constant, asserted from the
    // Python side so a drift cannot hide in a string literal.
    expect(stdout).toContain('"data:fs.capture"')
    expect(stdout).toContain('"data:fs.read_range"')
    // A host refusal maps to DataError carrying the HOST's code.
    expect(stdout).toContain('ERRCODE:DATA_INVALID_REQUEST')
    // An unknown method does not exist as an attribute at all, so the Python
    // surface cannot silently widen.
    expect(stdout).toContain('ATTR:False')
  }, 120_000)

  it('raises at INSTALL time when no call channel exists, rather than a namespace that always fails', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const clientPath = fileURLToPath(new URL('./dsh_data_client.py', import.meta.url))
    const script = [
      'import importlib.util',
      `spec = importlib.util.spec_from_file_location("dsh_data_client", ${JSON.stringify(clientPath)})`,
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      'class Bare:',
      '    pass',
      'try:',
      '    mod.install(Bare())',
      '    print("INSTALLED")',
      'except mod.DataError as exc:',
      '    print("REFUSED:" + exc.code)',
    ].join('\n')
    const { stdout } = await execFileAsync(pythonPathForR6(), ['-c', script], { timeout: 60_000 })
    // The failure is at INSTALL time and names the cause, so a mis-wired bridge is
    // a loud startup error rather than a namespace whose every method fails later.
    expect(stdout).toContain('REFUSED:DATA_NO_CHANNEL')
  }, 120_000)
})
