/**
 * R2-F4 probe: does the PUBLIC `ctx.attachments` capability satisfy what
 * `artifacts.ts` needs, and can the provider be mounted WITHOUT any private
 * `src/*` import?
 *
 * WHAT THIS ANSWERS, and why each question is asked:
 *   1. Does mounting the shipped provider through its PUBLIC package entry work
 *      in a bare Context with no raster op? The provider lazily requires sharp
 *      for images only; if mounting pulled sharp in, a headless deployment
 *      would fail.
 *   2. Does `saveFileStream` compute the digest WHILE streaming (content
 *      addressing), dedup identical bytes, and publish read-only?
 *   3. Does `readFileStream` verify byte count + digest, refusing a tampered
 *      object rather than serving it?
 *   4. Does `fileHostPath` return a real path for a host-backed provider, so the
 *      capability-detected paging fast path is available here?
 *   5. Does the provider resolve to its BUILT entry (lib/index.js)?
 *
 * Run from packages/dsh-daily-work: node ../../.probe/r2f4/provider-seam-probe.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'r2f4-seam-'))
const out = { home, steps: [], errors: [] }
const step = (name, value) => { out.steps.push({ name, value }); console.log(name, '=', JSON.stringify(value)) }

try {
  step('providerEntryResolvesTo', import.meta.resolve('@deepseek-ai/dsh-attachment-local'))

  const ctx = new Context()
  await ctx.plugin(AttachmentLocal, { dshHome: home })
  const service = ctx.attachments
  step('serviceMounted', service !== undefined && service !== null)
  step('serviceKind', service?.constructor?.name ?? null)
  step('sharpLoadedEagerly', process.moduleLoadList.some(m => m.toLowerCase().includes('sharp')))
  step('imageLimitsPresent', service?.imageLimits !== undefined)
  step('providerOwnRoot', service?.root ?? null)

  // (2) streamed publish: digest while streaming, dedup, mode.
  const payload = Buffer.from('R2F4-SEAM-PAYLOAD-'.repeat(4000)) // ~72 KiB, multi-chunk
  const expected = createHash('sha256').update(payload).digest('hex')
  async function* body() {
    for (let offset = 0; offset < payload.length; offset += 8192) yield payload.subarray(offset, offset + 8192)
  }
  const ref = await service.saveFileStream({ data: body(), name: 'artifact' })
  step('savedRef', { attachmentId: String(ref.attachmentId), name: ref.name, bytes: ref.bytes })
  step('digestMatchesContent', String(ref.attachmentId) === `sha256:${expected}`)
  step('byteCountMatches', ref.bytes === payload.length)

  const hostPath = service.fileHostPath(ref)
  step('fileHostPath', hostPath ?? null)
  step('hostPathExists', hostPath !== undefined && statSync(hostPath).size === payload.length)
  step('hostPathMode', hostPath === undefined ? null : (statSync(hostPath).mode & 0o777).toString(8))
  step('hostPathLeafNameIsRefName', hostPath === undefined ? null : hostPath.endsWith('artifact'))

  // dedup: identical bytes must land on the SAME object identity.
  async function* body2() { yield payload }
  const ref2 = await service.saveFileStream({ data: body2(), name: 'artifact' })
  step('dedupSameIdentity', String(ref2.attachmentId) === String(ref.attachmentId))
  step('dedupSameHostPath', service.fileHostPath(ref2) === hostPath)

  // (3) readFileStream verifies and yields the exact bytes.
  const chunks = []
  for await (const chunk of service.readFileStream(ref)) chunks.push(Buffer.from(chunk))
  step('readBackByteExact', Buffer.concat(chunks).equals(payload))

  // A WRONG byte count in the ref must be REFUSED, not silently served.
  const wrongBytes = { ...ref, bytes: ref.bytes - 1 }
  let wrongBytesOutcome = 'ACCEPTED (defect)'
  try {
    for await (const chunk of service.readFileStream(wrongBytes)) void chunk
  } catch (error) { wrongBytesOutcome = `${error.code ?? error.name}: ${error.message}` }
  step('wrongByteCountRefused', wrongBytesOutcome)

  // A TAMPERED object must be REFUSED by the digest check.
  if (hostPath !== undefined) {
    chmodSync(hostPath, 0o600)
    writeFileSync(hostPath, Buffer.alloc(payload.length, 0x5a))
    let tampered = 'ACCEPTED (defect)'
    try {
      for await (const chunk of service.readFileStream(ref)) void chunk
    } catch (error) { tampered = `${error.code ?? error.name}: ${error.message}` }
    step('tamperedObjectRefused', tampered)
  }

  // A missing object must be refused as NOT_FOUND, not as an empty read.
  let missing = 'ACCEPTED (defect)'
  try {
    for await (const chunk of service.readFileStream(
      { ...ref, attachmentId: `sha256:${'0'.repeat(64)}` },
    )) void chunk
  } catch (error) { missing = `${error.code ?? error.name}: ${error.message}` }
  step('missingObjectRefused', missing)

  step('providerPrototype', Object.getOwnPropertyNames(Object.getPrototypeOf(service)).sort())
  step('hasRemoveOrDelete', typeof service.remove === 'function' || typeof service.delete === 'function')
} catch (error) {
  out.errors.push(`${error.name}: ${error.message}`)
  console.error('PROBE ERROR', error)
}

writeFileSync(join(home, 'probe.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log('\n--- errors ---')
console.log(out.errors.length === 0 ? '(none)' : out.errors.join('\n'))
