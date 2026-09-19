/**
 * T8-data: measure the FOUR byte-count classes of the data plane SEPARATELY,
 * on real files, through the real production modules, and persist a REAL
 * observation artifact whose own byte accounting is verifiable from outside.
 *
 * WHY THIS EXISTS. The plan's DATA-04/DATA-12 rule is that four byte counts must
 * never collapse into one number. If they collapse, "programmatic native
 * consumption" is unverifiable: a small projection is indistinguishable from a
 * small source, and a short capture from a small file. The four, as the sources
 * name them (`src/data-plane.test.ts`, the DATA-04/12 block):
 *
 *   1. acquiredBytes      `capture.io.sourceBytesRead`  -- bytes read across the SOURCE boundary
 *   2. persistedBytes     `store.stat(artifact).bytes`  -- bytes the durable object actually holds
 *   3. consumedBytes      sum of page bytes a consumer read OUT of the artifact
 *   4. modelVisibleBytes  UTF-8 length of the serialized `projectForModel` projection
 *
 * This probe reports each from its OWN source (not from a shared local), and then
 * reports cases where two of them DIVERGE so a conflation would be visible.
 *
 * THE ARTIFACT IS REAL AND STAYS ON DISK. Scenario S1/S2 capture through the real
 * `captureFile` + `LocalArtifactStore` + `LocalFileSystem`, and the store root is
 * `qualification/results/T8-data/artifacts`, so the published immutable object
 * remains after the run. Its byte count and digest are recorded, and a SEPARATE
 * process (`t8-verify-artifact.mjs`) re-derives them from the file on disk --
 * the numbers here are not a summary computed in-process.
 *
 * THE CONSUMER IS A REAL OUT-OF-PROCESS PROCESS. Scenario S1 pushes every page to
 * a real CPython 3.14 child over a pipe; the child counts the bytes it received
 * and hashes them independently, so `consumedBytes` has two witnesses: the host's
 * page walk and the consumer's own tally.
 *
 * WHAT THIS DOES NOT PROVE (stated so a green result is not over-read):
 *   - It does not use the `ipython` tool or an ipykernel. The ipykernel variant of
 *     this consumption is `src/data-plane.test.ts` DAT-02, which the gate table
 *     records as a separate run. Here the consumer is a bare CPython process,
 *     which is a real process boundary but not the M3 kernel path.
 *   - It does not prove a cell can call `data.*` as a native tool. No such tool
 *     row exists anywhere in this tree (M4/M11/R5 all measured the absence).
 *   - "What the transcript stores" is NOT one of these four. The data plane's
 *     durable record is the observation descriptor + the reference row; its
 *     serialized size is reported as a SUPPLEMENTARY number, clearly labelled.
 *     The Session transcript's own byte count belongs to the history plane
 *     (`history-plane.ts` `canonicalEventBytes`) and is read-in-source here, not
 *     measured.
 *
 * Run from packages/dsh-daily-work:
 *   node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-four-byte-classes.mjs
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const OUT_DIR = 'D:/DSH/work/dsh-native-daily/qualification/results/T8-data'
/** The artifact root is INSIDE the evidence directory, so the object survives. */
const ARTIFACT_ROOT = join(OUT_DIR, 'artifacts')
const PYTHON = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
const artifacts = await import(pathToFileURL(`${PKG}/src/artifacts.ts`).href)
const observations = await import(pathToFileURL(`${PKG}/src/observations.ts`).href)

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const utf8Bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

/** Temp roots created by this run, removed in `finally`. */
const tempDirs = []
function tempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `t8-${label}-`))
  tempDirs.push(dir)
  return dir
}

/** A real `LocalFileSystem` over a real directory. */
function mountFs(cwd) {
  const ctx = new Context()
  return { ctx, fs: new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 }) }
}

/** A real store + log + grants triple. */
function makePlane(label, storeRoot, options) {
  const store = new artifacts.LocalArtifactStore(storeRoot ?? join(tempRoot(label), 'artifacts'), options)
  const log = new artifacts.InMemorySessionReferenceLog()
  const grants = new observations.GrantTable()
  const scope = 'project:t8'
  grants.bump(scope)
  return { store, log, grants, scope }
}

/** The object path for a digest, so the OS's own stat can be read. */
function objectPath(store, digest) {
  return join(store.root, 'objects', digest.slice(0, 2), digest)
}

/**
 * The stimulus: 1 MiB of 1024-byte lines, which is exactly 16 pages of 64 KiB.
 *
 * Deterministic on purpose -- the recipe is recorded in the provenance so the
 * artifact can be regenerated and its digest re-checked by a reader who does not
 * trust this file.
 */
const LINE = `${'t8'.repeat(511)}X\n`
if (LINE.length !== 1024) throw new Error(`stimulus line is ${LINE.length} bytes, expected 1024`)
const STIMULUS_BYTES = 1024 * 1024
function stimulusBuffer() {
  return Buffer.from(LINE.repeat(STIMULUS_BYTES / LINE.length), 'utf8')
}

/**
 * The CPython consumer: reads length-prefixed frames from stdin and reports its
 * OWN byte tally and digest, so the consumed count has an independent witness.
 */
const PY_CONSUMER = `
import sys, json, hashlib
stdin = sys.stdin.buffer
h = hashlib.sha256()
pages = 0
total = 0
while True:
    header = stdin.read(4)
    if len(header) < 4:
        break
    n = int.from_bytes(header, "big")
    if n == 0:
        break
    buf = b""
    while len(buf) < n:
        piece = stdin.read(n - len(buf))
        if not piece:
            break
        buf += piece
    h.update(buf)
    pages += 1
    total += len(buf)
print(json.dumps({"pages": pages, "bytes": total, "sha256": h.hexdigest()}))
`

/** Start the real CPython consumer and return a handle to feed frames to. */
function startConsumer() {
  const child = spawn(PYTHON, ['-u', '-c', PY_CONSUMER], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  const done = new Promise(resolve => {
    child.on('close', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
  return {
    feed(bytes) {
      const header = Buffer.alloc(4)
      header.writeUInt32BE(bytes.byteLength, 0)
      child.stdin.write(header)
      child.stdin.write(Buffer.from(bytes))
    },
    finish() {
      child.stdin.end()
      return done
    },
    kill() {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    },
  }
}

const out = {
  probe: 't8-four-byte-classes',
  startedAt: new Date().toISOString(),
  host: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    python: existsSync(PYTHON) ? PYTHON : 'MISSING',
  },
  commands: {
    thisProbe: 'cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node --import tsx/esm '
      + 'D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-four-byte-classes.mjs',
    verifier: 'cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node --import tsx/esm '
      + 'D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-verify-artifact.mjs',
  },
  byteClasses: {
    acquiredBytes: 'capture.io.sourceBytesRead -- bytes read across the SOURCE boundary during capture',
    persistedBytes: 'store.stat(artifact).bytes -- bytes the durable object actually holds',
    consumedBytes: 'sum of page.bytes.byteLength served to a consumer -- bytes crossing the artifact boundary',
    modelVisibleBytes: 'UTF-8 length of JSON.stringify(projectForModel(...)) -- bytes crossing into the model context',
  },
  scenarios: {},
  notes: [],
}

let consumer = null
try {
  mkdirSync(ARTIFACT_ROOT, { recursive: true })
  const stimulus = stimulusBuffer()
  out.stimulus = {
    bytes: stimulus.byteLength,
    sha256: sha256(stimulus),
    recipe: 'the 1024-byte line "t8" x511 + LF, repeated 1024 times (1 MiB exactly)',
    lineBytes: LINE.length,
    lines: STIMULUS_BYTES / LINE.length,
  }

  // ======================================================================
  // S1 -- the control: one real artifact, all four classes measured, and a
  // real CPython consumer that reads every page out of it.
  // ======================================================================
  const s1Root = tempRoot('s1-source')
  writeFileSync(join(s1Root, 'stimulus.txt'), stimulus)
  const s1 = mountFs(s1Root)
  const s1Plane = makePlane('s1-store', ARTIFACT_ROOT)
  const s1Capture = await artifacts.captureFile({
    fs: s1.fs, path: 'stimulus.txt', store: s1Plane.store, log: s1Plane.log,
    grants: s1Plane.grants, ownerScope: s1Plane.scope, executionWorld: 'local',
    observationId: 'obs-t8-s1', mediaType: 'text/plain',
  })

  // (1) ACQUIRED -- the capture's own source counter.
  const acquiredBytes = s1Capture.io.sourceBytesRead
  // (2) PERSISTED -- the store's own stat, plus the OS's stat of the object file.
  const artifactRef = s1Capture.descriptor.captured.artifact
  const persisted = await s1Plane.store.stat(artifactRef)
  const artifactFile = objectPath(s1Plane.store, s1Capture.descriptor.captured.sha256)
  const osStat = statSync(artifactFile)
  const artifactOnDisk = readFileSync(artifactFile)

  // (3) CONSUMED -- a real page walk, every page pushed to a real CPython child.
  const s1Io = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
  let consumedBytes = 0
  consumer = startConsumer()
  const s1Walk = await artifacts.walkPages(
    new artifacts.ArtifactStorePageProvider(s1Plane.store),
    { descriptor: s1Capture.descriptor, maxBytes: artifacts.DEFAULT_PAGE_BYTES, grants: s1Plane.grants, callerScope: s1Plane.scope },
    {
      counters: s1Io,
      onPage: page => {
        consumedBytes += page.bytes.byteLength
        consumer.feed(page.bytes)
      },
    },
  )
  const consumerResult = await consumer.finish()
  consumer = null
  const consumerJson = consumerResult.code === 0 ? JSON.parse(consumerResult.stdout) : null

  // (4) MODEL-VISIBLE -- the serialized projection, the only thing the model sees.
  const s1Projection = artifacts.projectForModel({
    descriptor: s1Capture.descriptor,
    pagesConsumed: s1Walk.pages,
    bytesConsumed: consumedBytes,
    exhausted: s1Walk.exhausted,
    consumerNote: 'real CPython consumed every page over a pipe; nothing retained in context',
  })
  const modelVisibleBytes = utf8Bytes(s1Projection)

  out.scenarios.S1_full_walk = {
    what: 'a 1 MiB file captured, then fully consumed by a real CPython child; all four classes on ONE artifact',
    acquiredBytes,
    persistedBytes: persisted?.bytes ?? -1,
    persistedBytesOsStat: osStat.size,
    persistedBytesStoreStatSha256: persisted?.sha256 ?? null,
    persistedBytesOsStatSha256: sha256(artifactOnDisk),
    consumedBytes,
    consumedBytesConsumerTally: consumerJson?.bytes ?? null,
    consumedBytesConsumerSha256: consumerJson?.sha256 ?? null,
    consumedBytesPhysicalArtifactIo: s1Io.artifactBytesRead,
    consumedBytesArtifactReads: s1Io.artifactReads,
    consumedBytesSourceReadDuringPaging: s1Io.sourceBytesRead,
    modelVisibleBytes,
    pagesWalked: s1Walk.pages,
    exhausted: s1Walk.exhausted,
    artifactRef,
    artifactPath: artifactFile,
    artifactSha256: s1Capture.descriptor.captured.sha256,
    artifactCompleteness: s1Capture.descriptor.acquisition.completeness,
    ratioConsumedToModelVisible: Math.round(consumedBytes / modelVisibleBytes),
    consumerExitCode: consumerResult.code,
    consumerStderr: consumerResult.stderr.slice(0, 400),
  }

  // ======================================================================
  // S2 -- NON-CONFLATION: persisted and consumed are DIFFERENT on the SAME
  // artifact, and the record reports both. A code path that reported the
  // artifact's size as the consumed count would fail this.
  // ======================================================================
  let s2Consumed = 0
  const s2Io = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
  const s2Walk = await artifacts.walkPages(
    new artifacts.ArtifactStorePageProvider(s1Plane.store),
    { descriptor: s1Capture.descriptor, maxBytes: artifacts.DEFAULT_PAGE_BYTES, grants: s1Plane.grants, callerScope: s1Plane.scope },
    // `maxPages: 1` is the whole point of this scenario: the walk STOPS after one
    // page, so the bytes that crossed the artifact boundary are one page while the
    // artifact still holds all 16. A conflated implementation would report 1 MiB.
    { counters: s2Io, maxPages: 1, onPage: page => { s2Consumed += page.bytes.byteLength } },
  )
  const s2Projection = artifacts.projectForModel({
    descriptor: s1Capture.descriptor, pagesConsumed: s2Walk.pages, bytesConsumed: s2Consumed,
    exhausted: s2Walk.exhausted, consumerNote: 'first page only',
  })
  out.scenarios.S2_partial_walk = {
    what: 'the SAME artifact walked only for its FIRST page: persisted must stay 1 MiB while consumed is one page',
    persistedBytes: persisted?.bytes ?? -1,
    consumedBytes: s2Consumed,
    consumedBytesPhysicalArtifactIo: s2Io.artifactBytesRead,
    pagesWalked: s2Walk.pages,
    exhausted: s2Walk.exhausted,
    modelVisibleBytes: utf8Bytes(s2Projection),
    projectionArtifactBytesField: s2Projection.artifactBytes,
    projectionBytesConsumedField: s2Projection.bytesConsumed,
    differ: (persisted?.bytes ?? -1) !== s2Consumed,
  }

  // ======================================================================
  // S3 -- acquired vs the SOURCE FILE's size: a reader that stops early.
  // ======================================================================
  const s3Root = tempRoot('s3-short')
  writeFileSync(join(s3Root, 'short.bin'), Buffer.alloc(1000, 0x63))
  const s3 = mountFs(s3Root)
  const s3Plane = makePlane('s3-store')
  const s3Capture = await artifacts.captureFile({
    fs: s3.fs, path: 'short.bin', store: s3Plane.store, log: s3Plane.log,
    grants: s3Plane.grants, ownerScope: s3Plane.scope, executionWorld: 'local',
    observationId: 'obs-t8-s3', mediaType: 'application/octet-stream',
    readChunks: async function* () { yield Buffer.alloc(400, 0x63) },
  })
  out.scenarios.S3_short_acquisition = {
    what: 'a 1000-byte file whose reader stops at 400 bytes: acquired must be 400, not the file size',
    sourceFileBytes: 1000,
    acquiredBytes: s3Capture.io.sourceBytesRead,
    persistedBytes: s3Capture.descriptor.captured.bytes,
    completeness: s3Capture.descriptor.acquisition.completeness,
    gapStages: s3Capture.gaps.map(gap => gap.stage),
    gapRecoveries: s3Capture.gaps.map(gap => gap.recovery),
    gapReasonNamesMissingBytes: s3Capture.gaps.some(gap => gap.reason.includes('600')),
    referenceState: s3Capture.reference.state,
  }

  // ======================================================================
  // S4 -- acquired vs persisted when the RETENTION layer refuses: the store
  // publishes nothing, so persisted is ABSENT while acquired is not zero.
  // ======================================================================
  const s4Root = tempRoot('s4-quota')
  writeFileSync(join(s4Root, 'big.txt'), stimulus)
  const s4 = mountFs(s4Root)
  const s4Plane = makePlane('s4-store', undefined, { quotaBytes: 16 * 1024 })
  const s4Capture = await artifacts.captureFile({
    fs: s4.fs, path: 'big.txt', store: s4Plane.store, log: s4Plane.log,
    grants: s4Plane.grants, ownerScope: s4Plane.scope, executionWorld: 'local',
    observationId: 'obs-t8-s4', mediaType: 'text/plain',
  })
  // The retention refusal publishes NOTHING, so the descriptor carries a
  // placeholder reference that is deliberately not a digest. `store.stat` on it
  // throws `artifact-not-found` -- which is itself the measurement: there is no
  // object to stat. That is recorded rather than smoothed into a zero.
  let s4Published = null
  let s4StatRefused = null
  try {
    s4Published = await s4Plane.store.stat(s4Capture.descriptor.captured.artifact)
  } catch (error) {
    s4StatRefused = `${error?.constructor?.name}: ${String(error?.message).slice(0, 200)}`
  }
  const s4Referenced = await s4Plane.log.referencedArtifacts()
  out.scenarios.S4_quota_refusal = {
    what: 'a 1 MiB source against a 16 KiB quota: acquired > 0 while persisted is ABSENT (nothing published)',
    sourceFileBytes: stimulus.byteLength,
    quotaBytes: 16 * 1024,
    acquiredBytes: s4Capture.io.sourceBytesRead,
    persistedBytes: s4Published?.bytes ?? null,
    persistedIsAbsent: s4Published === undefined || s4Published === null,
    statRefused: s4StatRefused !== null,
    statOnPlaceholderRefusedWith: s4StatRefused,
    descriptorCapturedBytes: s4Capture.descriptor.captured.bytes,
    descriptorArtifactRef: s4Capture.descriptor.captured.artifact,
    completeness: s4Capture.descriptor.acquisition.completeness,
    gapStages: s4Capture.gaps.map(gap => gap.stage),
    gapRecoveries: s4Capture.gaps.map(gap => gap.recovery),
    referenceState: s4Capture.reference.state,
    referenceArtifact: s4Capture.reference.artifact,
    logReferencedArtifacts: [...s4Referenced],
    acquiredDiffersFromPersisted: s4Capture.io.sourceBytesRead !== (s4Published?.bytes ?? 0),
    projectionBytes: utf8Bytes(artifacts.projectForModel({
      descriptor: s4Capture.descriptor, pagesConsumed: 0, bytesConsumed: 0,
      exhausted: false, gaps: s4Capture.gaps,
    })),
  }

  // ======================================================================
  // S5 -- `requestedRange` is RECORDED but never HONOURED by the read. This is
  // a measurement of the product, not a preference: the capture streams the
  // WHOLE file and then writes the caller's range into `coverage`, so the
  // recorded request scope and the acquired bytes are two different numbers.
  // ======================================================================
  const s5Root = tempRoot('s5-range')
  writeFileSync(join(s5Root, 'range.txt'), stimulus)
  const s5 = mountFs(s5Root)
  const s5Plane = makePlane('s5-store')
  const s5Capture = await artifacts.captureFile({
    fs: s5.fs, path: 'range.txt', store: s5Plane.store, log: s5Plane.log,
    grants: s5Plane.grants, ownerScope: s5Plane.scope, executionWorld: 'local',
    observationId: 'obs-t8-s5', mediaType: 'text/plain',
    requestedRange: { offset: 0, length: 64 * 1024 },
  })
  const s5Stat = await s5Plane.store.stat(s5Capture.descriptor.captured.artifact)
  out.scenarios.S5_requested_range_not_honoured = {
    what: 'a caller asks for a 64 KiB range of a 1 MiB file: the range is RECORDED in coverage, the read is not narrowed',
    sourceFileBytes: stimulus.byteLength,
    requestedRange: { offset: 0, length: 64 * 1024 },
    acquiredBytes: s5Capture.io.sourceBytesRead,
    persistedBytes: s5Stat?.bytes ?? -1,
    coverageRecorded: s5Capture.descriptor.acquisition.coverage,
    completeness: s5Capture.descriptor.acquisition.completeness,
    gaps: s5Capture.gaps.length,
    rangeWasHonoured: (s5Stat?.bytes ?? -1) === 64 * 1024,
  }

  // ======================================================================
  // S6 -- THE GUARD IS BYPASSABLE. `captureFile` disables its acquired-vs-
  // persisted shortfall check whenever `requestedRange` is present, but the
  // read is NOT narrowed by that field. So a capture whose reader stops early
  // reports `complete-within-request` with NO gap when a range is named, while
  // the same short read without the range is correctly `partial` with a
  // `native-acquisition` gap (S3). Same bytes, two different verdicts.
  // ======================================================================
  const s6Root = tempRoot('s6-bypass')
  writeFileSync(join(s6Root, 'short.bin'), Buffer.alloc(1000, 0x63))
  const s6 = mountFs(s6Root)
  const s6Plane = makePlane('s6-store')
  const s6Capture = await artifacts.captureFile({
    fs: s6.fs, path: 'short.bin', store: s6Plane.store, log: s6Plane.log,
    grants: s6Plane.grants, ownerScope: s6Plane.scope, executionWorld: 'local',
    observationId: 'obs-t8-s6', mediaType: 'application/octet-stream',
    readChunks: async function* () { yield Buffer.alloc(400, 0x63) },
    requestedRange: { offset: 0 },
  })
  out.scenarios.S6_shortfall_guard_bypass = {
    what: 'the SAME 400-of-1000-byte short read as S3, but with requestedRange present: the gap disappears',
    sourceFileBytes: 1000,
    acquiredBytes: s6Capture.io.sourceBytesRead,
    persistedBytes: s6Capture.descriptor.captured.bytes,
    completeness: s6Capture.descriptor.acquisition.completeness,
    gaps: s6Capture.gaps.length,
    gapStages: s6Capture.gaps.map(gap => gap.stage),
    coverageRecorded: s6Capture.descriptor.acquisition.coverage,
    isDeliverableAsComplete: observations.isDeliverableAsComplete(s6Capture.descriptor),
    sameStimulusAsS3: true,
    verdictDiffersFromS3: s6Capture.descriptor.acquisition.completeness !== out.scenarios.S3_short_acquisition.completeness,
  }

  // ======================================================================
  // SUPPLEMENTARY (NOT one of the four): the TOOL-OUTPUT boundary. The brief's
  // own example names "raw tool output vs what the model sees vs what is
  // persisted vs what the transcript stores". For a `grep`, the four numbers at
  // THAT boundary are different again, so they are measured separately here
  // rather than being assumed to equal the data plane's four. Real ripgrep,
  // real parser, real retention, real renderer.
  //
  // AND: the raw figure is PATH-DEPENDENT. `rawBytes` is ripgrep's `--json`
  // stdout, and every match event embeds the absolute path, so two runs over
  // IDENTICAL content in differently-named directories produce different "raw
  // bytes". The sweep below pins that, because a raw byte count quoted without
  // its path is not reproducible.
  // ======================================================================
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const searchCore = await import(resolveFromPkg('@deepseek-ai/dsh-tool-fs-search/src/search-core.ts'))
    const grep = await import(resolveFromPkg('@deepseek-ai/dsh-tool-fs-search/src/grep.ts'))
    // `resolveRgPath` is ASYNC; awaiting it is what makes the production resolution
    // path the one used, rather than a hardcoded fallback.
    const rg = await searchCore.resolveRgPath()
    if (!existsSync(rg)) throw new Error(`ripgrep not resolvable at ${rg}`)
    const rgVersion = (await execFileAsync(rg, ['--version'])).stdout.split('\n')[0]

    const gRoot = tempRoot('s7-grep')
    const matchCount = 900
    const lines = Array.from({ length: matchCount }, (_, index) => `needle-${index}-${'x'.repeat(20)}`)
    writeFileSync(join(gRoot, 'many.txt'), `${lines.join('\n')}\n`)

    const { stdout } = await execFileAsync(rg, ['--json', '--no-config', 'needle', join(gRoot, 'many.txt')], {
      maxBuffer: 64 * 1024 * 1024,
    })
    const rawBytes = Buffer.byteLength(stdout, 'utf8')
    const parsed = grep.parseGrepMatches(stdout)
    const canonical = parsed.map(match => ({ path: match.path, lineNumber: match.lineNumber, line: match.line }))
    const retained = searchCore.retainGrepMatches(canonical, grep.GREP_MAX_MATCHES, grep.GREP_MAX_LINE_BYTES)
    const rendered = grep.formatGrepOutput(retained, undefined)

    const g = mountFs(gRoot)
    const gPlane = makePlane('s7-store')
    const canonicalJson = JSON.stringify(canonical)
    writeFileSync(join(gRoot, 'canonical.json'), canonicalJson)
    const gCapture = await artifacts.captureFile({
      fs: g.fs, path: 'canonical.json', store: gPlane.store, log: gPlane.log,
      grants: gPlane.grants, ownerScope: gPlane.scope, executionWorld: 'local',
      observationId: 'obs-t8-s7', mediaType: 'application/json',
    })
    const gStat = await gPlane.store.stat(gCapture.descriptor.captured.artifact)
    let gConsumed = 0
    const gWalk = await artifacts.walkPages(
      new artifacts.ArtifactStorePageProvider(gPlane.store),
      { descriptor: gCapture.descriptor, maxBytes: artifacts.DEFAULT_PAGE_BYTES, grants: gPlane.grants, callerScope: gPlane.scope },
      { onPage: page => { gConsumed += page.bytes.byteLength } },
    )

    // --- the raw-cap refusal, through the PRODUCTION runner ----------------
    const { Context: ProbeCtx } = await import(resolveFromPkg('@deepseek-ai/cordis'))
    const { default: Subprocess } = await import(resolveFromPkg('@deepseek-ai/dsh-subprocess-local'))
    const capCtx = new ProbeCtx()
    await capCtx.plugin(Subprocess)
    const capExec = { signal: new AbortController().signal, agent: undefined }
    const capArgs = ['--json', '--no-config', 'needle', join(gRoot, 'many.txt')]
    const generous = await searchCore.runRipgrep(capCtx, capExec, 'grep', capArgs, searchCore.RAW_OUTPUT_MAX_BYTES, 5000, 64 * 1024)
    let tinyCap
    try {
      await searchCore.runRipgrep(capCtx, capExec, 'grep', capArgs, 4096, 5000, 64 * 1024)
      tinyCap = { threw: false, note: 'the real path returned a short result instead of refusing' }
    } catch (error) {
      tinyCap = {
        threw: true, name: error?.name ?? null, code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 240),
      }
    }
    await capCtx.fiber.dispose()

    // --- the path-length sweep ---------------------------------------------
    const lenBase = tempRoot('s7-len')
    mkdirSync(join(lenBase, 'd'), { recursive: true })
    const prefix = join(lenBase, 'd')
    const sweep = []
    for (const targetLen of [prefix.length + 1 + 6 + 'many.txt'.length, prefix.length + 1 + 7 + 'many.txt'.length, prefix.length + 1 + 8 + 'many.txt'.length]) {
      const padLen = targetLen - prefix.length - 1 - 'many.txt'.length
      const file = join(prefix, `${'p'.repeat(padLen)}many.txt`)
      if (file.length !== targetLen) throw new Error(`path is ${file.length}, wanted ${targetLen}`)
      writeFileSync(file, `${lines.join('\n')}\n`)
      const run = await execFileAsync(rg, ['--json', '--no-config', 'needle', file], { maxBuffer: 64 * 1024 * 1024 })
      sweep.push({ pathChars: file.length, rawBytes: Buffer.byteLength(run.stdout, 'utf8') })
    }

    // --- the TIMING jitter, on a FIXED path --------------------------------
    // The path sweep explains one axis. There is a second, and it is worse: the
    // SAME command on the SAME path does not produce the same number of bytes.
    // ripgrep's `--json` stream ends with its own `summary` event carrying
    // `elapsed.human` and `elapsed.nanos`, and a sub-millisecond search emits a
    // 6-digit nanos value where a slower one emits 7. So the "raw tool output"
    // size depends on how long the search took, not only on what it found.
    // `bytes_printed` -- the part that is actually the match data -- is constant.
    const jitter = []
    for (let i = 0; i < 10; i += 1) {
      const run = await execFileAsync(rg, ['--json', '--no-config', 'needle', join(gRoot, 'many.txt')], { maxBuffer: 64 * 1024 * 1024 })
      const summaryLine = run.stdout.trim().split('\n').at(-1) ?? ''
      const summary = JSON.parse(summaryLine)
      jitter.push({
        rawBytes: Buffer.byteLength(run.stdout, 'utf8'),
        summaryEventBytes: Buffer.byteLength(summaryLine, 'utf8'),
        bytesPrinted: summary.data?.stats?.bytes_printed ?? null,
        nanosSearchDigits: String(summary.data?.elapsed?.nanos ?? '').length,
      })
    }

    out.scenarios.S7_tool_output_boundary = {
      what: 'ONE grep: the raw stdout, the canonical set, the rendered 250 rows and the model projection are four different numbers',
      rawToolOutputBytes: rawBytes,
      rawCapBytes: searchCore.RAW_OUTPUT_MAX_BYTES,
      rawCapReached: rawBytes >= searchCore.RAW_OUTPUT_MAX_BYTES,
      canonicalMatches: canonical.length,
      canonicalJsonBytes: Buffer.byteLength(canonicalJson, 'utf8'),
      rendererKept: retained.kept,
      rendererSeen: retained.seen,
      rendererTruncated: retained.truncated,
      renderedTextBytes: utf8Bytes(rendered),
      renderedRowCount: rendered.split('\n').filter(line => line.includes('needle-')).length,
      renderedSaysItOmitted: /650|omitted|more/u.test(rendered),
      persistedBytes: gStat?.bytes ?? -1,
      consumedBytes: gConsumed,
      pagesWalked: gWalk.pages,
      modelVisibleBytes: utf8Bytes(artifacts.projectForModel({
        descriptor: gCapture.descriptor, pagesConsumed: gWalk.pages, bytesConsumed: gConsumed,
        exhausted: gWalk.exhausted, consumerNote: 'canonical grep set read whole',
      })),
      ripgrepPath: rg,
      ripgrepVersion: rgVersion,
      pathCharsForRawBytes: join(gRoot, 'many.txt').length,
      rawCapGenerous: { rawBytes: Buffer.byteLength(generous.stdout, 'utf8'), parsedMatches: grep.parseGrepMatches(generous.stdout).length },
      rawCapTiny: tinyCap,
      pathLengthSweep: sweep,
      rawBytesPerPathChar: sweep.length >= 2 ? (sweep[1].rawBytes - sweep[0].rawBytes) / (sweep[1].pathChars - sweep[0].pathChars) : null,
      rawBytesIsPathDependent: sweep.length >= 2 && sweep[0].rawBytes !== sweep[1].rawBytes,
      rawBytesJitterSamePath: {
        samples: jitter,
        distinctRawBytes: [...new Set(jitter.map(sample => sample.rawBytes))],
        distinctBytesPrinted: [...new Set(jitter.map(sample => sample.bytesPrinted))],
        distinctSummaryEventBytes: [...new Set(jitter.map(sample => sample.summaryEventBytes))],
        jittersOnAFixedPath: new Set(jitter.map(sample => sample.rawBytes)).size > 1,
        matchDataIsStable: new Set(jitter.map(sample => sample.bytesPrinted)).size === 1,
        cause: 'ripgrep\'s own summary event carries elapsed.human / elapsed.nanos; a sub-millisecond search emits 6 nanos digits where a slower one emits 7',
      },
    }
  } catch (error) {
    out.scenarios.S7_tool_output_boundary = { error: `${error?.constructor?.name}: ${String(error?.message).slice(0, 400)}` }
    out.notes.push('S7 (tool-output boundary) could not run; the data plane four are unaffected')
  }

  // ======================================================================
  // S8 -- the four counts through the PRODUCTION SERVICE, not the library.
  //
  // Every scenario above drives `artifacts.ts` directly, which proves the MODULE
  // works and says nothing about whether the PRODUCT uses it -- the defect class
  // this project has recorded repeatedly (a port with no production caller). So
  // the same capture + walk + projection runs through `DataPlaneService`, which
  // is what the `dsh-daily-work/data-host` plugin row constructs, over the REAL
  // storage domain that the row opens.
  // ======================================================================
  try {
    const { default: Storage } = await import(resolveFromPkg('@deepseek-ai/dsh-storage'))
    const storageJson = await import(resolveFromPkg('@deepseek-ai/dsh-storage-json'))
    const storageDomain = await import(resolveFromPkg('@deepseek-ai/dsh-storage-domain'))
    const { DataPlaneService } = await import(pathToFileURL(`${PKG}/src/data-service.ts`).href)
    const svcRoot = tempRoot('s8-service')
    const svcCtx = new Context()
    await svcCtx.plugin(Storage)
    // The JSON backend owns the ROOT (`root` is its own required config, with no
    // default); the domain facility selects the backend by name.
    await svcCtx.plugin(storageJson, { root: join(svcRoot, 'store') })
    await svcCtx.plugin(storageDomain, { backend: 'json' })
    const svc = new DataPlaneService(svcCtx, {
      artifactRoot: join(svcRoot, 'artifacts'),
      ownerScope: 'project:t8',
      executionWorld: 'local',
    })
    // `open` is what the plugin row calls; it opens the reference domain and bumps
    // the grant, so a descriptor minted before it would be stale.
    await svc.open(svcCtx.storageDomain)
    try {
      writeFileSync(join(svcRoot, 'svc.txt'), stimulus)
      const svcFs = new LocalFileSystem(new Context(), { cwd: svcRoot, diffBasisMaxBytes: 10 * 1024 * 1024 })
      const svcCapture = await svc.capture({ fs: svcFs, path: 'svc.txt', mediaType: 'text/plain', observationId: 'obs-t8-s8' })
      const svcIo = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
      const svcWalk = await svc.walk({ descriptor: svcCapture.descriptor, counters: svcIo })
      const svcProjection = artifacts.projectForModel({
        descriptor: svcCapture.descriptor, pagesConsumed: svcWalk.pages, bytesConsumed: svcWalk.bytes,
        exhausted: svcWalk.exhausted, consumerNote: 'walked through DataPlaneService',
      })
      out.scenarios.S8_production_service = {
        what: 'the same four counts through the SERVICE the profile mounts, over the real storage domain',
        acquiredBytes: svcCapture.io.sourceBytesRead,
        persistedBytes: svcCapture.descriptor.captured.bytes,
        consumedBytes: svcWalk.bytes,
        modelVisibleBytes: utf8Bytes(svcProjection),
        referenceState: svcCapture.reference.state,
        grantRevision: svc.grantRevision,
        pagesWalked: svcWalk.pages,
        artifactBytesRead: svcIo.artifactBytesRead,
        sourceBytesReadDuringPaging: svcIo.sourceBytesRead,
        serviceKind: svc.constructor.name,
        serviceSurface: ['capture', 'page', 'walk', 'lineIndex', 'readLine', 'readRange', 'resolve', 'reconcile']
          .filter(method => typeof svc[method] === 'function'),
      }
    } finally {
      await svc.close()
      await svcCtx.fiber.dispose().catch(() => undefined)
    }
  } catch (error) {
    out.scenarios.S8_production_service = { error: `${error?.constructor?.name}: ${String(error?.message).slice(0, 400)}` }
    out.notes.push('S8 (production service) could not run; S1-S7 are unaffected')
  }

  // ======================================================================
  // SUPPLEMENTARY (NOT one of the four): the durable RECORD's own size, which
  // is what the reference log / Session reference stores about this
  // observation. Reported so "what the transcript stores" is not silently
  // folded into one of the four counts.
  // ======================================================================
  const descriptorJson = JSON.stringify(s1Capture.descriptor)
  out.supplementary = {
    note: 'NOT one of the four byte classes; recorded so the durable record is not conflated with them',
    observationDescriptorBytes: utf8Bytes(descriptorJson),
    observationDescriptorSha256: sha256(Buffer.from(descriptorJson, 'utf8')),
    transcriptBoundary: 'the Session transcript byte count is the history plane\'s '
      + '(history-plane.ts canonicalEventBytes); READ IN SOURCE, NOT MEASURED here',
  }
} catch (error) {
  out.error = `${error?.constructor?.name}: ${String(error?.message).slice(0, 600)}`
} finally {
  consumer?.kill()
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) } catch { /* best effort */ }
  }
}

out.finishedAt = new Date().toISOString()
out.probeScriptSha256 = sha256(readFileSync(new URL(import.meta.url)))

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'four-byte-classes.json'), `${JSON.stringify(out, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
