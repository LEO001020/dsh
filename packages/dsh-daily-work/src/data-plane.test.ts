/**
 * M4: the unified observation / artifact data plane, DAT-01 through DAT-08.
 *
 * TWO TRACKS, KEPT SEPARATE. The audit requires the "native simulator" and the
 * "real backend" tracks to be stored apart, so every test name below carries its
 * track and no result is reported as if it came from the other:
 *
 *   [real]  the production `LocalFileSystem` (`@deepseek-ai/dsh-fs-local`) reading
 *           real files on this machine's disk, the production
 *           `publishImmutableObjectStream` publication primitive, the REAL
 *           `buildWindow` and the REAL `read` TOOL from `@deepseek-ai/dsh-tool-fs`
 *           for every claim about truncation, and (since R5) the REAL
 *           `ipython` tool over a REAL ipykernel for the large-result consumption.
 *   [mock]  a synthetic page provider. Used ONLY where the stimulus is "a provider
 *           that violates the contract" (DAT-04) -- a correct provider cannot be
 *           made to return a backwards cursor, so a mock is the only way to test
 *           the guard at all.
 *
 * THE TRUNCATION INVESTIGATION, AND WHY IT SHAPES EVERYTHING HERE
 *
 * The audit claims the loss happens BEFORE any consumer sees the value. That is
 * verified against the real source in DAT-01 below: `buildWindow` caps its line
 * buffer at `maxLineLength + 1` (`read-render.ts:118`), emits
 * `truncateLine(...)` (`read-render.ts:69-71`), and a re-read at `offset = 2` on a
 * single-line file throws because `totalLines` is 1. The interior of line 1 is
 * gone and no line-offset re-read can reach it. Every fix in this file therefore
 * works on BYTES of a captured object, never on `lines[].text`.
 *
 * R5 STRENGTHENED TWO THINGS, both because the oracle was weaker than the claim:
 *   1. The `read.ts` canonical assignment was cited from SOURCE. It is now also
 *      MEASURED by executing the real `read` tool through the real registry, so
 *      "the clipped lines ARE the returned value" is an observation.
 *   2. DAT-02's consumption was a bare `python -c` process, because M3's worker
 *      did not exist. `packages/dsh-ipython` now exists, so the consumption runs
 *      through the product's own `ipython` tool and a real ipykernel. What STILL
 *      cannot be tested is the native `data.pages` call INSIDE a cell: see the
 *      DAT-02 block for the measurement that establishes why.
 *
 * WHAT IS NOT CLAIMED
 *   - No test here proves a cell can call `data.capture_file` as a native tool.
 *     M3's package exposes no cell-to-host call channel (measured: the broker
 *     registers no comm and injects no host object into the namespace), and the
 *     `data.*` tool rows are not registered anywhere. The page walk below is
 *     driven FROM the host and CONSUMED by the kernel over a socket, which is a
 *     real kernel and a real artifact but is NOT the M3 native-call path.
 *   - No gate claims an exactly-once external effect. The crash-consistency tests
 *     claim what the record is allowed to SAY after an interruption.
 *   - DAT-07 uses the real ripgrep binary and the real `retainGrepMatches`, but
 *     drives them through the library functions rather than through a mounted
 *     agent, so the claim is about the retention layering, not about a full
 *     agent turn.
 */
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { buildWindow, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '@deepseek-ai/dsh-tool-fs/src/read-render.ts'
import { applyReadTool } from '@deepseek-ai/dsh-tool-fs/src/read.ts'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactError,
  ArtifactStorePageProvider,
  CursorAuthority,
  DEFAULT_PAGE_BYTES,
  InMemorySessionReferenceLog,
  LocalArtifactStore,
  buildLineIndex,
  captureFile,
  joinPages,
  mayReExecuteAfterSaveFailure,
  measureRepeatedReadCost,
  pageUtf8ByBytes,
  pages,
  projectForModel,
  readArtifactRange,
  readLineBytes,
  reconcileStore,
  resolveReference,
  truncateUtf8,
  walkPages,
  type ArtifactPage,
  type ArtifactStore,
  type IoCounters,
  type PageProvider,
  type PageRequest,
} from './artifacts.ts'
import { DataPlaneService } from './data-service.ts'
import {
  GrantTable,
  ACQUISITION_COVERAGE_STAGES,
  OBSERVATION_COVERAGE_VOCABULARY,
  OBSERVATION_GAP_STAGES,
  OBSERVATION_SCHEMA_VERSION,
  ObservationError,
  coverageVerdictOf,
  isDeliverableAsComplete,
  parseObservation,
  projectionWithheld,
  recordProjection,
  refuseForgedClaims,
  type ObservationDescriptor,
} from './observations.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

/** Every temp directory this file creates, removed in `afterEach` even on failure. */
const tempDirs: string[] = []

afterEach(() => {
  // Windows holds handles on freshly written files; removal needs retries.
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

/** A fresh temp root, tracked for cleanup. */
function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `m4-${label}-`))
  tempDirs.push(dir)
  return dir
}

/** A real `LocalFileSystem` over a real directory. */
function mountFs(cwd: string): { ctx: Context; fs: LocalFileSystem } {
  const ctx = new Context()
  // `diffBasisMaxBytes` is required by the backend's own validation, not by these
  // tests; the default is not applied when the config object is passed explicitly.
  const fs = new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
  return { ctx, fs }
}

/** A real store + log + grants triple, with the store rooted in a temp dir. */
function makePlane(label: string): {
  store: LocalArtifactStore
  log: InMemorySessionReferenceLog
  grants: GrantTable
  scope: string
} {
  const store = new LocalArtifactStore(join(tempRoot(label), 'artifacts'))
  const log = new InMemorySessionReferenceLog()
  const grants = new GrantTable()
  const scope = 'project:m4'
  // `bump` returns the REVISION; the scope name is the argument. Reading the return
  // value as the scope would put a number where a scope name belongs.
  grants.bump(scope)
  return { store, log, grants, scope }
}

/** sha256 of a buffer, for byte-for-byte comparisons. */
function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Narrow a tool result's `value` to a record, refusing anything else.
 *
 * `ToolExecutionResult.value` is `JsonValue | undefined`, which is the honest
 * type for a generic tool result. A test that reached into it with a cast would
 * stop checking the shape it claims to check, so the narrowing is done here once
 * and a non-object FAILS rather than being coerced.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected a JSON object result value, got ${value === null ? 'null' : typeof value}`)
  }
  return value as Record<string, unknown>
}

/** The `text` of a tool result's content blocks, joined. */
function contentText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

/** The real `resolveRgPath`, imported lazily so a missing rg fails ONE test, not the file. */
async function ripgrepPath(): Promise<string> {
  const module = await import('@deepseek-ai/dsh-tool-fs-search/src/search-core.ts')
  return module.resolveRgPath()
}

/**
 * The real ripgrep binary, resolved from the pinned checkout rather than PATH.
 *
 * The audit environment has a user policy that disables the `rg` on PATH, so a
 * test that trusted PATH would silently test nothing. `resolveRgPath` is what the
 * production tool uses, so this is the production resolution path.
 */
async function realRipgrep(): Promise<string> {
  try {
    const resolved = await ripgrepPath()
    if (existsSync(resolved)) return resolved
  } catch {
    // fall through to the checkout-relative fallback below
  }
  const fallback = 'D:\\DSH\\src\\dsh-src\\node_modules\\.pnpm\\@vscode+ripgrep-win32-x64@1.18.0\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe'
  if (!existsSync(fallback)) throw new Error('no ripgrep binary available; DAT-07 cannot run')
  return fallback
}

/**
 * The real Python interpreter.
 *
 * Resolved from the pinned environment rather than PATH, because the audit's
 * environment is explicit about which Python it means and a PATH lookup could
 * silently pick a different one.
 */
function pythonPath(): string {
  const pinned = 'C:\\Users\\hzq00\\AppData\\Local\\Programs\\Python\\Python314\\python.exe'
  return existsSync(pinned) ? pinned : 'python'
}

/**
 * The `dsh-ipython` package root (M3).
 *
 * `dsh-ipython` is NOT a dependency of this package, so its modules cannot be
 * reached through a bare specifier. It is resolved from the repo layout instead,
 * and every use below FAILS LOUDLY when the package is absent rather than
 * silently degrading to a weaker test -- a substitution that quietly reverts to
 * the old stand-in is exactly the "oracle weaker than the scenario" failure this
 * milestone is checking for.
 */
function ipythonPackageRoot(): string {
  return resolvePath(HERE, '..', '..', 'dsh-ipython')
}

/** Whether M3's package is present, so the real-kernel tests can report a skip. */
function ipythonPackageExists(): boolean {
  return existsSync(join(ipythonPackageRoot(), 'src', 'kernel-plugin.ts'))
}

/**
 * Mount the REAL `read` tool over a real directory, through the real registry.
 *
 * WHY THIS IS HERE. The truncation finding has one step that was cited from
 * SOURCE rather than observed: `read.ts:157` assigns `window.lines` straight
 * into the value the tool returns, which is what makes the clip part of the
 * CANONICAL value instead of a rendering choice. Reading the assignment is not
 * the same as executing it, and the distinction decides whether a consumer could
 * recover the bytes by asking again. So the tool is mounted and CALLED, and the
 * returned canonical value is inspected.
 *
 * The mount is the production composition for the READ path: `SystemPrompt`
 * (which `ToolRuntime` injects), the real `ToolRuntime`, the real
 * `LocalFileSystem`, and `applyReadTool` with the tool's own default caps.
 *
 * `applyReadTool` is imported rather than the whole `tool-fs` plugin, because the
 * package entry also mounts write/edit and constructs `FsSandboxController`; that
 * file is in the pinned checkout and does not compile under this package's
 * `erasableSyntaxOnly`, which is a property of the checkout and not of the read
 * path. Importing the narrower entry keeps the measurement on the code under test
 * instead of on an unrelated build setting.
 */
async function mountReadTool(cwd: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
  applyReadTool(ctx, {
    limit: 2000,
    maxLineLength: READ_MAX_LINE_LENGTH,
    maxBytes: READ_MAX_BYTES,
    streamMinSize: 10 * 1024 * 1024,
  })
  return ctx
}

/**
 * A REAL Python page consumer: one process, one language boundary, many pages.
 *
 * WHY THIS EXISTS INSTEAD OF A JS REDUCER
 *
 * DAT-02's stimulus is "ONE `python_exec` consumes 512 native pages". The
 * nearest real substrate available is a real CPython process, and the real
 * artifact store, talking over a pipe. The pages cross a real process boundary
 * and are never collected in the JS heap, which is the property the gate is
 * actually about.
 *
 * WHAT THIS STILL DOES NOT PROVE, stated so a green result is not over-read:
 *   - It does not prove ipykernel/jupyter_client integration, kernel lifecycle,
 *     interrupt handling, or the native-tool callback channel. The real-kernel
 *     variant below covers the first three; the callback channel does not exist
 *     in M3 and is NOT claimed.
 *   - It does not exercise DSH's tool-call/result plumbing or the model loop.
 *
 * The protocol is line-delimited JSON: Python asks for a byte range, the host
 * answers with base64 bytes. Length-prefixing is unnecessary at 64 KiB pages
 * because base64 of a page is far below any pipe buffer limit, and each side
 * flushes after every line so neither can deadlock on a full pipe.
 *
 * @param script - the Python source to run.
 * @param serve - answers one page request with bytes.
 */
async function runPythonPageConsumer(
  script: string,
  serve: (request: { offset: number; length: number }) => Promise<Uint8Array>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(pythonPath(), ['-u', '-c', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  // Serve requests until Python closes its side. The pending queue makes the
  // handler sequential, so a page is read only after the previous one was written.
  let chain = Promise.resolve()
  lines.on('line', (line: string) => {
    let request: { want?: number; length?: number }
    try {
      request = JSON.parse(line) as { want?: number; length?: number }
    } catch {
      stdout += `${line}\n`
      return
    }
    if (request.want === undefined || request.length === undefined) {
      stdout += `${line}\n`
      return
    }
    chain = chain.then(async () => {
      const bytes = await serve({ offset: request.want as number, length: request.length as number })
      child.stdin.write(`${Buffer.from(bytes).toString('base64')}\n`)
    })
  })
  const code = await new Promise<number | null>(resolve => {
    child.once('exit', status => { resolve(status) })
  })
  await chain
  return { stdout, stderr, code }
}

/**
 * Serve the page protocol on loopback while a REAL kernel consumes it.
 *
 * WHY A SOCKET AND NOT THE M3 NATIVE CALL. M3's broker exposes no cell-to-host
 * call channel: it starts the kernel through `jupyter_client`, registers no
 * comm, and injects no host object into the user namespace. So a cell CANNOT
 * call `data.pages`. The two halves that can be made real are made real here --
 * a real ipykernel consuming, and the real artifact store serving, with the real
 * `IoCounters` proving where the bytes came from -- and the missing middle is
 * named rather than papered over.
 *
 * The server reads through the same `readArtifactRange` the host uses, so the
 * bytes come from the immutable artifact and every byte is accounted.
 *
 * @param store - the artifact store holding the captured object.
 * @param descriptor - the observation whose artifact is served.
 * @param io - the counters the SERVER's reads are accounted in.
 */
async function servePagesOverSocket(
  store: ArtifactStore,
  descriptor: ObservationDescriptor,
  io: IoCounters,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(socket => {
    let carry = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      carry += chunk
      let newline = carry.indexOf('\n')
      while (newline !== -1) {
        const line = carry.slice(0, newline)
        carry = carry.slice(newline + 1)
        newline = carry.indexOf('\n')
        let request: { want?: number; length?: number }
        try {
          request = JSON.parse(line) as { want?: number; length?: number }
        } catch {
          continue
        }
        if (typeof request.want !== 'number' || typeof request.length !== 'number') continue
        void readArtifactRange(store, descriptor, { offset: request.want, length: request.length }, io)
          .then(bytes => { socket.write(`${Buffer.from(bytes).toString('base64')}\n`) })
          .catch(() => { socket.destroy() })
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('the page server did not report a TCP address')
  }
  return {
    port: address.port,
    close: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

/**
 * Mount the REAL `ipython` tool over a REAL ipykernel (M3's package).
 *
 * Returns the context and a teardown that stops the kernel, so a failure cannot
 * leave an orphaned ipykernel process behind -- the same discipline the crash
 * test applies to its forked child.
 */
async function mountIpythonTool(root: string): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const pkg = ipythonPackageRoot()
  const { KernelService } = await import(pathToFileURL(join(pkg, 'src', 'kernel-plugin.ts')).href) as {
    KernelService: new (ctx: Context, config: {
      pythonExecutable: string
      brokerScript: string
      root: string
    }) => { close: () => Promise<void> }
  }
  const ipyTool = await import(pathToFileURL(join(pkg, 'src', 'ipython-tool.ts')).href) as {
    apply: (ctx: Context) => void
  }
  const Subprocess = (await import('@deepseek-ai/dsh-subprocess-local')).default
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  const service = new KernelService(ctx, {
    pythonExecutable: pythonPath(),
    brokerScript: join(pkg, 'src', 'broker.py'),
    root,
  })
  ipyTool.apply(ctx)
  return {
    ctx,
    dispose: async () => {
      await service.close().catch(() => undefined)
      await ctx.fiber.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// DAT-01 -- a single 100 KiB line recovered byte-for-byte, no 2000-char tail loss
// ---------------------------------------------------------------------------

describe('DAT-01 [real] long line: the loss is verified, then repaired by byte range', () => {
  it('confirms the real buildWindow clips a 100KiB single line and loses its interior', async () => {
    // The line is 100 KiB of a repeating pattern with a distinguishable TAIL, so a
    // truncated result is detectable by content and not only by length.
    const head = 'HEAD-'.repeat(100)
    const tail = '-TAILMARKER'
    const line = `${head}${'A'.repeat(102400 - head.length - tail.length)}${tail}`
    expect(Buffer.byteLength(line, 'utf8')).toBe(102400)

    const window = await buildWindow(
      [line],
      { offset: 1, limit: 2000, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES },
      'long.txt',
    )

    // totalLines is 1: the file is a single line, which is exactly why a line-offset
    // re-read cannot help. The interior is lost, not the tail lines.
    expect(window.totalLines).toBe(1)
    expect(window.lines).toHaveLength(1)
    const text = window.lines[0]?.text ?? ''
    expect(text.length).toBe(READ_MAX_LINE_LENGTH + '... (line truncated to 2000 chars)'.length)
    expect(text).toContain('... (line truncated to 2000 chars)')
    // The real tail marker is GONE from the canonical value.
    expect(text).not.toContain('TAILMARKER')
    // And the recovered text is not even a prefix of the line, because the suffix is
    // appended: it is a DIFFERENT string that cannot be trimmed back to the original.
    expect(line.startsWith(text)).toBe(false)

    // Re-reading with a larger offset cannot recover the interior: there is no line 2.
    await expect(buildWindow(
      [line],
      { offset: 2, limit: 2000, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES },
      'long.txt',
    )).rejects.toThrow(/offset 2 is out of range/u)
  })

  it('measures the clip in the CANONICAL value by CALLING the real read tool', async () => {
    // The finding has one step that `buildWindow` alone cannot establish: that the
    // clipped lines ARE the value the tool returns. `read.ts:157` assigns
    // `window.lines` into `outcome`, which is why the loss is canonical rather
    // than a rendering choice. R5 measures that assignment instead of citing it,
    // because the distinction decides whether a consumer could ever ask again.
    const root = tempRoot('dat01-tool')
    const head = 'HEAD-'.repeat(100)
    const tail = '-TAILMARKER'
    const line = `${head}${'A'.repeat(102400 - head.length - tail.length)}${tail}`
    writeFileSync(join(root, 'long.txt'), line)

    const ctx = await mountReadTool(root)
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('dat01-read'),
        name: 'read',
        arguments: { file_path: 'long.txt' },
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error(`read failed: ${result.error.info?.code ?? 'unknown'}`)

      // The CANONICAL value, exactly as the schema declares it.
      const value = asRecord(result.value)
      expect(Object.keys(value).sort()).toEqual(['lines', 'offset', 'path', 'totalLines'])
      expect(value['totalLines']).toBe(1)
      const lines = value['lines']
      expect(Array.isArray(lines)).toBe(true)
      if (!Array.isArray(lines)) throw new Error('read returned no lines array')
      expect(lines).toHaveLength(1)
      const first = asRecord(lines[0])
      const text = typeof first['text'] === 'string' ? first['text'] : ''
      expect(text.length).toBe(READ_MAX_LINE_LENGTH + '... (line truncated to 2000 chars)'.length)
      expect(text).toContain('... (line truncated to 2000 chars)')
      // The tail marker is absent from the CANONICAL value, not merely from the
      // rendered text -- so no later consumer can recover it from this result.
      expect(text).not.toContain('TAILMARKER')
      // And it is not a prefix of the original, so `slice` cannot trim it back.
      expect(line.startsWith(text)).toBe(false)
      // The rendered envelope is the same clipped line, which is what makes the
      // model-facing text a faithful view of a value that is ALREADY lossy.
      const rendered = contentText(result)
      expect(rendered).toContain('... (line truncated to 2000 chars)')
      expect(rendered).not.toContain('TAILMARKER')

      // The tool's OWN error for a past-EOF offset, which is the exit a consumer
      // would reach for and which cannot help: line 2 does not exist.
      const past = await ctx.tools.execute({
        callId: ToolCallId('dat01-read-offset2'),
        name: 'read',
        arguments: { file_path: 'long.txt', offset: 2 },
        signal: new AbortController().signal,
      })
      expect(past.isError).toBe(true)
      expect(past.isError ? past.error.info?.code : undefined).toBe('FS_NOT_FOUND')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shows a raised maxLineLength recovers the line, so the loss is the CAP and not the file', async () => {
    // The honest boundary of the finding, asserted rather than left implicit: the
    // bytes are on disk and reachable through the SAME tool when the cap is raised
    // above the line length. What no configuration recovers is the interior of a
    // value already returned clipped -- which is why the repair reads bytes of a
    // captured object rather than re-asking `read`.
    const line = `${'B'.repeat(102400 - 9)}-TAILMARK`
    const raised = await buildWindow(
      [line],
      { offset: 1, limit: 1, maxLineLength: 200_000, maxBytes: 50 * 1024 * 1024 },
      'raised.txt',
    )
    const text = raised.lines[0]?.text ?? ''
    expect(text.length).toBe(102400)
    expect(text).toContain('-TAILMARK')
    expect(text).toBe(line)
  })

  it('recovers the whole 100KiB line byte-for-byte by capturing and paging the artifact', async () => {
    const root = tempRoot('dat01')
    // Exactly 100 KiB, with a tail marker so a truncated recovery is detectable by
    // CONTENT and not only by length.
    const head = 'HEAD-'.repeat(100)
    const tail = '-TAILMARKER'
    const padding = 102400 - head.length - tail.length
    expect(padding).toBeGreaterThan(0)
    const line = `${head}${'A'.repeat(padding)}${tail}`
    const source = join(root, 'long.txt')
    writeFileSync(source, line)
    const sourceBytes = readFileSync(source)
    expect(sourceBytes.byteLength).toBe(102400)

    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat01-store')
    const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }

    const capture = await captureFile({
      fs,
      path: 'long.txt',
      store,
      log,
      grants,
      ownerScope: scope,
      executionWorld: 'local',
      observationId: 'obs-dat01',
      mediaType: 'text/plain',
    })
    expect(capture.reference.state).toBe('durable')
    expect(capture.descriptor.captured.bytes).toBe(102400)
    expect(capture.descriptor.captured.sha256).toBe(sha256(sourceBytes))
    expect(capture.descriptor.acquisition.completeness).toBe('complete-within-request')
    expect(capture.gaps).toHaveLength(0)

    // Page the artifact at 64 KiB: two pages, reassembled byte-for-byte.
    const collected: ArtifactPage[] = []
    const provider = new ArtifactStorePageProvider(store)
    const walk = await walkPages(provider, {
      descriptor: capture.descriptor,
      maxBytes: DEFAULT_PAGE_BYTES,
      grants,
      callerScope: scope,
    }, { onPage: page => { collected.push(page) }, counters: io })

    expect(walk.exhausted).toBe(true)
    expect(walk.pages).toBe(2)
    const joined = joinPages(collected, capture.descriptor.captured.bytes)
    expect(joined.byteLength).toBe(102400)
    expect(sha256(joined)).toBe(sha256(sourceBytes))
    expect(Buffer.from(joined).toString('utf8')).toBe(line)
    // The tail marker the read tool lost is present in the recovered bytes.
    expect(Buffer.from(joined).toString('utf8')).toContain('TAILMARKER')

    // The line index gives the line as ONE line with its full byte length, and the
    // single-line read returns it without any cap.
    const index = await buildLineIndex(store, capture.descriptor)
    expect(index.totalLines).toBe(1)
    expect(index.entries).toHaveLength(1)
    expect(index.entries[0]?.length).toBe(102400)
    const lineBytes = await readLineBytes(store, capture.descriptor, index.entries[0]!, io)
    expect(lineBytes.byteLength).toBe(102400)
    expect(Buffer.from(lineBytes).toString('utf8')).toBe(line)
    expect(lineBytes.byteLength).toBeGreaterThan(READ_MAX_LINE_LENGTH)
  })

  it('recovers a newline-free file as exactly one complete line', async () => {
    const root = tempRoot('dat01-nonl')
    // No newline at all, and longer than the 50 KiB byte window.
    const content = 'Z'.repeat(120 * 1024)
    writeFileSync(join(root, 'nonl.txt'), content)
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat01-nonl-store')

    const capture = await captureFile({
      fs, path: 'nonl.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-nonl', mediaType: 'text/plain',
    })
    const index = await buildLineIndex(store, capture.descriptor)
    expect(index.totalLines).toBe(1)
    expect(index.entries[0]?.length).toBe(120 * 1024)
    const lineBytes = await readLineBytes(store, capture.descriptor, index.entries[0]!)
    expect(Buffer.from(lineBytes).toString('utf8')).toBe(content)
    // The read tool's byte cap would have stopped well before this.
    expect(lineBytes.byteLength).toBeGreaterThan(READ_MAX_BYTES)
  })

  it('recovers a body larger than the 50KiB read window across many lines', async () => {
    const root = tempRoot('dat01-50k')
    const lines = Array.from({ length: 3000 }, (_, index) => `line-${index}-${'x'.repeat(40)}`)
    const content = lines.join('\n')
    writeFileSync(join(root, 'big.txt'), content)
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(READ_MAX_BYTES)
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat01-50k-store')
    const capture = await captureFile({
      fs, path: 'big.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-50k', mediaType: 'text/plain',
    })
    const index = await buildLineIndex(store, capture.descriptor)
    expect(index.totalLines).toBe(3000)
    // Line 2999 (the last) is reachable by byte range even though the read window
    // would have been capped at 50 KiB long before it.
    const last = index.entries.at(-1)!
    const bytes = await readLineBytes(store, capture.descriptor, last)
    expect(Buffer.from(bytes).toString('utf8')).toBe(lines[2999])
  })
})

// ---------------------------------------------------------------------------
// DAT-02 -- 512 pages totalling 32 MiB in ONE consumption, projection <= 8 KiB
// ---------------------------------------------------------------------------

describe('DAT-02 [real capture / real consumers] 512 pages of 32MiB, projection <= 8KiB', () => {
  it('consumes 512 bounded pages totalling 32MiB with a model projection under 8KiB', async () => {
    const root = tempRoot('dat02')
    // Exactly 32 MiB of real bytes on disk, in 512 * 64 KiB pages.
    const pageBytes = DEFAULT_PAGE_BYTES
    const totalBytes = 512 * pageBytes
    expect(totalBytes).toBe(32 * 1024 * 1024)
    // Built as one buffer of newline-separated records so the index has real work.
    const record = `${'r'.repeat(1022)}\n`
    const buffer = Buffer.alloc(totalBytes)
    for (let offset = 0; offset < totalBytes; offset += record.length) {
      buffer.write(record, offset, 'utf8')
    }
    const source = join(root, 'big32.txt')
    writeFileSync(source, buffer)
    expect(statSync(source).size).toBe(totalBytes)

    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat02-store')
    const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }

    const capture = await captureFile({
      fs, path: 'big32.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-dat02', mediaType: 'text/plain',
    })
    expect(capture.descriptor.captured.bytes).toBe(totalBytes)

    // The ONE consumption. In M3 this is a single `python_exec` whose body drives
    // the same native page calls; the seam is identical, so the count is the same.
    // The consumer is a JS reducer here; the two tests below replace it with a
    // real CPython process and a real ipykernel, so this one is the cheap check
    // that the page COUNT and the digest agree before either slower consumer runs.
    const provider = new ArtifactStorePageProvider(store)
    const digest = createHash('sha256')
    let pagesConsumed = 0
    let bytesConsumed = 0
    const walk = await walkPages(provider, {
      descriptor: capture.descriptor,
      maxBytes: pageBytes,
      grants,
      callerScope: scope,
    }, {
      counters: io,
      onPage: page => {
        // A real consumer's work: hash the page so every byte is touched and a
        // missing or duplicated page changes the digest.
        digest.update(page.bytes)
        pagesConsumed += 1
        bytesConsumed += page.bytes.byteLength
      },
    })

    expect(walk.exhausted).toBe(true)
    expect(pagesConsumed).toBe(512)
    expect(bytesConsumed).toBe(totalBytes)
    // The digest over the paged stream equals the digest of the source: every byte
    // was consumed exactly once, in order.
    expect(digest.digest('hex')).toBe(sha256(buffer))

    const projection = projectForModel({
      descriptor: capture.descriptor,
      pagesConsumed,
      bytesConsumed,
      exhausted: walk.exhausted,
      consumerNote: 'hashed every page; no page bytes retained in context',
    })
    const projectionBytes = Buffer.byteLength(JSON.stringify(projection), 'utf8')
    expect(projectionBytes).toBeLessThanOrEqual(8 * 1024)

    // Recorded here so the evidence file can quote the real numbers rather than
    // restate the assertions.
    console.log('[DAT-02] artifactBytes', capture.descriptor.captured.bytes,
      'pages', pagesConsumed, 'bytesConsumed', bytesConsumed,
      'projectionBytes', projectionBytes, 'sourceBytesReadDuringCapture', io.sourceBytesRead,
      'artifactBytesReadDuringPaging', io.artifactBytesRead, 'artifactReads', io.artifactReads)
    expect(projectionBytes).toBeLessThanOrEqual(8 * 1024)
  })

  it('has a REAL CPython process consume the 512 pages over a pipe, never holding them in JS', async () => {
    // Same stimulus, different consumer: the bytes leave the JS heap entirely and
    // are hashed by CPython. This is the process-boundary half of the gate.
    const root = tempRoot('dat02-py')
    const pageBytes = DEFAULT_PAGE_BYTES
    const totalBytes = 512 * pageBytes
    const record = `${'r'.repeat(1022)}\n`
    const buffer = Buffer.alloc(totalBytes)
    for (let offset = 0; offset < totalBytes; offset += record.length) buffer.write(record, offset, 'utf8')
    writeFileSync(join(root, 'big32.txt'), buffer)

    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat02-py-store')
    const capture = await captureFile({
      fs, path: 'big32.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-dat02-py', mediaType: 'text/plain',
    })
    expect(capture.descriptor.captured.bytes).toBe(totalBytes)

    // Python drives the page walk: it asks for the next range, hashes the bytes it
    // receives, and reports only counts and a digest -- never the bytes.
    const script = [
      'import sys, json, base64, hashlib',
      'h = hashlib.sha256()',
      'pages = 0',
      'total = 0',
      'offset = 0',
      'SIZE = 65536',
      'LIMIT = 33554432',
      'while offset < LIMIT:',
      '    print(json.dumps({"want": offset, "length": SIZE}), flush=True)',
      '    line = sys.stdin.readline()',
      '    if not line:',
      '        break',
      '    data = base64.b64decode(line.strip())',
      '    if not data:',
      '        break',
      '    h.update(data)',
      '    pages += 1',
      '    total += len(data)',
      '    offset += len(data)',
      'print(json.dumps({"pages": pages, "bytes": total, "sha256": h.hexdigest(), "done": True}), flush=True)',
    ].join('\n')

    const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
    const result = await runPythonPageConsumer(script, async request => {
      // Each request is served from the IMMUTABLE artifact, accounted as real IO.
      const bytes = await readArtifactRange(store, capture.descriptor, request, io)
      return bytes
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const finalLine = result.stdout.trim().split('\n').at(-1) ?? ''
    const summary = JSON.parse(finalLine) as { pages: number; bytes: number; sha256: string; done: boolean }
    // CPython consumed all 512 pages and every byte.
    expect(summary.done).toBe(true)
    expect(summary.pages).toBe(512)
    expect(summary.bytes).toBe(totalBytes)
    // And its digest matches the source: no page lost, duplicated, or reordered
    // across the process boundary.
    expect(summary.sha256).toBe(sha256(buffer))
    expect(io.artifactBytesRead).toBe(totalBytes)
    expect(io.artifactReads).toBe(512)

    // The model-visible projection of that whole consumption is still bounded.
    const projection = projectForModel({
      descriptor: capture.descriptor,
      pagesConsumed: summary.pages,
      bytesConsumed: summary.bytes,
      exhausted: true,
      consumerNote: `cpython sha256=${summary.sha256}`,
    })
    expect(Buffer.byteLength(JSON.stringify(projection), 'utf8')).toBeLessThanOrEqual(8 * 1024)

    console.log('[DAT-02-python] realCpython pages', summary.pages, 'bytes', summary.bytes,
      'sha256MatchesSource', summary.sha256 === sha256(buffer),
      'artifactReads', io.artifactReads,
      'projectionBytes', Buffer.byteLength(JSON.stringify(projection), 'utf8'))
  })

  it('has the REAL `ipython` tool over a REAL ipykernel consume all 512 pages', async () => {
    // R5: the substitution this gate used to carry is GONE.
    //
    // The M4 report admitted `dataToolPresent: false` and used a bare `python -c`
    // process, on the stated grounds that `packages/dsh-ipython` (M3) did not
    // exist. It exists now, and M11/M12 prove a real ipykernel boots and the
    // `ipython` tool reaches a Session's catalog. So the consumption below runs
    // through the PRODUCT'S OWN TOOL -- `ctx.tools.execute({ name: 'ipython' })` --
    // against a real `ipykernel.zmqshell` kernel, and the pages come from the real
    // artifact store with the real `IoCounters`.
    //
    // WHAT IS STILL NOT PROVEN, and cannot be on this tree: a cell cannot call
    // `data.pages` as a NATIVE tool, because M3's broker exposes no cell-to-host
    // call channel (it registers no comm and injects no host object into the user
    // namespace). The test below MEASURES that absence rather than assuming it, so
    // the claim and its boundary are both evidence.
    if (!ipythonPackageExists()) {
      throw new Error(
        'packages/dsh-ipython is absent, so the real-kernel consumption cannot run; '
        + 'this test must NOT be silently skipped, because the whole point is that the '
        + 'substitution is gone',
      )
    }

    const root = tempRoot('dat02-ipy')
    const pageBytes = DEFAULT_PAGE_BYTES
    const totalBytes = 512 * pageBytes
    const record = `${'r'.repeat(1022)}\n`
    const buffer = Buffer.alloc(totalBytes)
    for (let offset = 0; offset < totalBytes; offset += record.length) buffer.write(record, offset, 'utf8')
    writeFileSync(join(root, 'big32.txt'), buffer)

    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat02-ipy-store')
    const capture = await captureFile({
      fs, path: 'big32.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-dat02-ipy', mediaType: 'text/plain',
    })
    expect(capture.descriptor.captured.bytes).toBe(totalBytes)

    const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
    const served = await servePagesOverSocket(store, capture.descriptor, io)
    const kernel = await mountIpythonTool(join(root, 'kernels'))
    try {
      // The kernel service reads `agent.session.header.id` and nothing else, so a
      // Session-bearing stand-in is the whole requirement. It is cast ONCE, here,
      // rather than at each call site, so the fact that this is not a full Agent
      // is stated in one place.
      const agent = { session: { header: { id: `dat02-ipy-${Date.now()}`, cwd: root } } } as unknown as Agent
      const cell = [
        'import json, socket, base64, hashlib',
        `s = socket.create_connection(("127.0.0.1", ${served.port}))`,
        'h = hashlib.sha256()',
        'pages = 0',
        'total = 0',
        'offset = 0',
        `while offset < ${totalBytes}:`,
        '    s.sendall((json.dumps({"want": offset, "length": 65536}) + "\\n").encode())',
        '    buf = b""',
        '    while not buf.endswith(b"\\n"):',
        '        piece = s.recv(1 << 20)',
        '        if not piece:',
        '            break',
        '        buf += piece',
        '    data = base64.b64decode(buf.strip())',
        '    if not data:',
        '        break',
        '    h.update(data)',
        '    pages += 1',
        '    total += len(data)',
        '    offset += len(data)',
        's.close()',
        'print(json.dumps({"pages": pages, "bytes": total, "sha256": h.hexdigest()}))',
      ].join('\n')

      const walked = await kernel.ctx.tools.execute({
        callId: ToolCallId('dat02-ipy'),
        name: 'ipython',
        arguments: { code: cell },
        agent,
        signal: new AbortController().signal,
      })
      expect(walked.isError).toBe(false)
      if (walked.isError) throw new Error(`ipython failed: ${walked.error.info?.code ?? 'unknown'}`)
      const walkedValue = asRecord(walked.value)
      expect(walkedValue['outcome']).toBe('ok')
      const walkedText = typeof walkedValue['text'] === 'string' ? walkedValue['text'] : ''
      const summary = JSON.parse(
        /^\{.*\}$/mu.exec(walkedText)?.[0] ?? '{}',
      ) as { pages?: number; bytes?: number; sha256?: string }

      // The real kernel consumed every page, and its digest matches the source.
      expect(summary.pages).toBe(512)
      expect(summary.bytes).toBe(totalBytes)
      expect(summary.sha256).toBe(sha256(buffer))
      // The bytes came from the ARTIFACT, counted by the real store.
      expect(io.artifactBytesRead).toBe(totalBytes)
      expect(io.artifactReads).toBe(512)

      const projection = projectForModel({
        descriptor: capture.descriptor,
        pagesConsumed: summary.pages ?? 0,
        bytesConsumed: summary.bytes ?? 0,
        exhausted: true,
        consumerNote: `real ipykernel sha256=${summary.sha256 ?? ''}`,
      })
      const projectionBytes = Buffer.byteLength(JSON.stringify(projection), 'utf8')
      expect(projectionBytes).toBeLessThanOrEqual(8 * 1024)

      // THE MEASURED ABSENCE: a cell cannot reach the data plane as a native tool.
      // This is the boundary of the gate, asserted so it cannot be over-read.
      const reach = await kernel.ctx.tools.execute({
        callId: ToolCallId('dat02-ipy-reach'),
        name: 'ipython',
        arguments: { code: [
          'names = [n for n in ("data", "tools", "dsh", "dailyData") if n in globals()]',
          'try:',
          '    import data  # noqa: F401',
          '    names.append("import data")',
          'except Exception as exc:',
          '    names.append("import data FAILED: " + type(exc).__name__)',
          'print("REACH", names)',
        ].join('\n') },
        agent,
        signal: new AbortController().signal,
      })
      expect(reach.isError).toBe(false)
      if (reach.isError) throw new Error('the reachability cell failed')
      const reachValue = asRecord(reach.value)
      const reachText = typeof reachValue['text'] === 'string' ? reachValue['text'] : ''
      // No name resolves: the native `data.*` path does not exist yet, and this
      // line is what stops the test above from being read as "a cell can page".
      expect(reachText).toContain('import data FAILED: ModuleNotFoundError')

      console.log('[DAT-02-ipykernel] realKernel pages', summary.pages, 'bytes', summary.bytes,
        'sha256MatchesSource', summary.sha256 === sha256(buffer),
        'artifactReads', io.artifactReads, 'projectionBytes', projectionBytes,
        'cellReachedDataPlane', false)
    } finally {
      await served.close()
      await kernel.dispose()
    }
  }, 180_000)
})

// ---------------------------------------------------------------------------
// DAT-03 -- UTF-8, CRLF and JSONL records split at EVERY page boundary
// ---------------------------------------------------------------------------

describe('DAT-03 [real] UTF-8 / CRLF / JSONL split at every page boundary', () => {
  it('never corrupts a multibyte character at any page boundary', () => {
    // A run of 3-byte and 4-byte characters, so a fixed-byte cut lands mid-sequence
    // for most sizes.
    const content = Buffer.from('漢'.repeat(200) + '😀'.repeat(200) + 'é'.repeat(300), 'utf8')
    const original = content.toString('utf8')
    for (let pageSize = 1; pageSize <= 96; pageSize += 1) {
      const parts = [...pageUtf8ByBytes(content, pageSize)]
      const joined = Buffer.concat(parts.map(part => Buffer.from(part.bytes)))
      // Byte-for-byte equality across every page size: no loss, no duplication.
      expect(joined.equals(content)).toBe(true)
      // And each individual page is independently valid UTF-8, which is what makes
      // it safe for a consumer to decode page-by-page.
      for (const part of parts) {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(part.bytes)
        expect(decoded).not.toContain('\ufffd')
      }
      expect(joined.toString('utf8')).toBe(original)
      // A page walk must always advance, so the stall guard cannot trip on progress.
      for (const part of parts) expect(part.bytes.byteLength).toBeGreaterThan(0)
    }
  })

  // A TIMEOUT BUDGET, NOT A WEAKER ORACLE. The sweep below opens the real object
  // once per page, and `pageSize = 1` alone is ~15,000 sequential opens of a real
  // file. That measured 15.5s when this test was written and 18.9s on a loaded
  // machine, so the 60s default left too little headroom for a busy box and the
  // test failed for a reason that has nothing to do with page boundaries. Every
  // assertion is unchanged; only the wall-clock allowance is.
  it('splits CRLF and JSONL records at every page boundary without loss or duplication', { timeout: 240_000 }, async () => {
    const root = tempRoot('dat03')
    const records = Array.from({ length: 400 }, (_, index) =>
      JSON.stringify({ i: index, note: `漢字-${index}`, pad: 'p'.repeat(index % 37) }))
    // CRLF line endings, so a page boundary can land between CR and LF.
    const content = records.join('\r\n') + '\r\n'
    const bytes = Buffer.from(content, 'utf8')
    writeFileSync(join(root, 'records.jsonl'), bytes)

    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat03-store')
    const capture = await captureFile({
      fs, path: 'records.jsonl', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-dat03', mediaType: 'application/x-ndjson',
    })

    // Sweep page sizes so boundaries land inside multi-byte characters, between CR
    // and LF, and inside JSON records.
    for (const pageSize of [1, 2, 3, 5, 7, 16, 64, 100, 997, 4096]) {
      const parts: Uint8Array[] = []
      let offset = 0
      while (offset < bytes.length) {
        const length = Math.min(pageSize, bytes.length - offset)
        parts.push(await readArtifactRange(store, capture.descriptor, { offset, length }))
        offset += length
      }
      const joined = Buffer.concat(parts.map(part => Buffer.from(part)))
      expect(joined.equals(bytes)).toBe(true)

      // Decoding the reassembled stream must yield every record exactly once.
      const decoded = joined.toString('utf8')
      const lines = decoded.split('\r\n').slice(0, -1)
      expect(lines).toHaveLength(records.length)
      expect(lines).toEqual(records)
      const parsed = lines.map(line => JSON.parse(line) as { i: number })
      expect(parsed.map(item => item.i)).toEqual(records.map((_, index) => index))
      // No duplicate: the set size equals the record count.
      expect(new Set(parsed.map(item => item.i)).size).toBe(records.length)
    }
  })

  it('keeps the line index numbering identical to the read tool for CRLF content', async () => {
    const root = tempRoot('dat03-crlf')
    const content = 'alpha\r\nbeta\r\ngamma\r\n'
    writeFileSync(join(root, 'crlf.txt'), content)
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat03-crlf-store')
    const capture = await captureFile({
      fs, path: 'crlf.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-crlf', mediaType: 'text/plain',
    })
    const index = await buildLineIndex(store, capture.descriptor)
    expect(index.totalLines).toBe(3)
    // The index's line text (minus CR) must equal what `read` reports, or the byte
    // range and the line-numbered view would disagree about the same file.
    const toolWindow = await buildWindow(
      [content],
      { offset: 1, limit: 2000, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES },
      'crlf.txt',
    )
    const fromIndex = []
    for (const entry of index.entries) {
      fromIndex.push(Buffer.from(await readLineBytes(store, capture.descriptor, entry)).toString('utf8'))
    }
    expect(fromIndex).toEqual(toolWindow.lines.map(line => line.text))
    expect(fromIndex).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('truncates a projection on a character boundary, never splitting a surrogate', () => {
    const emoji = '😀'.repeat(50)
    const cut = truncateUtf8(emoji, 9)
    // 4 bytes per emoji, so 9 bytes can only hold two whole characters.
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(9)
    expect(cut).toBe('😀😀')
    // The cut must not leave a lone surrogate, which would serialize as invalid JSON.
    expect([...cut].every(character => character.length <= 2)).toBe(true)
    expect(JSON.parse(JSON.stringify({ cut })) as { cut: string }).toEqual({ cut: '😀😀' })
  })

  it('states the real pager\u2019s boundary: byte windows reassemble, they are not character-aligned', async () => {
    // THE HONEST BOUNDARY OF THE GATE, measured rather than implied.
    //
    // The test above exercises `pageUtf8ByBytes`, which IS character-aligned by
    // construction. The PRODUCTION pager (`pages` / `walkPages`) does NOT use it:
    // it serves fixed-size byte windows from the artifact, because the cursor is a
    // BYTE position and a page must be exactly the range the caller asked for. A
    // byte window can therefore end mid-character.
    //
    // That is not corruption of the artifact -- reassembly is byte-exact -- but it
    // does mean an INDIVIDUAL page is not guaranteed to be independently decodable.
    // The two facts are asserted separately here so neither is inferred from the
    // other, and so a consumer that needs per-page validity knows which function
    // to use.
    const root = tempRoot('dat03-pager')
    const content = '😀'.repeat(1000)
    const bytes = Buffer.from(content, 'utf8')
    writeFileSync(join(root, 'emoji.txt'), bytes)
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat03-pager-store')
    const capture = await captureFile({
      fs, path: 'emoji.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-emoji', mediaType: 'text/plain',
    })

    // The real pager at a page size that is NOT a multiple of 4.
    const collected: ArtifactPage[] = []
    await walkPages(new ArtifactStorePageProvider(store), {
      descriptor: capture.descriptor, maxBytes: 997, grants, callerScope: scope,
    }, { onPage: page => { collected.push(page) } })

    // Byte-exact reassembly, which is the guarantee that matters for the artifact.
    const joined = Buffer.concat(collected.map(page => Buffer.from(page.bytes)))
    expect(joined.equals(bytes)).toBe(true)
    expect(joined.toString('utf8')).toBe(content)
    expect(joined.toString('utf8')).not.toContain('\ufffd')

    // And at least one INDIVIDUAL page is not valid standalone UTF-8, which is the
    // boundary. If this ever becomes false the test is no longer measuring the
    // documented behaviour, so the assertion is on the observed fact, not a hope.
    const invalid = collected.filter(page => {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(page.bytes)
        return false
      } catch {
        return true
      }
    })
    expect(invalid.length).toBeGreaterThan(0)

    // `pageUtf8ByBytes` is the character-aligned alternative, and it keeps every
    // page valid while still covering the whole input.
    const aligned = [...pageUtf8ByBytes(bytes, 997)]
    expect(Buffer.concat(aligned.map(part => Buffer.from(part.bytes))).equals(bytes)).toBe(true)
    for (const part of aligned) {
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(part.bytes)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// DAT-04 -- a repeated or backwards cursor raises pagination-stalled
// ---------------------------------------------------------------------------

/**
 * THIS IS THE ONLY MOCK IN THIS FILE, AND THE REASON IS STRUCTURAL.
 *
 * A correct page provider CANNOT return a repeated or backwards cursor: the
 * cursor is minted by `CursorAuthority.mint` from the position the page ended at,
 * so `pages()` always advances. The guard therefore cannot be reached through the
 * real `ArtifactStorePageProvider` at all -- a test that only exercised the real
 * provider would assert nothing about the guard.
 *
 * So the stimulus here is a provider that VIOLATES the contract on purpose, and
 * the track label `[mock provider]` is on the describe block so no reader can
 * mistake these results for real-backend ones. The last test in the block is the
 * counterweight: the SAME driver, over the REAL store, must still finish -- a
 * guard that rejected legitimate walks would be worse than no guard.
 */
describe('DAT-04 [mock provider] a repeated or backwards cursor raises pagination-stalled', () => {
  /** A provider that always returns the SAME cursor. The classic infinite loop. */
  class RepeatingCursorProvider implements PageProvider {
    calls = 0

    async next(request: PageRequest): Promise<ArtifactPage> {
      this.calls += 1
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        offset: request.cursor === undefined ? 0 : 4,
        sha256: 'a'.repeat(64),
        exhausted: false,
        nextCursor: 'the-same-cursor-forever',
      }
    }
  }

  /** A provider whose second page resumes BEHIND the first. */
  class BackwardsCursorProvider implements PageProvider {
    calls = 0

    async next(): Promise<ArtifactPage> {
      this.calls += 1
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        offset: this.calls === 1 ? 8 : 0,
        sha256: 'b'.repeat(64),
        exhausted: false,
        nextCursor: `cursor-${this.calls}`,
      }
    }
  }

  /** A provider that claims more data but supplies no continuation. */
  class MissingCursorProvider implements PageProvider {
    async next(): Promise<ArtifactPage> {
      return {
        bytes: new Uint8Array([1]),
        offset: 0,
        sha256: 'c'.repeat(64),
        exhausted: false,
      }
    }
  }

  // Annotated rather than inferred: `OBSERVATION_SCHEMA_VERSION` widens to
  // `number` in a mutable object literal, and the descriptor's version is a
  // literal type on purpose -- an older descriptor must not typecheck.
  const descriptor: ObservationDescriptor = {
    id: 'obs-mock',
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    source: { kind: 'tool' as const, acquiredAt: '2026-09-20T00:00:00.000Z', executionWorld: 'mock' },
    captured: { artifact: `artifact:sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1_000_000, mediaType: 'text/plain' },
    acquisition: { completeness: 'complete-within-request' as const, coverage: null, gaps: [] },
    authority: { ownerScope: 'project:mock', grantRevision: 1 },
  }

  function mockRequest(): Omit<PageRequest, 'cursor'> {
    const grants = new GrantTable()
    grants.bump('project:mock')
    return { descriptor, maxBytes: 4096, grants, callerScope: 'project:mock' }
  }

  it('raises pagination-stalled on a repeated cursor instead of looping forever', async () => {
    const provider = new RepeatingCursorProvider()
    // A real timeout would be needed to detect a hang; the point of the guard is
    // that no timeout is needed. If the guard were missing this would never settle
    // and the test would fail on the suite timeout, which is the honest failure.
    await expect(walkPages(provider, mockRequest(), { maxPages: 1000 }))
      .rejects.toMatchObject({ code: 'pagination-stalled' })
    // THREE calls, not two: the first two pages are legitimate progress (offset 0
    // then 4), and it is the third page that repeats offset 4. The guard can only
    // observe a repeat by asking for the next page, so a guard that fired after two
    // calls would be rejecting a well-formed walk.
    expect(provider.calls).toBe(3)
  })

  it('raises pagination-stalled on a backwards cursor', async () => {
    const provider = new BackwardsCursorProvider()
    await expect(walkPages(provider, mockRequest(), { maxPages: 1000 }))
      .rejects.toMatchObject({ code: 'pagination-stalled' })
    expect(provider.calls).toBe(2)
  })

  it('raises pagination-stalled when a not-exhausted page omits its continuation', async () => {
    const provider = new MissingCursorProvider()
    await expect(walkPages(provider, mockRequest()))
      .rejects.toMatchObject({ code: 'pagination-stalled' })
  })

  it('names the stalled offsets so the failure is diagnosable, not just "stalled"', async () => {
    const provider = new RepeatingCursorProvider()
    await expect(walkPages(provider, mockRequest())).rejects.toThrow(/resumed at offset 4/u)
    try {
      await walkPages(new BackwardsCursorProvider(), mockRequest())
      expect.unreachable('the backwards provider must have stalled')
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactError)
      expect((error as ArtifactError).message).toMatch(/at or before the previous 8/u)
    }
  })

  it('still lets a well-formed provider finish, so the guard is not tripped by progress', async () => {
    // A guard that rejected legitimate walks would be worse than none, so the
    // happy path is asserted with the same driver.
    const store = new LocalArtifactStore(join(tempRoot('dat04-ok'), 'artifacts'))
    const { artifact, bytes } = await store.put([new Uint8Array(300)])
    expect(bytes).toBe(300)
    const grants = new GrantTable()
    const scope = 'project:mock'
    grants.bump(scope)
    const walk = await walkPages(new ArtifactStorePageProvider(store), {
      descriptor: {
        ...descriptor,
        captured: { artifact, sha256: artifact.replace('artifact:sha256:', ''), bytes: 300, mediaType: 'text/plain' },
      },
      maxBytes: 64,
      grants,
      callerScope: scope,
    })
    expect(walk.exhausted).toBe(true)
    expect(walk.pages).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// DAT-05 -- the snapshot is fixed; pages never mix
// ---------------------------------------------------------------------------

describe('DAT-05 [real] a source change after page 1 cannot mix into page 2', () => {
  it('serves page 2 from the same captured hash after the source file is rewritten', async () => {
    const root = tempRoot('dat05')
    const first = `${'A'.repeat(100)}\n${'B'.repeat(100)}\n`
    const source = join(root, 'mutable.txt')
    writeFileSync(source, first)
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat05-store')

    const capture = await captureFile({
      fs, path: 'mutable.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-dat05', mediaType: 'text/plain',
      // A tiny page so page 2 exists for a 204-byte file.
      requestedRange: { offset: 0 },
    })
    const capturedHash = capture.descriptor.captured.sha256
    expect(capturedHash).toBe(sha256(Buffer.from(first, 'utf8')))

    // Read page 1.
    const page1 = await pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope,
    })
    expect(page1.exhausted).toBe(false)
    expect(page1.nextCursor).toBeDefined()

    // Now MUTATE the source file. Same path, same length, different bytes.
    const second = `${'X'.repeat(100)}\n${'Y'.repeat(100)}\n`
    writeFileSync(source, second)
    expect(readFileSync(source, 'utf8')).toBe(second)
    expect(sha256(readFileSync(source))).not.toBe(capturedHash)

    // Page 2 must still come from the captured object.
    const page2 = await pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope, cursor: page1.nextCursor!,
    })
    expect(page2.sha256).toBe(capturedHash)
    // The bytes are the ORIGINAL's, not the rewritten file's.
    const joined = Buffer.concat([Buffer.from(page1.bytes), Buffer.from(page2.bytes)]).toString('utf8')
    expect(joined).toBe(first.slice(0, joined.length))
    expect(joined).not.toContain('X')
    expect(joined).not.toContain('Y')

    // Re-reading the same capture still yields the original bytes in full.
    const whole = await readArtifactRange(store, capture.descriptor, { offset: 0, length: 1_000_000 })
    expect(Buffer.from(whole).toString('utf8')).toBe(first)
  })

  it('refuses a cursor bound to a different artifact rather than splicing two objects', async () => {
    const root = tempRoot('dat05-cross')
    writeFileSync(join(root, 'one.txt'), 'one\n')
    writeFileSync(join(root, 'two.txt'), 'two\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat05-cross-store')
    const captureA = await captureFile({
      fs, path: 'one.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-a', mediaType: 'text/plain',
    })
    const captureB = await captureFile({
      fs, path: 'two.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-b', mediaType: 'text/plain',
    })
    // Force A to have a continuation by capturing something larger.
    writeFileSync(join(root, 'big.txt'), 'z'.repeat(300))
    const captureBig = await captureFile({
      fs, path: 'big.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-big', mediaType: 'text/plain',
    })
    const firstPage = await pages(store, {
      descriptor: captureBig.descriptor, maxBytes: 64, grants, callerScope: scope,
    })
    expect(firstPage.nextCursor).toBeDefined()
    // Using big.txt's cursor against a DIFFERENT descriptor must be refused.
    await expect(pages(store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants, callerScope: scope, cursor: firstPage.nextCursor!,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
    // And a cursor from a different scope is refused even when the artifact matches.
    expect(captureB.descriptor.captured.sha256).not.toBe(captureA.descriptor.captured.sha256)
  })

  it('refuses a cursor after the owner scope is revoked, because a cursor is not authorization', async () => {
    const root = tempRoot('dat05-revoke')
    writeFileSync(join(root, 'big.txt'), 'q'.repeat(300))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat05-revoke-store')
    const capture = await captureFile({
      fs, path: 'big.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-revoke', mediaType: 'text/plain',
    })
    const first = await pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope,
    })
    // The permission domain changes: the host bumps the revision, invalidating every
    // descriptor and cursor minted under the old one.
    grants.bump(scope)
    await expect(pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope, cursor: first.nextCursor!,
    })).rejects.toMatchObject({ code: 'pagination-scope-denied' })
  })
})

// ---------------------------------------------------------------------------
// DAT-06 -- physical IO for P pages; no P-times-full-rescan
// ---------------------------------------------------------------------------

describe('DAT-06 [real] paging IO is O(pages), and repeated read is measured, not assumed', () => {
  it('reports artifact IO proportional to pages read, not to the artifact size', async () => {
    const root = tempRoot('dat06')
    const pageBytes = 64 * 1024
    const totalBytes = 64 * pageBytes
    writeFileSync(join(root, 'io.txt'), Buffer.alloc(totalBytes, 0x61))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat06-store')
    const capture = await captureFile({
      fs, path: 'io.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-io', mediaType: 'text/plain',
    })

    // Read 8 pages out of 64.
    const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
    let read = 0
    const walk = await walkPages(new ArtifactStorePageProvider(store), {
      descriptor: capture.descriptor, maxBytes: pageBytes, grants, callerScope: scope,
    }, { maxPages: 8, counters: io, onPage: page => { read += page.bytes.byteLength } })

    expect(walk.pages).toBe(8)
    expect(read).toBe(8 * pageBytes)
    // The physical read equals the pages consumed: no full rescan, no read-ahead of
    // the whole artifact, and no verify pass over the object per page.
    expect(io.artifactBytesRead).toBe(8 * pageBytes)
    expect(io.artifactReads).toBe(8)
    // The source file was read exactly once, at capture, and never during paging.
    expect(io.sourceBytesRead).toBe(0)
    expect(capture.io.sourceBytesRead).toBe(totalBytes)

    // The line index is ONE linear scan of the artifact, which is the audit's budget.
    // The scan is accounted in the SAME counters as the paging above, so the two
    // costs are comparable rather than living in different units. R5 wired
    // `indexBytesRead`, which had been a field that reported zero for every index
    // ever built -- a counter that cannot move reads as a measurement and is not one.
    const indexIo: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
    const index = await buildLineIndex(store, capture.descriptor, { counters: indexIo })
    expect(index.bytesScanned).toBe(totalBytes)
    expect(indexIo.indexBytesRead).toBe(totalBytes)
    // The index scan is a SUBSET of the artifact bytes: it reads the same object
    // through the same `openRange`, so it counts in both. Asserted so the two
    // counters cannot silently drift into meaning different things.
    expect(indexIo.indexBytesRead).toBe(indexIo.artifactBytesRead)
    // A newline-free file is one line, so the index holds one entry; the scan is
    // still linear and stated.
    expect(index.totalLines).toBe(1)

    console.log('[DAT-06] artifactBytes', totalBytes, 'pagesRead', walk.pages,
      'artifactBytesRead', io.artifactBytesRead, 'artifactReads', io.artifactReads,
      'sourceBytesReadDuringPaging', io.sourceBytesRead, 'indexBytesScanned', index.bytesScanned,
      'indexBytesRead', indexIo.indexBytesRead)
  })

  it('measures whether repeated read with a growing offset rescans the whole file', async () => {
    // This is the audit's INFERENCE from source (`read-render.ts:132-141` scans every
    // chunk to count totalLines). The measurement below either confirms it or
    // refutes it; either way the number is recorded rather than assumed.
    const lineCount = 20_000
    const content = Array.from({ length: lineCount }, (_, index) => `row-${index}`).join('\n')
    const sourceBytes = Buffer.byteLength(content, 'utf8')
    const window = { limit: 100, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES }

    const offsets = [1, 101, 201, 301, 401]
    const measured = await measureRepeatedReadCost(buildWindow, content, window, offsets)

    // Every call scanned the WHOLE file to count totalLines, even though each
    // returned 100 lines. That is the P-times-full-rescan the audit warns about.
    for (const call of measured.perCall) {
      expect(call.bytesScanned).toBe(sourceBytes)
      expect(call.linesReturned).toBe(100)
    }
    expect(measured.totalBytesScanned).toBe(sourceBytes * offsets.length)
    expect(measured.totalBytesScanned).toBeGreaterThan(sourceBytes * 4)
    // The same P pages through the artifact cost P pages, not P scans.
    const root = tempRoot('dat06-compare')
    writeFileSync(join(root, 'cmp.txt'), content)
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat06-compare-store')
    const capture = await captureFile({
      fs, path: 'cmp.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-cmp', mediaType: 'text/plain',
    })
    const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
    await walkPages(new ArtifactStorePageProvider(store), {
      descriptor: capture.descriptor, maxBytes: 4096, grants, callerScope: scope,
    }, { maxPages: 5, counters: io })
    expect(io.artifactBytesRead).toBe(5 * 4096)
    // The artifact path read 20 KiB for five pages against the read path's 5 whole
    // scans of a ~180 KiB file.
    expect(io.artifactBytesRead).toBeLessThan(measured.totalBytesScanned)

    console.log('[DAT-06] repeated-read totalBytesScanned', measured.totalBytesScanned,
      'sourceBytes', sourceBytes, 'calls', offsets.length,
      'artifactBytesReadFor5Pages', io.artifactBytesRead)
  })
})

// ---------------------------------------------------------------------------
// DAT-07 -- grep keeps the canonical set; only the renderer is reduced
// ---------------------------------------------------------------------------

describe('DAT-07 [real ripgrep] grep canonical keeps every match within the raw cap', () => {
  it('keeps all matches in canonical while the renderer shows 250, and marks the raw cap partial', async () => {
    const rg = await realRipgrep()
    const root = tempRoot('dat07')
    // 900 matching lines: more than the 250 inline cap, far below the 20 MB raw cap.
    const matchCount = 900
    const lines = Array.from({ length: matchCount }, (_, index) => `needle-${index}-${'x'.repeat(20)}`)
    writeFileSync(join(root, 'many.txt'), `${lines.join('\n')}\n`)

    // The REAL ripgrep invocation shape the tool uses: `--json`, `--no-config`,
    // `--no-messages`, with the pattern and path as separate argv elements.
    const { stdout } = await execFileAsync(rg, ['--json', '--no-config', 'needle', join(root, 'many.txt')], {
      maxBuffer: 64 * 1024 * 1024,
    })
    const rawBytes = Buffer.byteLength(stdout, 'utf8')

    // Parse with the REAL parser so the canonical match set is the production one.
    // `parseGrepMatches` lives in grep.ts (it is the tool's own `--json` reader);
    // search-core.ts holds the raw cap and the retention pass.
    const searchCore = await import('@deepseek-ai/dsh-tool-fs-search/src/search-core.ts')
    const grep = await import('@deepseek-ai/dsh-tool-fs-search/src/grep.ts')
    const parsed = grep.parseGrepMatches(stdout)
    expect(parsed).toHaveLength(matchCount)

    // CANONICAL keeps every match. The backend raw cap (20 MB) was not reached, so
    // the canonical set is the legitimate complete set.
    expect(searchCore.RAW_OUTPUT_MAX_BYTES).toBe(20_000_000)
    expect(rawBytes).toBeLessThan(searchCore.RAW_OUTPUT_MAX_BYTES)
    const canonical = parsed.map(match => ({ path: match.path, lineNumber: match.lineNumber, line: match.line }))
    expect(canonical).toHaveLength(matchCount)

    // The RENDERER reduces to 250. This is a projection, not a loss of the canonical.
    const retained = searchCore.retainGrepMatches(canonical, grep.GREP_MAX_MATCHES, grep.GREP_MAX_LINE_BYTES)
    expect(grep.GREP_MAX_MATCHES).toBe(250)
    expect(retained.kept).toBe(250)
    expect(retained.seen).toBe(matchCount)
    expect(retained.truncated).toBe(true)
    // `formatGrepOutput` is the exported renderer (`formatRetainedGrep` is private to
    // grep.ts), so this is the same text the model would see.
    const rendered = grep.formatGrepOutput(retained, undefined)
    const renderedLines = rendered.split('\n').filter(line => line.includes('needle-'))
    expect(renderedLines).toHaveLength(250)
    // The renderer's own text says how many it omitted, so the model is told the
    // projection is partial rather than being left to assume it saw everything.
    expect(rendered).toMatch(/650|omitted|more/u)

    // A PYTHON consumer reads the LEGITIMATE CANONICAL SET: every match, from the
    // captured artifact, without going through the renderer. The captured object is
    // the canonical JSON, so all 900 matches are recoverable byte-for-byte. A real
    // CPython process does the reading, because the gate's claim is specifically
    // about what PYTHON can reach -- a JS assertion would not test that.
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat07-store')
    writeFileSync(join(root, 'canonical.json'), JSON.stringify(canonical))
    const capture = await captureFile({
      fs, path: 'canonical.json', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-grep', mediaType: 'application/json',
    })
    const canonicalBytes = await readArtifactRange(store, capture.descriptor, { offset: 0, length: 64 * 1024 * 1024 })
    // Read through the page protocol, so Python walks the artifact rather than being
    // handed one JS buffer.
    const pyScript = [
      'import sys, json, base64',
      'chunks = []',
      'offset = 0',
      'SIZE = 65536',
      'while True:',
      '    print(json.dumps({"want": offset, "length": SIZE}), flush=True)',
      '    line = sys.stdin.readline()',
      '    if not line:',
      '        break',
      '    data = base64.b64decode(line.strip())',
      '    if not data:',
      '        break',
      '    chunks.append(data)',
      '    offset += len(data)',
      'doc = json.loads(b"".join(chunks).decode("utf-8"))',
      'print(json.dumps({"count": len(doc), "first": doc[0]["lineNumber"], "last": doc[-1]["lineNumber"], "distinct": len({m["lineNumber"] for m in doc})}), flush=True)',
    ].join('\n')
    const pyResult = await runPythonPageConsumer(pyScript, async request =>
      readArtifactRange(store, capture.descriptor, request))
    expect(pyResult.code).toBe(0)
    expect(pyResult.stderr).toBe('')
    const pySummary = JSON.parse(pyResult.stdout.trim().split('\n').at(-1) ?? '{}') as {
      count: number
      first: number
      last: number
      distinct: number
    }
    // Python sees the COMPLETE canonical set: all 900, every one distinct.
    expect(pySummary.count).toBe(matchCount)
    expect(pySummary.distinct).toBe(matchCount)
    expect(pySummary.first).toBe(1)
    expect(pySummary.last).toBe(matchCount)
    // The same bytes reassembled in JS agree with Python's parse.
    const fromJs = JSON.parse(Buffer.from(canonicalBytes).toString('utf8')) as typeof canonical
    expect(fromJs).toHaveLength(matchCount)
    expect(fromJs).toEqual(canonical)
    // The artifact's completeness is `complete-within-request`: the canonical set is
    // whole BECAUSE the raw cap was not hit.
    expect(capture.descriptor.acquisition.completeness).toBe('complete-within-request')
    console.log('[DAT-07-python] canonicalCount', pySummary.count, 'distinct', pySummary.distinct,
      'rendererKept', retained.kept)

    console.log('[DAT-07] rawBytes', rawBytes, 'rawCap', searchCore.RAW_OUTPUT_MAX_BYTES,
      'canonicalMatches', canonical.length, 'rendererKept', retained.kept,
      'rendererSeen', retained.seen, 'rendererTruncated', retained.truncated)
  })

  it('marks the observation partial when the raw cap IS reached, without pretending otherwise', async () => {
    // THE ORACLE WAS WEAKER THAN THE CLAIM, and R5 strengthened it.
    //
    // The first version built a `partial` descriptor BY HAND and asserted that
    // `projectForModel` echoed `partial` back. That is a tautology: it tests that
    // the projection copies a field it was handed, and it says nothing about
    // whether the REAL raw-cap path produces `partial` at all. It could not fail
    // if the product were wrong.
    //
    // The real path is now driven: `runRipgrep` with a cap the output exceeds. The
    // measurement (R5, `raw-cap-measurement.json`) is that the product THROWS
    // `SEARCH_RAW_OUTPUT_OVERFLOW` -- it does NOT hand back a truncated match list
    // to be labelled `partial`. So the honest claim is narrower than the original
    // test implied, and both halves are asserted below: the real refusal, and the
    // projection shape a caller must use once it has decided the acquisition is
    // partial.
    const root = tempRoot('dat07-cap')
    const store = new LocalArtifactStore(join(tempRoot('dat07-cap-store'), 'artifacts'))
    const log = new InMemorySessionReferenceLog()
    const grants = new GrantTable()
    const scope = 'project:grep'
    grants.bump(scope)
    const { fs } = mountFs(root)
    writeFileSync(join(root, 'small.txt'), 'one\ntwo\n')

    // (a) THE REAL RAW-CAP PATH: the subprocess seam retains less than the cap and
    // the tool refuses, naming the recovery. Driven through `runRipgrep` -- the
    // same function the `grep` tool calls -- with a 4 KiB cap against 240 KiB of
    // real ripgrep output.
    const searchCore = await import('@deepseek-ai/dsh-tool-fs-search/src/search-core.ts')
    const { Context: ToolContext } = await import('@deepseek-ai/cordis')
    const Subprocess = (await import('@deepseek-ai/dsh-subprocess-local')).default
    const rg = await realRipgrep()
    const many = join(root, 'many.txt')
    writeFileSync(many, `${Array.from({ length: 900 }, (_, index) => `needle-${index}-${'x'.repeat(20)}`).join('\n')}\n`)
    const toolCtx = new ToolContext()
    await toolCtx.plugin(Subprocess)
    try {
      // `runRipgrep` reads `exec.signal` and `exec.agent?.session.header.cwd` and
      // nothing else, so a signal-bearing stand-in is the whole requirement. The
      // checkout's own test for this function uses the same shape.
      const exec = { signal: new AbortController().signal, name: 'grep', callId: ToolCallId('dat07-cap') } as unknown as ToolExecution
      // The generous cap first, so the stimulus is proven to overflow rather than
      // assumed to: the same call succeeds when the cap is the real one.
      const generous = await searchCore.runRipgrep(
        toolCtx, exec, 'grep', ['--json', '--no-config', 'needle', many],
        searchCore.RAW_OUTPUT_MAX_BYTES, 5000, 64 * 1024,
      )
      expect(Buffer.byteLength(generous.stdout, 'utf8')).toBeGreaterThan(4096)
      await expect(searchCore.runRipgrep(
        toolCtx, exec, 'grep', ['--json', '--no-config', 'needle', many],
        4096, 5000, 64 * 1024,
      )).rejects.toMatchObject({ code: 'SEARCH_RAW_OUTPUT_OVERFLOW' })
    } finally {
      await toolCtx.fiber.dispose()
    }
    expect(existsSync(rg)).toBe(true)

    // (b) THE PROJECTION, for a caller that HAS established the acquisition is
    // partial. The descriptor is host-minted and the gap is host-authored, which
    // is the only way a gap may enter a descriptor (`observations.ts`
    // `HOST_AUTHORED_PATHS` refuses a kernel-supplied one).
    const capture = await captureFile({
      fs, path: 'small.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-capped', mediaType: 'text/plain',
    })
    const partial: ObservationDescriptor = {
      ...capture.descriptor,
      acquisition: {
        ...capture.descriptor.acquisition,
        completeness: 'partial' as const,
        gaps: [{
          stage: 'native-acquisition' as const,
          reason: 'grep raw stdout reached rawOutputMaxBytes; the match list is truncated at the transport, not by the renderer',
          recovery: 'none' as const,
        }],
      },
    }
    const projection = projectForModel({
      descriptor: partial,
      pagesConsumed: 1,
      bytesConsumed: 16,
      exhausted: true,
    })
    expect(projection.completeness).toBe('partial')
    expect(projection.gaps).toHaveLength(1)
    expect(projection.gaps[0]?.stage).toBe('native-acquisition')
    expect(projection.gaps[0]?.recovery).toBe('none')
    // A `partial` observation is NOT deliverable as the complete value, which is
    // the property that stops the projection from reading as success.
    const { isDeliverableAsComplete } = await import('./observations.ts')
    expect(isDeliverableAsComplete(partial)).toBe(false)
    expect(isDeliverableAsComplete(capture.descriptor)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DAT-08 -- quota failure is explicit; no inline fallback; no effect re-run
// ---------------------------------------------------------------------------

describe('DAT-08 [real] an over-quota capture fails explicitly and never falls back inline', () => {
  it('returns a partial observation with a retention gap when the quota is exceeded', async () => {
    const root = tempRoot('dat08')
    const content = 'D'.repeat(200 * 1024)
    writeFileSync(join(root, 'too-big.txt'), content)
    const { fs } = mountFs(root)
    // A quota well below the file, standing in for disk-full / over-quota.
    const store = new LocalArtifactStore(join(tempRoot('dat08-store'), 'artifacts'), { quotaBytes: 16 * 1024 })
    const log = new InMemorySessionReferenceLog()
    const grants = new GrantTable()
    const scope = 'project:quota'
    grants.bump(scope)

    const capture = await captureFile({
      fs, path: 'too-big.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-quota', mediaType: 'text/plain',
    })

    // The failure is EXPLICIT and recorded, not swallowed.
    expect(capture.descriptor.acquisition.completeness).toBe('partial')
    expect(capture.gaps).toHaveLength(1)
    expect(capture.gaps[0]?.stage).toBe('retention')
    expect(capture.gaps[0]?.recovery).toBe('none')
    expect(capture.gaps[0]?.reason).toMatch(/quota/u)
    // No durable reference: nothing was published, so nothing is promised.
    expect(capture.reference.state).toBe('missing')
    expect(capture.reference.artifact).toBe('')

    // The projection is BOUNDED: the audit's requirement is that a failed save must
    // not silently degrade into unbounded inline delivery. The projection carries no
    // content at all, so there is nothing to inflate the context with.
    const projection = projectForModel({
      descriptor: capture.descriptor,
      pagesConsumed: 0,
      bytesConsumed: 0,
      exhausted: false,
      gaps: capture.gaps,
    })
    const projectionText = JSON.stringify(projection)
    expect(Buffer.byteLength(projectionText, 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(projectionText).not.toContain('DDDD')
    expect(projection.completeness).toBe('partial')

    // Nothing was published, so the store is empty and the log holds no reference.
    expect(await log.referencedArtifacts()).toEqual(new Set())
    console.log('[DAT-08] quotaBytes', 16 * 1024, 'sourceBytes', Buffer.byteLength(content),
      'completeness', capture.descriptor.acquisition.completeness,
      'gapStage', capture.gaps[0]?.stage, 'projectionBytes', Buffer.byteLength(projectionText, 'utf8'))
  })

  it('refuses to re-execute an effect after a save failure, and keeps the outcome unknown', () => {
    // The rule is unconditional: an effect that happened but whose save failed is
    // unknown, and re-running it to repair the log turns one unknown into two
    // effects. The function exists so a call site reads as a decision.
    expect(mayReExecuteAfterSaveFailure({ effectObserved: true })).toBe(false)
    expect(mayReExecuteAfterSaveFailure({ effectObserved: false })).toBe(false)
  })

  it('reports an orphan, not a delivery, when the Session reference cannot be committed', async () => {
    const root = tempRoot('dat08-orphan')
    writeFileSync(join(root, 'ok.txt'), 'content\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat08-orphan-store')
    // The save failure lands AFTER the object is published, which is the exact window
    // that produces an orphan.
    log.failNextCommit = 'simulated Session commit failure'

    const capture = await captureFile({
      fs, path: 'ok.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-orphan', mediaType: 'text/plain',
    })

    // The object IS on disk, but it is NOT a delivered observation.
    expect(capture.reference.state).toBe('orphaned')
    expect(await store.stat(capture.reference.artifact)).toBeDefined()
    expect(capture.gaps.some(gap => gap.stage === 'retention')).toBe(true)

    // Reading it back by observation id must fail as orphaned rather than returning
    // bytes nobody promised or an empty string.
    await expect(resolveReference(store, log, 'obs-orphan'))
      .rejects.toMatchObject({ code: 'artifact-orphaned' })

    // Reconciliation finds it as an orphan, and the grace window keeps it alive.
    const reconciled = await reconcileStore(store, log)
    expect(reconciled.orphans).toContain(capture.reference.artifact)
    const gc = await store.collectGarbage(await log.referencedArtifacts(), 60_000)
    expect(gc.collected).toHaveLength(0)
    expect(gc.skipped.some(entry => entry.reason.startsWith('within-grace'))).toBe(true)
    // Past the grace window it is collectable, which is what makes the orphan
    // reconcilable rather than permanent.
    const later = await store.collectGarbage(await log.referencedArtifacts(), 0, Date.now() + 120_000)
    expect(later.collected).toContain(capture.reference.artifact)
  })

  it('reports an integrity error, never an empty string, when a referenced object is missing', async () => {
    const root = tempRoot('dat08-missing')
    writeFileSync(join(root, 'gone.txt'), 'payload\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat08-missing-store')
    const capture = await captureFile({
      fs, path: 'gone.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-missing', mediaType: 'text/plain',
    })
    expect(capture.reference.state).toBe('durable')
    // The object disappears while the reference stays committed.
    await store.remove(capture.reference.artifact)

    await expect(resolveReference(store, log, 'obs-missing'))
      .rejects.toMatchObject({ code: 'artifact-integrity-error' })
    // The failure message names the observation and the event, so an operator can
    // find the reference that is now dangling.
    await expect(resolveReference(store, log, 'obs-missing')).rejects.toThrow(/obs-missing/u)

    // A deleted artifact reads as a TOMBSTONE, not as absent: the difference between
    // "never captured" and "captured then collected" must survive.
    expect(store.tombstoneOf(capture.reference.artifact)?.reason).toBe('explicit-delete')
  })

  it('does not promise durable:true when the checkpoint fails after the reference committed', async () => {
    const root = tempRoot('dat08-ckpt')
    writeFileSync(join(root, 'ck.txt'), 'x\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('dat08-ckpt-store')
    const capture = await captureFile({
      fs, path: 'ck.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-ckpt', mediaType: 'text/plain',
      checkpoint: async () => { throw new Error('checkpoint medium unavailable') },
    })
    // The reference is committed and the object exists, so the state is durable; the
    // gap records that the checkpoint did not complete, so a caller cannot read this
    // as a clean success.
    expect(capture.reference.state).toBe('durable')
    expect(capture.gaps.some(gap => gap.reason.includes('checkpoint failed'))).toBe(true)
    expect(capture.descriptor.acquisition.completeness).toBe('complete-within-request')
  })
})

// ---------------------------------------------------------------------------
// Host-authored facts -- a Python payload cannot promote its own claim
// ---------------------------------------------------------------------------

describe('observation authority: host facts are not trusted from a kernel payload', () => {
  it('refuses a kernel payload that asserts a host-authored field, naming the field', () => {
    expect(() => refuseForgedClaims({ captured: { sha256: 'f'.repeat(64) } }))
      .toThrow(ObservationError)
    try {
      refuseForgedClaims({ captured: { sha256: 'f'.repeat(64) }, authority: { ownerScope: 'x', grantRevision: 9 } })
      expect.unreachable('a forged payload must be refused')
    } catch (error) {
      expect((error as ObservationError).code).toBe('observation-authority-forged')
      expect((error as ObservationError).message).toContain('captured.sha256')
      expect((error as ObservationError).message).toContain('authority')
    }
    // A legitimate claim carries none of them.
    expect(() => refuseForgedClaims({ locator: 'notes.txt', transform: { name: 'html-to-text', version: '1' } }))
      .not.toThrow()
    // A non-object payload is not a forged claim; it is simply not a claim.
    expect(() => refuseForgedClaims('not-a-payload')).not.toThrow()
  })

  it('refuses a forged capture before writing anything, so a bad payload cannot cause an effect', async () => {
    const root = tempRoot('forge')
    writeFileSync(join(root, 'f.txt'), 'data\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('forge-store')
    await expect(captureFile({
      fs, path: 'f.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-forge',
      // A Python payload claiming the hash it wishes the object had.
      claim: { captured: { sha256: '0'.repeat(64) } },
    })).rejects.toMatchObject({ code: 'observation-authority-forged' })
    // Nothing was published and nothing was referenced.
    expect(await log.referencedArtifacts()).toEqual(new Set())
  })

  it('records a kernel-declared transform as a claim, with the parent artifact named', async () => {
    const root = tempRoot('transform')
    writeFileSync(join(root, 'page.html'), '<p>hi</p>')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('transform-store')
    const capture = await captureFile({
      fs, path: 'page.html', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-transform', mediaType: 'text/html',
      claim: { transform: { name: 'html-to-text', version: '1.0.0' } },
    })
    expect(capture.descriptor.transform).toEqual({
      parent: capture.descriptor.captured.artifact,
      name: 'html-to-text',
      version: '1.0.0',
    })
    // The original payload is a SEPARATE object; the transform record points at it
    // rather than replacing it.
    expect(capture.descriptor.transform?.parent).toBe(capture.descriptor.captured.artifact)
  })

  it('rejects a stale descriptor after the permission domain changes', async () => {
    const root = tempRoot('stale')
    writeFileSync(join(root, 's.txt'), 's\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('stale-store')
    const capture = await captureFile({
      fs, path: 's.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-stale', mediaType: 'text/plain',
    })
    expect(capture.descriptor.authority.grantRevision).toBe(1)
    grants.bump(scope)
    expect(grants.stillValid(capture.descriptor.authority)).toBe(false)
    await expect(pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope,
    })).rejects.toMatchObject({ code: 'pagination-scope-denied' })
  })

  it('refuses a descriptor from a different owner scope than the caller', async () => {
    const root = tempRoot('scope')
    writeFileSync(join(root, 'sc.txt'), 'sc\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('scope-store')
    grants.bump('project:other')
    const capture = await captureFile({
      fs, path: 'sc.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-scope', mediaType: 'text/plain',
    })
    await expect(pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: 'project:other',
    })).rejects.toMatchObject({ code: 'pagination-scope-denied' })
  })
})

// ---------------------------------------------------------------------------
// Production reachability: the service the profile actually mounts
// ---------------------------------------------------------------------------

describe('DataPlaneService: the production consumer the profile mounts', () => {
  /**
   * WHY THIS BLOCK EXISTS AT ALL
   *
   * Every test above mounts `artifacts.ts` directly. That proves the MODULE works
   * and says nothing about whether the PRODUCT uses it -- the defect class this
   * project has recorded three times (a launch port with no production caller, a
   * continuation handoff with no production caller, a bundle that declared no
   * `dsh.bundle`). `docs/GAPS.md` G-FIX-04 states the lesson: a gate whose oracle
   * is weaker than its scenario passes while the product is broken.
   *
   * So this block drives the SAME code through `DataPlaneService`, which is what
   * the `dsh-daily-work/data-host` plugin row constructs. The plugin row itself is
   * proven by `qualification/runners/verify-data-plane.mjs` booting a REAL composed
   * profile; this block is the fast, in-process half.
   */
  async function mountService(label: string): Promise<{
    service: DataPlaneService
    ctx: Context
    root: string
    dispose: () => Promise<void>
  }> {
    const root = tempRoot(label)
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    const service = new DataPlaneService(ctx, {
      artifactRoot: join(root, 'artifacts'),
      ownerScope: 'project:svc',
      executionWorld: 'local',
    })
    await service.open(ctx.storageDomain)
    return { service, ctx, root, dispose: async () => { await service.close() } }
  }

  it('captures through the real storage domain and reads back byte-for-byte', async () => {
    const { service, root, dispose } = await mountService('svc')
    try {
      writeFileSync(join(root, 'payload.txt'), 'service-payload\n')
      const fs = new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
      const outcome = await service.capture({
        fs, path: 'payload.txt', mediaType: 'text/plain', observationId: 'obs-svc',
      })
      // `durable` is returned only after the object was published, the reference row
      // was committed to the real storage backend, AND the checkpoint read it back.
      expect(outcome.reference.state).toBe('durable')
      expect(outcome.descriptor.authority.ownerScope).toBe('project:svc')
      expect(service.grantRevision).toBe(1)
      // The committed reference is a durable row, not an in-memory map.
      const record = await service.referenceOf('obs-svc')
      expect(record?.artifact).toBe(outcome.descriptor.captured.artifact)
      const resolved = await service.resolve('obs-svc')
      expect(Buffer.from(resolved.bytes).toString('utf8')).toBe('service-payload\n')
    } finally {
      await dispose()
    }
  })

  it('serves pages and the long-line repair through the service, refusing a forged descriptor', async () => {
    const { service, root, dispose } = await mountService('svc-page')
    try {
      const line = `${'A'.repeat(100)}-TAIL`
      writeFileSync(join(root, 'line.txt'), line)
      const fs = new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
      const outcome = await service.capture({
        fs, path: 'line.txt', mediaType: 'text/plain', observationId: 'obs-svc-page',
      })
      const descriptor = outcome.descriptor
      const index = await service.lineIndex(descriptor)
      expect(index.totalLines).toBe(1)
      const bytes = await service.readLine(descriptor, index.entries[0]!)
      expect(Buffer.from(bytes).toString('utf8')).toBe(line)
      // The service re-validates the descriptor against the LIVE grant BEFORE
      // touching the store, so a tampered revision is refused at the service
      // boundary with the precise code for a stale authority -- not with the
      // pager's scope error, which would mean the check ran later than it does.
      const tampered = { ...descriptor, authority: { ownerScope: 'project:svc', grantRevision: 99 } }
      await expect(service.page({ descriptor: tampered }))
        .rejects.toMatchObject({ code: 'observation-authority-stale' })
    } finally {
      await dispose()
    }
  })

  it('stops serving after the permission domain changes', async () => {
    const { service, root, dispose } = await mountService('svc-revoke')
    try {
      writeFileSync(join(root, 'r.txt'), 'revoke-me\n')
      const fs = new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
      const outcome = await service.capture({
        fs, path: 'r.txt', mediaType: 'text/plain', observationId: 'obs-revoke-svc',
      })
      expect(service.grantRevision).toBe(1)
      // A permission change bumps the revision; every descriptor minted before it
      // must stop working, which is what ARCHITECTURE §10/§12 requires. The failure
      // is `observation-authority-stale` because the grant moved, and the message
      // names BOTH revisions so an operator can see which edge was crossed.
      expect(service.revokeAndRebump()).toBe(2)
      await expect(service.page({ descriptor: outcome.descriptor }))
        .rejects.toMatchObject({ code: 'observation-authority-stale' })
      // The message names the scope AND the dead revision, so an operator can see
      // which grant edge was crossed rather than only that something was stale.
      await expect(service.page({ descriptor: outcome.descriptor }))
        .rejects.toThrow(/project:svc@1/u)
    } finally {
      await dispose()
    }
  })

  it('records the real artifact-root derivation: no domain root exists, so the home helper decides', async () => {
    // R5 measured that a real boot resolved `artifactRoot` to the RELATIVE
    // `data-artifacts`, and traced why: the mounted `storageDomain` is a
    // `DomainFacility`, which declares no `root` -- the root belongs to the
    // BACKEND. That measurement was right, and it stayed on disk as the OLD
    // reproduction.
    //
    // WHAT CHANGED, and why this test no longer pins the relative fallback as the
    // product's behaviour. The old `defaultArtifactRoot` read a `root` member the
    // type does not have, so its "derive from the domain" branch could never be
    // taken and the store's location was silently an accident of the launch
    // directory. The fix derives from the host's own `dshHomePath` helper instead
    // -- the same seam the shipped base bundle uses for `sessions` and `storages`.
    //
    // The assertions below therefore check three things in one run:
    //   1. the domain root really is absent, so the old branch is DEAD (not merely
    //      un-taken) -- this is the negative control for the fix;
    //   2. with the host helper present, the root is the helper's, which is
    //      cwd-independent;
    //   3. the resolved root is NOT the storage backend's root, which is what
    //      makes the old "artifacts live beside the records" comment false rather
    //      than merely unverified.
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(tempRoot('svc-root'), 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    const home = tempRoot('svc-home')
    // The host publishes this with `ctx.provide` at boot; standing it in by hand
    // is what makes the second assertion about THIS seam rather than about a
    // coincidence of the test process's environment.
    ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
    const service = new DataPlaneService(ctx, { ownerScope: 'project:root' })
    try {
      // (1) The dead branch, asserted as a fact about the mounted TYPE rather than
      // a comment: the facility exposes no root at all.
      const storageDomain = ctx.get('storageDomain') as { root?: string } | undefined
      expect(storageDomain).toBeDefined()
      expect(storageDomain?.root).toBeUndefined()

      // (2) With the host helper mounted, the store lands under it -- NOT under the
      // cwd, and not under the storage backend's root.
      expect(service.store.root).toBe(join(home, 'data-artifacts'))
      // (3) The recording stays empty, which is what distinguishes "a real root was
      // resolved" from "the cwd-dependent fallback ran".
      expect(service.artifactRootFallback).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to a RELATIVE root only when no host path helper exists, and RECORDS that it did', async () => {
    // The fallback is not deleted, because an in-process unit test that mounts
    // this service directly has no `app-boot` and therefore no `dshHomePath`.
    // What changed is that it is no longer SILENT: `artifactRootFallback` names
    // the relative path that was used, so a probe can ASSERT whether the
    // cwd-dependent branch ran rather than inferring it from a log line.
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(tempRoot('svc-fb-store'), 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    const service = new DataPlaneService(ctx, { ownerScope: 'project:fallback' })
    try {
      expect(service.store.root).toBe('data-artifacts')
      // The recording IS the fix. Without it the location is an accident.
      expect(service.artifactRootFallback).toBe('data-artifacts')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a RELATIVE configured artifactRoot, because that reproduces the cwd accident', async () => {
    // An explicit root is the deployment stating a location. A relative one would
    // resolve against the process cwd exactly as the old fallback did, so the
    // refusal names the reason rather than accepting a path that moves.
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(tempRoot('svc-rel-store'), 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    expect(() => new DataPlaneService(ctx, { ownerScope: 'project:rel', artifactRoot: 'relative/artifacts' }))
      .toThrow(/is not absolute/u)
    await ctx.fiber.dispose()
  })

  it('accepts an ABSOLUTE configured artifactRoot unchanged', async () => {
    // The control for the refusal above: a legitimate explicit root is used
    // verbatim, so the check rejects only the shape it names.
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin, { root: join(tempRoot('svc-abs-store'), 'store') })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    const absolute = join(tempRoot('svc-abs-artifacts'), 'artifacts')
    const service = new DataPlaneService(ctx, { ownerScope: 'project:abs', artifactRoot: absolute })
    try {
      expect(service.store.root).toBe(absolute)
      expect(service.artifactRootFallback).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Crash consistency (ARCHITECTURE §9): a REAL SIGKILL inside the orphan window
// ---------------------------------------------------------------------------

describe('crash consistency: a real SIGKILL between publication and the Session reference', () => {
  /**
   * A child script that publishes an object, then stops dead.
   *
   * The kill is REAL (`SIGKILL`, no handler, no cleanup) and lands in the window
   * the commit order exists for: after `put` returned, before `log.commit`. A
   * barrier would prove nothing here because the whole question is what SURVIVES a
   * process that never ran its next line.
   *
   * The script is a `.mjs` file with ABSOLUTE `file://` imports, because a forked
   * child does not inherit the parent's loader hook and a temp cwd cannot resolve
   * package names. The same shape is used by `durability-records.test.ts` for its
   * own kill windows, so the two files agree about what a real kill means here.
   */
  function childScript(modules: { artifacts: string; observations: string; fsLocal: string; cordis: string }): string {
    return `
import { LocalArtifactStore, InMemorySessionReferenceLog, captureFile } from '${modules.artifacts}'
import { GrantTable } from '${modules.observations}'
import LocalFileSystem from '${modules.fsLocal}'
import { Context } from '${modules.cordis}'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [,, root, sourceDir] = process.argv
const store = new LocalArtifactStore(join(root, 'artifacts'))
const log = new InMemorySessionReferenceLog()
const grants = new GrantTable()
const scope = 'project:crash'
grants.bump(scope)
const ctx = new Context()
const fs = new LocalFileSystem(ctx, { cwd: sourceDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
// The object is published by the time \`commit\` is called. Announce that, then stop
// existing: no return, no cleanup, no session record.
log.commit = async () => {
  writeFileSync(join(root, 'published.txt'), 'yes')
  process.kill(process.pid, 'SIGKILL')
  return 'unreachable'
}
const outcome = await captureFile({
  fs, path: 'payload.txt', store, log, grants, ownerScope: scope,
  executionWorld: 'local', observationId: 'obs-crash', mediaType: 'text/plain',
})
// Reaching here would mean the kill did not happen.
writeFileSync(join(root, 'survived.txt'), outcome.reference.state)
`
  }

  it('leaves a reconcilable ORPHAN and never reports it as delivered', async () => {
    const root = tempRoot('crash')
    const sourceDir = tempRoot('crash-src')
    writeFileSync(join(sourceDir, 'payload.txt'), 'survive-me\n')

    const loader = fileURLToPath(import.meta.resolve('tsx/esm'))
    const scriptPath = join(root, 'child.mjs')
    writeFileSync(scriptPath, childScript({
      artifacts: pathToFileURL(join(HERE, 'artifacts.ts')).href,
      observations: pathToFileURL(join(HERE, 'observations.ts')).href,
      fsLocal: pathToFileURL(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-fs-local'))).href,
      cordis: pathToFileURL(fileURLToPath(import.meta.resolve('@deepseek-ai/cordis'))).href,
    }))

    const child = spawn(process.execPath, [
      '--import', pathToFileURL(loader).href,
      scriptPath, root, sourceDir,
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const exited = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once('exit', (code, signal) => { resolve({ code, signal }) })
    })

    // The child must NOT have survived: a surviving child would mean the window was
    // never entered, and the test would be asserting about the wrong thing.
    expect(existsSync(join(root, 'survived.txt'))).toBe(false)
    if (stderr.trim() !== '') throw new Error(`child stderr: ${stderr}`)
    // The kill really happened: no clean exit. On Windows a `SIGKILL` is delivered as
    // TerminateProcess, so the platform reports a non-zero exit code and NOT the
    // signal name -- asserting `signal === 'SIGKILL'` here would fail for a reason
    // that has nothing to do with the commit order. The two facts that DO establish a
    // real abrupt termination are asserted instead: the process did not exit cleanly,
    // and it never reached the line after `captureFile`.
    expect(exited.code).not.toBe(0)
    expect(existsSync(join(root, 'survived.txt'))).toBe(false)
    // The child got far enough to publish the object, which is what makes the
    // surviving state an ORPHAN rather than a never-captured artifact.
    expect(existsSync(join(root, 'published.txt'))).toBe(true)

    // Reconcile the SURVIVING state from a fresh process's view: an object with no
    // committed reference is an orphan.
    const store = new LocalArtifactStore(join(root, 'artifacts'))
    const log = new InMemorySessionReferenceLog()
    const reconciled = await reconcileStore(store, log)
    expect(reconciled.orphans).toHaveLength(1)
    const orphan = reconciled.orphans[0]!
    // The object is genuinely present and verifiable -- it is not a torn write.
    expect(await store.stat(orphan)).toBeDefined()
    expect(await store.verify(orphan)).toBe(true)
    // And reading it BY OBSERVATION ID fails as orphaned rather than returning bytes
    // nobody promised, or an empty string.
    await expect(resolveReference(store, log, 'obs-crash'))
      .rejects.toMatchObject({ code: 'artifact-orphaned' })
    // The grace window keeps it; past the window it is collectable, which is what
    // makes the orphan reconcilable instead of permanent.
    expect((await store.collectGarbage(new Set(), 60_000)).collected).toHaveLength(0)
    expect((await store.collectGarbage(new Set(), 0, Date.now() + 120_000)).collected).toContain(orphan)

    console.log('[crash] signal', exited.signal, 'exitCode', exited.code,
      'orphans', reconciled.orphans.length, 'integrityErrors', reconciled.integrityErrors.length,
      'objectVerified', true)
  })
})

// ---------------------------------------------------------------------------
// DATA-02 -- the capture is BYTE-EXACT, for every encoding a real FS returns
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK EXISTS. The capture path used `streamText` re-encoded to UTF-8,
// which is lossless only for content that SURVIVES the text decode. The gate it
// violates is not "text handling" but the first of the four byte-counts: if the
// acquired bytes are not the file's bytes, then `acquired != persisted` is a
// DIFFERENCE THE RECORD DOES NOT KNOW ABOUT, and every downstream count is a
// count of something else. Measured before the fix: a UTF-8 BOM was stripped and
// the captured sha256 no longer matched the file, while `completeness` still said
// `complete-within-request`; UTF-16, latin-1 and a binary NUL were refused as
// `artifact-write-failed`, a storage error for an input problem.
//
// These are REAL files on REAL disk read through the REAL `LocalFileSystem`, and
// the assertion is `captured.sha256 === sha256(file)` -- not "the read did not
// throw".

describe('DATA-02 [real] the capture holds the file\u2019s EXACT bytes, not a re-encoded decode', () => {
  /** The encodings that broke the re-encoding path, each a real byte sequence. */
  const cases: ReadonlyArray<{ name: string; bytes: Buffer; why: string }> = [
    {
      name: 'utf8-bom.txt',
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom content\n')]),
      why: 'a UTF-8 BOM is stripped by a text decode, so the object is 3 bytes shorter than the file',
    },
    {
      name: 'utf16le.txt',
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('utf16 text\n', 'utf16le')]),
      why: 'UTF-16 is refused by the text path\u2019s binary rejection',
    },
    {
      name: 'latin1.txt',
      bytes: Buffer.from([0xe9, 0x0a]),
      why: 'a lone 0xe9 is invalid UTF-8 and is refused by the text path',
    },
    {
      name: 'nul.bin',
      bytes: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f]),
      why: 'a NUL byte is refused by the text path\u2019s binary rejection',
    },
    {
      name: 'crlf.txt',
      bytes: Buffer.from('one\r\ntwo\r\n'),
      why: 'CRLF must survive byte-for-byte, not be normalised',
    },
  ]

  for (const testCase of cases) {
    it(`captures ${testCase.name} byte-for-byte and reports the file\u2019s own sha256`, async () => {
      const root = tempRoot(`data02-${testCase.name}`)
      writeFileSync(join(root, testCase.name), testCase.bytes)
      const fileSha = createHash('sha256').update(testCase.bytes).digest('hex')
      const { fs } = mountFs(root)
      const { store, log, grants, scope } = makePlane(`data02-${testCase.name}-store`)

      const capture = await captureFile({
        fs, path: testCase.name, store, log, grants, ownerScope: scope,
        executionWorld: 'local', observationId: `obs-${testCase.name}`, mediaType: 'application/octet-stream',
      })

      // The count the record makes is the FILE's size. If these differ, the
      // "acquired bytes" number describes a decode, not an acquisition.
      expect(capture.descriptor.captured.bytes).toBe(testCase.bytes.byteLength)
      // The strongest form: the host-computed hash equals the hash of the file on
      // disk, so the captured object IS the file.
      expect(capture.descriptor.captured.sha256).toBe(fileSha)
      // And reading it back gives the exact bytes, so the hash is not the only
      // witness. `testCase.why` names what the old path did instead.
      const readBack = await readArtifactRange(store, capture.descriptor, { offset: 0, length: capture.descriptor.captured.bytes })
      expect(Buffer.from(readBack).equals(testCase.bytes), testCase.why).toBe(true)
      // A faithful capture of the whole file is `complete-within-request`, which is
      // now a claim the bytes actually support.
      expect(capture.descriptor.acquisition.completeness).toBe('complete-within-request')
    })
  }

  it('never lets the captured sha256 disagree with the file it names', async () => {
    // The single property the whole gate reduces to, asserted once over every case
    // at once: `captured.sha256` is a host-computed fact about the FILE. A record
    // whose hash describes something else makes every later integrity check a
    // check of the wrong object.
    const root = tempRoot('data02-sweep')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data02-sweep-store')
    const mismatches: string[] = []
    for (const testCase of cases) {
      writeFileSync(join(root, testCase.name), testCase.bytes)
      const capture = await captureFile({
        fs, path: testCase.name, store, log, grants, ownerScope: scope,
        executionWorld: 'local', observationId: `obs-sweep-${testCase.name}`, mediaType: 'application/octet-stream',
      })
      const onDisk = createHash('sha256').update(readFileSync(join(root, testCase.name))).digest('hex')
      if (capture.descriptor.captured.sha256 !== onDisk) mismatches.push(testCase.name)
    }
    expect(mismatches, 'a capture whose hash is not the file\u2019s hash cannot support any byte count').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DATA-06 -- a refetch is a NEW observation; the old one is never backfilled
// ---------------------------------------------------------------------------
//
// WHY THIS IS A SEPARATE BLOCK FROM DAT-06. DAT-06 is about the COST of paging.
// This is about the RECORD: the rule is that a provider returning only part of
// the content leaves the old observation partial, and a refetch produces a NEW
// observation -- never a backfill of the old record reported as full.
//
// Measured before the fix: re-using an observation id for a second capture
// OVERWROTE the committed reference. A 7-byte partial first capture was replaced
// by a 13-byte refetch under the same id, and `log.lookup('obs-1')` returned the
// new hash -- so the earlier observation, which had been `partial`, now read as
// `complete-within-request` over bytes it never held. That is exactly the
// failure the rule names, and it was reachable through the public API.

describe('DATA-06 [real] a refetch is a NEW observation, and never backfills the old one', () => {
  it('refuses a second capture under an id that already has a committed reference', async () => {
    const root = tempRoot('data06-refetch')
    writeFileSync(join(root, 'doc.txt'), 'PARTIAL-ONLY\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data06-refetch-store')
    const base = { fs, store, log, grants, ownerScope: scope, executionWorld: 'local', mediaType: 'text/plain' } as const

    // A first acquisition that only got part of the content, recorded as partial.
    const first = await captureFile({
      ...base, path: 'doc.txt', observationId: 'obs-partial',
      readChunks: async function* () { yield new TextEncoder().encode('PARTIAL') },
    })
    expect(first.descriptor.acquisition.completeness).toBe('partial')
    expect(first.descriptor.captured.bytes).toBe(7)
    const committedBefore = await log.lookup('obs-partial')
    expect(committedBefore?.sha256).toBe(first.descriptor.captured.sha256)

    // The refetch must NOT be able to write over that observation.
    await expect(captureFile({ ...base, path: 'doc.txt', observationId: 'obs-partial' }))
      .rejects.toMatchObject({ code: 'observation-already-committed' })

    // The old observation's reference is UNCHANGED, which is the property: it
    // still names the 7 bytes it actually acquired, and still reads as partial.
    const committedAfter = await log.lookup('obs-partial')
    expect(committedAfter?.sha256).toBe(committedBefore?.sha256)
    expect(committedAfter?.artifact).toBe(committedBefore?.artifact)
  })

  it('lets the refetch happen under a NEW id, so both observations coexist', async () => {
    // The rule is "a refetch is a NEW observation", not "a refetch is forbidden".
    // The new observation must be creatable and must be its own record.
    const root = tempRoot('data06-newid')
    writeFileSync(join(root, 'doc.txt'), 'COMPLETE-CONTENT\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data06-newid-store')
    const base = { fs, store, log, grants, ownerScope: scope, executionWorld: 'local', mediaType: 'text/plain' } as const

    const first = await captureFile({
      ...base, path: 'doc.txt', observationId: 'obs-old',
      readChunks: async function* () { yield new TextEncoder().encode('PARTIAL') },
    })
    const second = await captureFile({ ...base, path: 'doc.txt', observationId: 'obs-new' })

    // Two distinct records, two distinct hashes and byte counts. The new one is
    // complete; the OLD one is still the partial it always was.
    expect(first.descriptor.captured.sha256).not.toBe(second.descriptor.captured.sha256)
    expect(first.descriptor.captured.bytes).toBe(7)
    expect(second.descriptor.captured.bytes).toBe(17)
    expect(first.descriptor.acquisition.completeness).toBe('partial')
    expect(second.descriptor.acquisition.completeness).toBe('complete-within-request')
    const oldRef = await log.lookup('obs-old')
    const newRef = await log.lookup('obs-new')
    expect(oldRef?.sha256).toBe(first.descriptor.captured.sha256)
    expect(newRef?.sha256).toBe(second.descriptor.captured.sha256)
    expect(oldRef?.sha256).not.toBe(newRef?.sha256)
  })
})

// ---------------------------------------------------------------------------
// DATA-04 / DATA-12 -- the four byte-counts stay separately measurable
// ---------------------------------------------------------------------------
//
// THE CENTRAL CLAIM OF THE PLANE. If `acquired`, `persisted`, `Python-consumed`
// and `LLM-visible` collapse into one number, "programmatic native tool
// consumption" is unverifiable: a small projection would be indistinguishable
// from a small source, and a short capture from a small file.
//
// The block asserts each count SEPARATELY and then asserts they DIFFER in the
// direction that matters -- a large artifact consumed in full while the model
// sees a bounded projection. The four are read from four different sources: the
// capture's `sourceBytesRead` counter, the store's `bytes`, the page-walk's
// `bytesConsumed`, and the serialized projection.

describe('DATA-04/12 [real] the four byte-counts are separately measurable and distinct', () => {
  it('separates acquired, persisted, consumed and model-visible bytes in one walk', async () => {
    const root = tempRoot('data04-four')
    const pageBytes = 64 * 1024
    const totalBytes = 64 * pageBytes
    writeFileSync(join(root, 'four.bin'), Buffer.alloc(totalBytes, 0x62))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data04-four-store')
    const io: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }

    // (1) ACQUIRED: what the source read cost, from the capture's own counter.
    const capture = await captureFile({
      fs, path: 'four.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-four', mediaType: 'application/octet-stream',
    })
    const acquiredBytes = capture.io.sourceBytesRead
    // (2) PERSISTED: what the store actually holds, from its own stat.
    const persisted = await store.stat(capture.descriptor.captured.artifact)
    const persistedBytes = persisted?.bytes ?? -1
    // (3) CONSUMED: what the walk read out, counted per page by the consumer.
    let consumedBytes = 0
    let pagesConsumed = 0
    const walk = await walkPages(new ArtifactStorePageProvider(store), {
      descriptor: capture.descriptor, maxBytes: pageBytes, grants, callerScope: scope,
    }, {
      counters: io,
      onPage: page => { consumedBytes += page.bytes.byteLength; pagesConsumed += 1 },
    })
    // (4) MODEL-VISIBLE: the serialized projection, which is the only thing the
    // model sees about the walk.
    const projection = projectForModel({
      descriptor: capture.descriptor,
      pagesConsumed,
      bytesConsumed: consumedBytes,
      exhausted: walk.exhausted,
      consumerNote: 'streamed to a consumer; nothing retained in context',
    })
    const modelVisibleBytes = Buffer.byteLength(JSON.stringify(projection), 'utf8')

    // Each count is the value its own source reports, and all four agree about the
    // ARTIFACT's size -- which is what makes them comparable rather than four
    // unrelated numbers.
    expect(acquiredBytes).toBe(totalBytes)
    expect(persistedBytes).toBe(totalBytes)
    expect(consumedBytes).toBe(totalBytes)
    expect(walk.exhausted).toBe(true)
    // The ARTIFACT-level counter is the paging cost, and it is the same total
    // because the walk was exhaustive; the SOURCE was not re-read to get it.
    expect(io.sourceBytesRead).toBe(0)
    expect(io.artifactBytesRead).toBe(totalBytes)

    // The collapse the gate forbids: model-visible bytes must be bounded and
    // ORDERS OF MAGNITUDE below the bytes that were processed.
    expect(modelVisibleBytes).toBeLessThanOrEqual(8 * 1024)
    expect(modelVisibleBytes).toBeLessThan(consumedBytes / 1000)
    // The projection reports the large counts as NUMBERS, so a model can see that
    // it consumed 4 MiB without carrying 4 MiB.
    expect(projection.bytesConsumed).toBe(totalBytes)
    expect(projection.artifactBytes).toBe(totalBytes)
    expect(projection.pagesConsumed).toBe(64)

    console.log('[DATA-04] acquiredBytes', acquiredBytes, 'persistedBytes', persistedBytes,
      'consumedBytes', consumedBytes, 'modelVisibleBytes', modelVisibleBytes,
      'ratio', Math.round(consumedBytes / modelVisibleBytes))
  })

  it('reports a SHORT acquisition as a smaller acquired count, not a smaller file', async () => {
    // The failure mode the four counts exist to expose: a capture that acquired
    // less than the file holds. Before the fix this reported
    // `complete-within-request` with no gap, so the shortfall was invisible.
    const root = tempRoot('data04-short')
    const fileBytes = 1000
    writeFileSync(join(root, 'short.bin'), Buffer.alloc(fileBytes, 0x63))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data04-short-store')

    const capture = await captureFile({
      fs, path: 'short.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-short', mediaType: 'application/octet-stream',
      readChunks: async function* () { yield Buffer.alloc(400, 0x63) },
    })

    // The PERSISTED count is what arrived; the file is larger. The record must say
    // so rather than presenting the persisted number as the file's.
    expect(capture.descriptor.captured.bytes).toBe(400)
    expect(capture.io.sourceBytesRead).toBe(400)
    // The gap names the SHORTFALL and attributes it to acquisition, with a
    // recovery that is NOT `page` -- the missing bytes are not in this object.
    const gap = capture.gaps.find(entry => entry.stage === 'native-acquisition')
    expect(gap, 'a short capture must record where the bytes went').toBeDefined()
    expect(gap?.recovery).toBe('refetch')
    expect(gap?.reason).toContain('600')
    // And the verdict is partial, so a consumer cannot read it as the whole file.
    expect(capture.descriptor.acquisition.completeness).toBe('partial')
    expect(coverageVerdictOf(capture.descriptor)).toBe('partial-native-acquisition')
  })
})

// ---------------------------------------------------------------------------
// DATA-08 -- corruption and truncation are detected, not served
// ---------------------------------------------------------------------------
//
// WHY THIS IS ITS OWN BLOCK. The existing DAT-08 test covers a MISSING object.
// Two other windows were reachable and silently wrong: an object replaced in
// place (same length, different bytes) and an object truncated to fewer bytes
// than the reference declares. Both were served through `resolveReference` as
// if they were the observation, because the integrity check compared the
// reference's hash against `store.stat`'s hash -- and `stat` DERIVES that value
// from the artifact REF (the path), not from the bytes. The comparison was
// therefore a value against itself: it could never fail.

describe('DATA-08 [real] a corrupt or truncated artifact fails loud, never as content', () => {
  /** The object path for a digest, so a test can damage the real file. */
  function objectPath(store: LocalArtifactStore, sha256: string): string {
    return join(store.root, 'objects', sha256.slice(0, 2), sha256)
  }

  it('detects an object REPLACED in place at the same length', async () => {
    const root = tempRoot('data08-replaced')
    writeFileSync(join(root, 'orig.bin'), 'ORIGINAL-PAYLOAD\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data08-replaced-store')
    const capture = await captureFile({
      fs, path: 'orig.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-replaced', mediaType: 'application/octet-stream',
    })
    const digest = capture.descriptor.captured.sha256
    const path = objectPath(store, digest)
    const original = readFileSync(path)

    // The publication is 0o400, which is a REAL protection worth asserting: the
    // test has to clear it to simulate the damage at all.
    chmodSync(path, 0o600)
    writeFileSync(path, Buffer.alloc(original.length, 0x5a))
    expect(readFileSync(path).equals(original)).toBe(false)
    expect(statSync(path).size).toBe(original.length)

    await expect(resolveReference(store, log, 'obs-replaced'))
      .rejects.toMatchObject({ code: 'artifact-integrity-error' })
    // The error names both hashes, so an operator can tell WHICH object is wrong.
    await expect(resolveReference(store, log, 'obs-replaced')).rejects.toThrow(/hashes to/u)
  })

  it('detects an object TRUNCATED below the bytes the reference declares', async () => {
    const root = tempRoot('data08-truncated')
    writeFileSync(join(root, 'orig.bin'), 'ORIGINAL-PAYLOAD\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data08-truncated-store')
    const capture = await captureFile({
      fs, path: 'orig.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-truncated', mediaType: 'application/octet-stream',
    })
    const digest = capture.descriptor.captured.sha256
    const path = objectPath(store, digest)
    const original = readFileSync(path)
    chmodSync(path, 0o600)
    writeFileSync(path, original.subarray(0, 5))

    // A truncated object must NOT come back as a 5-byte observation: a caller
    // cannot tell a short artifact from a legitimately short one.
    await expect(resolveReference(store, log, 'obs-truncated'))
      .rejects.toMatchObject({ code: 'artifact-integrity-error' })
  })

  it('still serves an INTACT object, so the check is not vacuous', async () => {
    // The control. A check that refused everything would pass the two tests above
    // and be useless, so the same call is asserted to succeed on undamaged bytes.
    const root = tempRoot('data08-intact')
    writeFileSync(join(root, 'orig.bin'), 'ORIGINAL-PAYLOAD\n')
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data08-intact-store')
    const capture = await captureFile({
      fs, path: 'orig.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-intact', mediaType: 'application/octet-stream',
    })
    const resolved = await resolveReference(store, log, 'obs-intact')
    expect(Buffer.from(resolved.bytes).toString('utf8')).toBe('ORIGINAL-PAYLOAD\n')
    expect(resolved.sha256).toBe(capture.descriptor.captured.sha256)
  })
})

// ---------------------------------------------------------------------------
// The coverage vocabulary
// ---------------------------------------------------------------------------
//
// The coverage vocabulary is the READER-facing name for a descriptor's state.
// The stored field is three-valued on purpose; this is the six-name reporting
// vocabulary the gate requires, and it is derived in ONE place so two consumers
// cannot disagree about what `(completeness, gaps)` means.

describe('coverage vocabulary: six names, derived in one place', () => {
  /** A descriptor with the given completeness and gaps, for the mapping table. */
  function descriptorWith(
    completeness: 'complete-within-request' | 'partial' | 'unknown',
    gaps: Array<{ stage: 'provider-acquisition' | 'native-acquisition' | 'transform' | 'retention'; reason: string; recovery: 'page' | 'refetch' | 'none' | 'unknown' }>,
  ): ObservationDescriptor {
    return {
      id: 'obs-vocab',
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      source: { kind: 'file', locator: 'x', acquiredAt: '2026-01-01T00:00:00.000Z', executionWorld: 'local' },
      captured: { artifact: `artifact:sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' },
      acquisition: { completeness, coverage: null, gaps },
      authority: { ownerScope: 'project:vocab', grantRevision: 1 },
    }
  }

  it('names exactly the six verdicts, and no others', () => {
    expect([...OBSERVATION_COVERAGE_VOCABULARY]).toEqual([
      'full-for-requested-scope',
      'partial-provider',
      'partial-native-acquisition',
      'partial-transform',
      'partial-storage',
      'unknown',
    ])
  })

  it('maps a complete capture to full-for-requested-scope, never to "full"', () => {
    const verdict = coverageVerdictOf(descriptorWith('complete-within-request', []))
    expect(verdict).toBe('full-for-requested-scope')
    // The name is the contract: it is a claim about the REQUEST's range. A name
    // like `full` would assert something no client can establish from the bytes.
    expect(verdict).not.toBe('full')
  })

  it('maps each partial layer to its own name', () => {
    const cases: ReadonlyArray<{ stage: 'provider-acquisition' | 'native-acquisition' | 'transform' | 'retention'; expected: string }> = [
      { stage: 'provider-acquisition', expected: 'partial-provider' },
      { stage: 'native-acquisition', expected: 'partial-native-acquisition' },
      { stage: 'transform', expected: 'partial-transform' },
      { stage: 'retention', expected: 'partial-storage' },
    ]
    for (const testCase of cases) {
      const verdict = coverageVerdictOf(descriptorWith('partial', [
        { stage: testCase.stage, reason: 'lost', recovery: 'refetch' },
      ]))
      expect(verdict, `stage ${testCase.stage}`).toBe(testCase.expected)
    }
  })

  it('reports the EARLIEST loss when several layers are named', () => {
    // Bytes the provider never sent cannot be recovered by anything downstream,
    // so a provider gap outranks a storage gap even when both are present.
    // Reporting the latest would name a symptom and hide the cause.
    const verdict = coverageVerdictOf(descriptorWith('partial', [
      { stage: 'retention', reason: 'quota', recovery: 'none' },
      { stage: 'provider-acquisition', reason: 'capped', recovery: 'refetch' },
    ]))
    expect(verdict).toBe('partial-provider')
  })

  it('reports a `partial` claim with no attributable gap as unknown, not as a layer', () => {
    // The record says a loss happened and cannot say where, which is not enough
    // to name a layer. Naming one here would be a guess.
    expect(coverageVerdictOf(descriptorWith('partial', []))).toBe('unknown')
    expect(coverageVerdictOf(descriptorWith('unknown', []))).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// DATA-09 / F7 — acquisition loss and intentional projection are two concepts
// ---------------------------------------------------------------------------
//
// THE DEFECT, in the audit's own phrasing: "provider 少给了数据" and
// "我已经完整拿到 30 MB，但只给 LLM 看 2 KB" cannot be one enum. v1 put both in
// `acquisition.gaps[]`, so a deliberate projection was recorded as a loss.
//
// The two tests below are the two halves of the fix, and they are written to
// FAIL against v1's shape rather than merely pass against the new one:
//   1. the closed set is exactly the stages a production path can emit, and it
//      is FOUR -- not six, and not four-plus-two-fabricated-producers;
//   2. a projection is recorded as a ProjectionManifest and is NOT a gap, with
//      the type boundary asserted rather than described.

describe('DATA-09 [real] the acquisition taxonomy has exactly the stages that have a producer', () => {
  /**
   * Every `.ts` file in production source, tests excluded.
   *
   * A test file is not a producer: a `stage: 'transport'` in a fixture proves the
   * vocabulary accepts the name, not that the product can emit it. That
   * distinction is the whole measurement v1's FAIL turned on.
   */
  function productionSources(): Array<{ file: string; text: string }> {
    const src = join(HERE)
    return readdirSync(src)
      .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map(name => ({ file: name, text: readFileSync(join(src, name), 'utf8') }))
  }

  /**
   * Remove comments, keeping line numbers so a hit still points at real source.
   *
   * WHY THIS IS NOT OPTIONAL. A comment that NAMES a stage -- this module's own
   * doc comments say "v1 filed `{stage: 'model-projection'}` as a loss" -- would
   * otherwise be counted as a producer, and the detector would report a producer
   * for a stage no code path can emit. That is the exact false positive this test
   * exists to catch, so the measurement must not be able to produce it. Measured
   * before this was added: the naive version reported THREE producers for
   * `model-projection`, all of them prose in block comments.
   *
   * Block comments are tracked across lines rather than matched per line, because
   * a per-line regex cannot see that it is inside one. String literals are left
   * alone: a `stage: 'x'` inside a string is still an assignment to look at, and
   * stripping strings would hide real code.
   */
  function stripComments(text: string): string {
    const lines = text.split('\n')
    let inBlock = false
    return lines.map(line => {
      let out = ''
      let index = 0
      while (index < line.length) {
        if (inBlock) {
          const close = line.indexOf('*/', index)
          if (close === -1) return out
          inBlock = false
          index = close + 2
          continue
        }
        const open = line.indexOf('/*', index)
        const lineComment = line.indexOf('//', index)
        if (lineComment !== -1 && (open === -1 || lineComment < open)) {
          return out + line.slice(index, lineComment)
        }
        if (open === -1) return out + line.slice(index)
        out += line.slice(index, open)
        inBlock = true
        index = open + 2
      }
      return out
    }).join('\n')
  }

  /** Every `stage: '<name>'` ASSIGNMENT in a file, with line numbers, comments excluded. */
  function stageAssignments(text: string, stage: string): number[] {
    return stripComments(text).split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => new RegExp(`stage:\\s*'${stage}'`, 'u').test(line))
      .map(({ number }) => number)
  }

  it('the closed set is FOUR stages, and `transport`/`model-projection` are not among them', () => {
    // Not "six minus two". The set is exactly the acquisition stages: a name in
    // here is a promise that some production path can emit it, and V3 §M1
    // forbids promising vocabulary no path can produce.
    expect([...OBSERVATION_GAP_STAGES]).toEqual([
      'provider-acquisition',
      'native-acquisition',
      'transform',
      'retention',
    ])
    // The two v1 names, asserted ABSENT by name so a re-addition is a visible
    // failure rather than a quiet widening of the set.
    expect([...OBSERVATION_GAP_STAGES]).not.toContain('transport')
    expect([...OBSERVATION_GAP_STAGES]).not.toContain('model-projection')
  })

  it('ALL FOUR acquisition stages have a real production producer, and none is fabricated', () => {
    // The positive half. A stage in the closed set with no producer would be a
    // vocabulary member no path can emit -- the v1 FAIL, relocated rather than
    // fixed. This asserts 4 of 4, which is the honest count: the two removed
    // names are gone because no producer exists, NOT because two new producers
    // were invented to reach six.
    const sources = productionSources()
    const producers = new Map<string, string[]>()
    for (const stage of OBSERVATION_GAP_STAGES) producers.set(stage, [])
    for (const { file, text } of sources) {
      // An ASSIGNMENT to the stage field. A closed-set entry, a type union
      // member, a switch case and a zod enum are all DECLARATIONS, and a
      // declaration is not a producer. Comments are excluded by the helper; see
      // its note for why that exclusion is load-bearing.
      for (const stage of OBSERVATION_GAP_STAGES) {
        for (const line of stageAssignments(text, stage)) {
          producers.get(stage)!.push(`${file}:${String(line)}`)
        }
      }
    }
    const unproduced = [...OBSERVATION_GAP_STAGES].filter(stage => producers.get(stage)!.length === 0)
    expect(unproduced, 'a stage in the closed set with no producer is vocabulary the product cannot emit').toEqual([])
    // Stated as an explicit count so a future "fix" that re-adds two names and
    // two fake producers cannot pass by satisfying the emptiness check alone.
    expect(producers.size).toBe(4)

    // AND THE NEGATIVE HALF: the two removed names are not quietly produced as
    // GAPS anywhere. If `model-projection` were still assigned as a gap stage,
    // the conflation would survive in the code while the closed set denied it --
    // the type would reject it at the schema, but a producer would remain and the
    // removal would be cosmetic. This asserts the producers are gone too, so the
    // split is a change to what the product EMITS and not only to what it allows.
    for (const stage of ['transport', 'model-projection']) {
      const assignments = sources.flatMap(({ file, text }) =>
        stageAssignments(text, stage).map(line => `${file}:${String(line)}`))
      expect(assignments, `\`${stage}\` must have NO gap producer: ${assignments.join(', ')}`).toEqual([])
    }
  })

  it('the coverage vocabulary is the SAME four names, so the two cannot drift', () => {
    // A coverage name with no gap stage would be a second vocabulary, and drift
    // between them means a consumer maps a loss to a layer the gap list can
    // never contain.
    expect([...ACQUISITION_COVERAGE_STAGES]).toEqual([...OBSERVATION_GAP_STAGES])
  })

  it('`transport` is an ERROR, not a gap: an over-limit frame is refused, never silently dropped', () => {
    // The measured behaviour D2 records: the encoder refuses and the decoder
    // refuses on the DECLARED length, so no successful value ever exists and
    // there is no partial success to attribute. The honest contract is a refusal
    // that names the limit -- NOT a fabricated `transport` gap produced by
    // degrading a hard failure into a silent drop.
    //
    // This test pins the refusal's SHAPE in the ipython bridge, which is where
    // the frame limit lives. It is a read of another slice's file rather than an
    // assertion about this module, and it is here because the taxonomy decision
    // rests on it: if a partial-success transport ever appears, this test fails
    // and the `transport` stage becomes legitimate.
    const bridge = readFileSync(join(HERE, '..', '..', 'dsh-ipython', 'src', 'bridge.ts'), 'utf8')
    expect(bridge, 'the frame limit must be a refusal with a stable code').toContain('FRAME_TOO_LARGE')
    expect(bridge, 'the refusal must not be a counter increment on a drop path').not.toMatch(/droppedFrames\s*\+=/u)
  })
})

describe('DATA-09 [real] a projection is a ProjectionManifest, and NOT an acquisition gap', () => {
  it('records a deliberate projection as a manifest with the omitted bytes derived', () => {
    // The audit's example, in numbers: 30 MiB acquired in full, 2 KiB shown to
    // the model. Under v1 this was a `model-projection` gap -- a LOSS. It is not
    // a loss: nothing was lost, and the artifact is complete.
    const manifest = recordProjection({
      sourceRef: `artifact:sha256:${'a'.repeat(64)}`,
      selectedBytes: 2048,
      sourceBytes: 30 * 1024 * 1024,
      projectionReason: 'the model request budget allows a bounded preview of the artifact',
    })
    expect(manifest.selectedBytes).toBe(2048)
    // DERIVED, not accepted: the caller never passes `omittedBytes`, so it
    // cannot report a false 0 for a projection it knows is partial.
    expect(manifest.omittedBytes).toBe(30 * 1024 * 1024 - 2048)
    expect(manifest.recoverableRef).toBe(manifest.sourceRef)
    expect(projectionWithheld(manifest)).toBe('partial')
  })

  it('leaves the omitted count UNKNOWN rather than fabricating a zero', () => {
    // "we never established the total" and "nothing was omitted" are different
    // facts. A fabricated 0 would assert a COMPLETE projection, which is the most
    // misleading value available for a projection that withheld 29.99 MiB.
    const manifest = recordProjection({
      sourceRef: `artifact:sha256:${'a'.repeat(64)}`,
      selectedBytes: 2048,
      projectionReason: 'the source was streamed and its total size was never established',
    })
    expect(manifest.omittedBytes).toBeUndefined()
    expect(projectionWithheld(manifest)).toBe('unknown')
    expect(projectionWithheld(manifest)).not.toBe('complete')
  })

  it('reports a projection that withheld nothing as `complete`, distinctly from `unknown`', () => {
    const manifest = recordProjection({
      sourceRef: `artifact:sha256:${'a'.repeat(64)}`,
      selectedBytes: 4096,
      sourceBytes: 4096,
      projectionReason: 'the whole artifact fit the model request budget',
    })
    expect(manifest.omittedBytes).toBe(0)
    expect(projectionWithheld(manifest)).toBe('complete')
  })

  it('has NO `stage` and NO `recovery`, so a projection cannot be filed as a gap', () => {
    // THE TYPE BOUNDARY, asserted at runtime because that is where a caller
    // crossing languages or reading JSON would hit it. A manifest carrying a
    // `stage` would be structurally usable as a gap, which is exactly the
    // conflation DATA-09 removes.
    const manifest = recordProjection({
      sourceRef: `artifact:sha256:${'a'.repeat(64)}`,
      selectedBytes: 100,
      sourceBytes: 1000,
      projectionReason: 'bounded preview',
    })
    expect(Object.hasOwn(manifest, 'stage')).toBe(false)
    expect(Object.hasOwn(manifest, 'recovery')).toBe(false)
    // And the gap schema does not accept the projection's fields: the two are
    // not interchangeable in either direction.
    expect(Object.keys(manifest).sort()).toEqual([
      'omittedBytes', 'projectionReason', 'recoverableRef', 'selectedBytes', 'sourceRef',
    ])
  })

  it('a descriptor whose ONLY event is a projection stays COMPLETE, with an empty gap list', () => {
    // The consequence that matters for an honest system: projecting deliberately
    // does not make a descriptor look broken. `gaps` is empty because nothing was
    // lost, and `completeness` is untouched because the acquisition was complete.
    const descriptor: ObservationDescriptor = {
      id: 'obs-projected',
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      source: { kind: 'file', locator: 'big.txt', acquiredAt: '2026-01-01T00:00:00.000Z', executionWorld: 'local' },
      captured: { artifact: `artifact:sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 30 * 1024 * 1024, mediaType: 'text/plain' },
      acquisition: { completeness: 'complete-within-request', coverage: null, gaps: [] },
      authority: { ownerScope: 'project:vocab', grantRevision: 1 },
    }
    expect(coverageVerdictOf(descriptor)).toBe('full-for-requested-scope')
    expect(isDeliverableAsComplete(descriptor)).toBe(true)
    // A 30 MiB artifact whose model-visible projection is 2 KiB is still a
    // complete acquisition. A small projection is NOT evidence of a small source.
    const manifest = recordProjection({
      sourceRef: descriptor.captured.artifact,
      selectedBytes: 2048,
      sourceBytes: descriptor.captured.bytes,
      projectionReason: 'bounded preview',
    })
    expect(projectionWithheld(manifest)).toBe('partial')
    expect(descriptor.acquisition.gaps).toEqual([])
  })
})

describe('DATA-09 [real] the schema version refuses a v1 descriptor instead of reinterpreting it', () => {
  it('refuses a version-1 descriptor with a NAMED conversion error, not "malformed"', () => {
    // The version exists precisely so an older shape is not read as current. A v1
    // descriptor's `model-projection` gap asserted that a deliberate projection
    // was an acquisition loss -- a claim this build no longer expresses, so
    // re-reading it would silently convert "we chose to show 2 KiB" into "the
    // world gave us 2 KiB".
    const grants = new GrantTable()
    grants.bump('project:vocab')
    const v1 = {
      id: 'obs-v1',
      schemaVersion: 1,
      source: { kind: 'file', locator: 'x', acquiredAt: '2026-01-01T00:00:00.000Z', executionWorld: 'local' },
      captured: { artifact: `artifact:sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' },
      acquisition: {
        completeness: 'complete-within-request',
        coverage: null,
        gaps: [{ stage: 'model-projection', reason: 'the model saw 10 of 2000 lines', recovery: 'page' }],
      },
      authority: { ownerScope: 'project:vocab', grantRevision: 1 },
    }
    // The CODE is the contract: a caller can branch on it and attempt a
    // conversion. Reporting `observation-malformed` would send it looking for a
    // corrupt write that never happened.
    expect(() => parseObservation(v1, grants)).toThrow(ObservationError)
    try {
      parseObservation(v1, grants)
      throw new Error('unreachable: a v1 descriptor must be refused')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ObservationError)
      expect((error as ObservationError).code).toBe('observation-schema-version-unsupported')
      // The message names the version it found AND the one it reads, so the fix
      // is actionable without re-reading this source.
      expect((error as ObservationError).message).toContain('schema version 1')
      expect((error as ObservationError).message).toContain(String(OBSERVATION_SCHEMA_VERSION))
    }
  })

  it('still reports a genuinely malformed descriptor as malformed, so the codes do not collapse', () => {
    // The distinction has to hold in BOTH directions, or "unsupported version"
    // becomes a catch-all that hides real corruption. A record with the current
    // version and a broken body is malformed, not a conversion.
    const grants = new GrantTable()
    grants.bump('project:vocab')
    expect(() => parseObservation({
      id: 'obs-bad',
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      source: { kind: 'file', acquiredAt: '2026-01-01T00:00:00.000Z', executionWorld: 'local' },
      captured: { artifact: 'not-a-hash', sha256: 'nope', bytes: -1, mediaType: 'text/plain' },
      acquisition: { completeness: 'complete-within-request', coverage: null, gaps: [] },
      authority: { ownerScope: 'project:vocab', grantRevision: 1 },
    }, grants)).toThrow(/malformed/u)
  })

  it('reads a current-version descriptor normally, so the version check is not a blanket refusal', () => {
    const grants = new GrantTable()
    grants.bump('project:vocab')
    const current = {
      id: 'obs-current',
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      source: { kind: 'file', locator: 'x', acquiredAt: '2026-01-01T00:00:00.000Z', executionWorld: 'local' },
      captured: { artifact: `artifact:sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' },
      acquisition: { completeness: 'complete-within-request', coverage: null, gaps: [] },
      authority: { ownerScope: 'project:vocab', grantRevision: 1 },
    }
    expect(parseObservation(current, grants).id).toBe('obs-current')
  })
})

describe('DATA-04 [real] the projection is bounded by the SCHEMA, not only by truncation', () => {
  it('refuses a descriptor whose id would make the projection unbounded', () => {
    // Measured before the bound: an id of 200,000 characters produced a
    // 200,316-byte projection, because `projectForModel` truncates gap reasons
    // and notes but copies `descriptor.id` through verbatim. A "bounded"
    // projection that is unbounded in one field is not bounded.
    const huge = {
      id: 'x'.repeat(200_000),
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      source: { kind: 'file', locator: 'x', acquiredAt: '2026-01-01T00:00:00.000Z', executionWorld: 'local' },
      captured: { artifact: `artifact:sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' },
      acquisition: { completeness: 'complete-within-request', coverage: null, gaps: [] },
      authority: { ownerScope: 'project:vocab', grantRevision: 1 },
    }
    const grants = new GrantTable()
    grants.bump('project:vocab')
    // The schema refuses it at the boundary, so it can never be stored and later
    // discovered by a consumer that had already paid for the read.
    expect(() => parseObservation(huge, grants)).toThrow(/malformed/u)
  })

  it('bounds every string a descriptor carries, so no field can blow the projection', () => {
    const grants = new GrantTable()
    grants.bump('project:vocab')
    const base = {
      id: 'obs-ok',
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      source: { kind: 'file', locator: 'ok', acquiredAt: '2026-01-01T00:00:00.000Z', executionWorld: 'local' },
      captured: { artifact: `artifact:sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' },
      acquisition: { completeness: 'complete-within-request', coverage: null, gaps: [] },
      authority: { ownerScope: 'project:vocab', grantRevision: 1 },
    }
    // The control: an ordinary descriptor parses.
    expect(parseObservation(base, grants).id).toBe('obs-ok')
    // Each address-like field is bounded independently, so no single one of them
    // is the only guard.
    const oversized = [
      { ...base, source: { ...base.source, locator: 'L'.repeat(9000) } },
      { ...base, captured: { ...base.captured, artifact: `artifact:sha256:${'a'.repeat(9000)}` } },
      { ...base, authority: { ownerScope: 'S'.repeat(9000), grantRevision: 1 } },
      { ...base, acquisition: { ...base.acquisition, gaps: [{ stage: 'retention', reason: 'R'.repeat(5000), recovery: 'none' }] } },
    ]
    for (const value of oversized) {
      expect(() => parseObservation(value, grants), 'an oversized field must be refused').toThrow(/malformed/u)
    }
  })
})

// ---------------------------------------------------------------------------
// Cursor identity: a cursor is NOT an authorization token
// ---------------------------------------------------------------------------
//
// The gate's wording is that a cursor binds artifact/source identity,
// representation/query, position, schema version and snapshot watermark -- and
// that possessing one grants nothing. The two properties are tested together
// because they are two halves of one claim: the binding is what makes the
// possession worthless.

describe('cursor identity: a cursor binds its artifact and grants no authority', () => {
  it('refuses a cursor minted for one artifact when presented against another', async () => {
    const root = tempRoot('cursor-identity')
    writeFileSync(join(root, 'a.bin'), 'a'.repeat(300))
    writeFileSync(join(root, 'b.bin'), 'b'.repeat(300))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('cursor-identity-store')
    const base = { fs, store, log, grants, ownerScope: scope, executionWorld: 'local', mediaType: 'application/octet-stream' } as const
    const captureA = await captureFile({ ...base, path: 'a.bin', observationId: 'obs-ca' })
    const captureB = await captureFile({ ...base, path: 'b.bin', observationId: 'obs-cb' })

    const firstA = await pages(store, { descriptor: captureA.descriptor, maxBytes: 64, grants, callerScope: scope })
    expect(firstA.nextCursor).toBeDefined()
    // The SAME caller scope and representation, but a different artifact: the
    // binding is to the object, not to the caller's right to page.
    await expect(pages(store, {
      descriptor: captureB.descriptor, maxBytes: 64, grants, callerScope: scope, cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })

  it('refuses a cursor after the grant revision moves, so possession proves nothing', async () => {
    const root = tempRoot('cursor-authority')
    writeFileSync(join(root, 'a.bin'), 'a'.repeat(300))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('cursor-authority-store')
    const capture = await captureFile({
      fs, path: 'a.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-ca2', mediaType: 'application/octet-stream',
    })
    const first = await pages(store, { descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope })
    // The permission domain changes. The cursor is still a well-formed,
    // correctly-signed host token -- and it is refused, because it is not a
    // capability.
    grants.bump(scope)
    await expect(pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope, cursor: first.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-scope-denied' })
  })

  it('refuses a hand-made cursor that was never minted by the host', async () => {
    // A caller that can forge a position must not be able to skip bytes: the
    // signature is what makes the cursor host-validated rather than asserted.
    const root = tempRoot('cursor-forged')
    writeFileSync(join(root, 'a.bin'), 'a'.repeat(300))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('cursor-forged-store')
    const capture = await captureFile({
      fs, path: 'a.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-forged', mediaType: 'application/octet-stream',
    })
    const forged = `${Buffer.from(JSON.stringify({
      artifactSha256: capture.descriptor.captured.sha256,
      representation: 'bytes',
      position: 200,
      // A cursor binds the DESCRIPTOR's schema version (artifacts.ts:691 mints
      // the authority from `descriptor.schemaVersion`), so a hard-coded 1 here
      // would be rejected for the version rather than for the missing signature
      // -- and the test would pass for the wrong reason.
      schemaVersion: capture.descriptor.schemaVersion,
      ownerScope: scope,
      watermark: capture.descriptor.source.acquiredAt,
    }), 'utf8').toString('base64url')}.not-a-real-signature`
    await expect(pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope, cursor: forged,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })

  it('refuses a cursor signed with a different secret than the host\u2019s', async () => {
    // Representation and secret are both bindings, not hints: a cursor minted
    // elsewhere must not resume a walk here even when every field it names is
    // otherwise correct.
    const root = tempRoot('cursor-repr')
    writeFileSync(join(root, 'a.bin'), 'a'.repeat(300))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('cursor-repr-store')
    const capture = await captureFile({
      fs, path: 'a.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-repr', mediaType: 'application/octet-stream',
    })
    const first = await pages(store, { descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope })
    const authority = new CursorAuthority('some-other-secret', capture.descriptor.schemaVersion)
    // Every field is correct INCLUDING the realm, so the refusal can only be the
    // secret. A cursor minted with another host's secret must not resume a walk here
    // even when it names this store.
    const foreign = authority.mint({
      storeRealmId: await store.ensureRealm(),
      artifactSha256: capture.descriptor.captured.sha256,
      observationId: capture.descriptor.id,
      revision: `${capture.descriptor.captured.sha256}@g${String(capture.descriptor.authority.grantRevision)}`,
      representation: 'bytes',
      query: 'bytes:64',
      position: 64,
      ownerScope: scope,
      watermark: capture.descriptor.source.acquiredAt,
    })
    expect(foreign).not.toBe(first.nextCursor)
    await expect(pages(store, {
      descriptor: capture.descriptor, maxBytes: 64, grants, callerScope: scope, cursor: foreign,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })
})

// ---------------------------------------------------------------------------
// DATA-07 -- cursors are stable against an unchanged immutable object
// ---------------------------------------------------------------------------
//
// Immutability is what makes a cursor's position meaningful: the same cursor
// against the same artifact must always yield the same bytes, no matter how many
// times it is replayed. A cursor that drifted would make a resumed walk splice
// the wrong region, which is silent corruption rather than an error.

describe('DATA-07 [real] a cursor over an immutable artifact is stable across replays', () => {
  it('returns the same bytes for the same cursor every time it is replayed', async () => {
    const root = tempRoot('data07-stable')
    const content = Buffer.from(Array.from({ length: 400 }, (_, index) => String.fromCharCode(0x41 + (index % 26))).join(''))
    writeFileSync(join(root, 'stable.bin'), content)
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data07-stable-store')
    const capture = await captureFile({
      fs, path: 'stable.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-stable', mediaType: 'application/octet-stream',
    })
    const first = await pages(store, { descriptor: capture.descriptor, maxBytes: 100, grants, callerScope: scope })
    expect(first.nextCursor).toBeDefined()

    // Replay the SAME cursor three times and demand byte-identical results.
    const replays: string[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await pages(store, {
        descriptor: capture.descriptor, maxBytes: 100, grants, callerScope: scope, cursor: first.nextCursor ?? '',
      })
      replays.push(Buffer.from(again.bytes).toString('hex'))
      expect(again.offset).toBe(100)
      expect(again.sha256).toBe(capture.descriptor.captured.sha256)
    }
    expect(new Set(replays).size, 'a cursor must be a stable reference, not a moving one').toBe(1)
    // And the replay really is the artifact's bytes at that offset, not an
    // unrelated window that happens to be stable.
    expect(replays[0]).toBe(content.subarray(100, 200).toString('hex'))
  })

  it('advances the offset by exactly the page size on a full walk', async () => {
    // Stability must not be achieved by never advancing: a walk that returned the
    // same page forever would satisfy the test above and be useless. The offsets
    // are asserted to be a strict, gapless partition of the artifact.
    const root = tempRoot('data07-partition')
    const totalBytes = 1000
    writeFileSync(join(root, 'part.bin'), Buffer.alloc(totalBytes, 0x64))
    const { fs } = mountFs(root)
    const { store, log, grants, scope } = makePlane('data07-partition-store')
    const capture = await captureFile({
      fs, path: 'part.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-partition', mediaType: 'application/octet-stream',
    })
    const offsets: number[] = []
    const collected: ArtifactPage[] = []
    await walkPages(new ArtifactStorePageProvider(store), {
      descriptor: capture.descriptor, maxBytes: 256, grants, callerScope: scope,
    }, { onPage: page => { offsets.push(page.offset); collected.push(page) } })
    expect(offsets).toEqual([0, 256, 512, 768])
    // The join is the artifact, byte for byte -- so the pages partitioned it
    // rather than overlapping or skipping.
    const joined = joinPages(collected, capture.descriptor.captured.bytes)
    expect(Buffer.from(joined).equals(Buffer.alloc(totalBytes, 0x64))).toBe(true)
  })
})
