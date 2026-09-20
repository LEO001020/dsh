/**
 * C3 probe 3: the past-EOF range hole, measured through the PRODUCT path.
 *
 * WHY THIS ARM AND NOT ONLY `captureFile`. `captureFile` is the primitive; the
 * RANGE that actually bounds the read is assembled in `DataPlane.fsCapture`
 * (`data-plane.ts:510-535`), which installs a `readChunks` override reading
 * exactly `[offset, offset+length)`. So a hole in the coverage claim is only a
 * PRODUCT hole if the product path reaches it -- and the product path is where
 * `requestedRange` is read from a caller.
 *
 * The candidate, stated as the oracle states it. DATA-09: "A loss at one of those
 * four stages that is not recorded as a gap is NOT PASS." `observations.ts`
 * defines `partial` as "bytes inside the requested range are known to be absent".
 * A caller that asks for 1000 bytes at offset 0 of a 400-byte file has named a
 * range in which 600 bytes are absent. If the record says
 * `complete-within-request` with an EMPTY gap list, the loss is unrecorded.
 *
 * Run: node qualification/results/C3-dataplane/c3-product-range-probe.mjs --label before
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..').replace(/\\/g, '/')
const PKG = `${REPO}/packages/dsh-daily-work`

const labelIndex = process.argv.indexOf('--label')
const label = labelIndex === -1 ? 'after' : process.argv[labelIndex + 1]

const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
const { default: AttachmentLocal } = await import(resolveFromPkg('@deepseek-ai/dsh-attachment-local'))
const { default: Storage } = await import(resolveFromPkg('@deepseek-ai/dsh-storage'))
const storageJson = await import(resolveFromPkg('@deepseek-ai/dsh-storage-json'))
const storageDomain = await import(resolveFromPkg('@deepseek-ai/dsh-storage-domain'))

const { DataPlaneService } = await import(pathToFileURL(`${PKG}/lib/data-service.js`).href)
const { dataCallerFromEnclosing } = await import(pathToFileURL(`${PKG}/lib/data-bridge.js`).href)
const observations = await import(pathToFileURL(`${PKG}/lib/observations.js`).href)

const fileDigest = path => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}

const out = {
  probe: 'c3-product-range',
  label,
  measuredAt: new Date().toISOString(),
  identity: {
    srcDataPlaneTs: fileDigest(`${PKG}/src/data-plane.ts`),
    srcArtifactsTs: fileDigest(`${PKG}/src/artifacts.ts`),
    libDataPlaneJs: fileDigest(`${PKG}/lib/data-plane.js`),
    libArtifactsJs: fileDigest(`${PKG}/lib/artifacts.js`),
  },
  arms: {},
}

const tempDirs = []
const tempRoot = name => {
  const dir = mkdtempSync(join(tmpdir(), `c3prod-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** Mount the REAL service the composed profile mounts, over real directories. */
async function mountService(name) {
  const root = tempRoot(name)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: join(root, 'store') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(AttachmentLocal, { dshHome: join(root, 'home') })
  ctx.provide('dshHomePath', (...segments) => join(root, ...segments))
  await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const service = new DataPlaneService(ctx, {
    artifactRoot: join(root, 'artifacts'),
    ownerScope: 'project:c3prod',
    executionWorld: 'local',
    pageBytes: 64 * 1024,
  })
  await service.open(ctx.storageDomain)
  return {
    service,
    plane: service.plane(),
    root,
    dispose: async () => { await service.close(); await ctx.fiber.dispose() },
  }
}

/** Drive one product range capture and report the record's OWN claims. */
async function productRangeArm(name, fileBytes, requestedRange) {
  const { plane, root, dispose } = await mountService(name)
  try {
    writeFileSync(join(root, 'p.bin'), Buffer.alloc(fileBytes, 0x41))
    const caller = dataCallerFromEnclosing({ sessionId: 'session-c3', cwd: root })
    const captured = await plane.fsCapture(caller, {
      path: 'p.bin',
      observationId: `obs-${name}`,
      requestedRange,
    })
    return {
      fileBytes,
      requestedRange,
      requestedBytes: requestedRange.length,
      publishedBytes: captured.descriptor.captured.bytes,
      completeness: captured.descriptor.acquisition.completeness,
      coverageVerdict: observations.coverageVerdictOf(captured.descriptor),
      gaps: captured.gaps.map(gap => ({ stage: gap.stage, recovery: gap.recovery, reason: gap.reason })),
      bytesAbsentInsideRequestedRange: Math.max(0, requestedRange.length - captured.descriptor.captured.bytes),
      deliverableAsComplete: observations.isDeliverableAsComplete(captured.descriptor),
    }
  } finally {
    await dispose()
  }
}

try {
  // CONTROL: a range wholly inside the file. Nothing is absent, so
  // `complete-within-request` with NO gap is the CORRECT answer -- without this
  // arm a change that filed a gap on every range request would look right.
  out.arms.control_rangeInsideFile = await productRangeArm('inside', 4096, { offset: 0, length: 1024 })

  // THE ARM: the requested range extends past EOF. 600 of the 1000 requested
  // bytes do not exist.
  out.arms.rangePastEof = await productRangeArm('past-eof', 400, { offset: 0, length: 1000 })

  // The extreme: the range starts past EOF, so the whole request is absent.
  out.arms.rangeStartsPastEof = await productRangeArm('start-past-eof', 400, { offset: 1000, length: 512 })
} catch (error) {
  out.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
}

for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) } catch { /* best effort */ }
}

const unrecorded = arm =>
  (arm?.bytesAbsentInsideRequestedRange ?? 0) > 0
  && (arm?.gaps ?? []).length === 0
  && arm?.completeness === 'complete-within-request'

out.finding = {
  controlInsideRangeHasNoGap: (out.arms.control_rangeInsideFile?.gaps ?? []).length === 0,
  rangePastEofIsAnUnrecordedLoss: unrecorded(out.arms.rangePastEof),
  rangeStartsPastEofIsAnUnrecordedLoss: unrecorded(out.arms.rangeStartsPastEof),
}

writeFileSync(join(HERE, `product-range-${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(out.arms, null, 1))
console.log(JSON.stringify(out.finding, null, 1))
