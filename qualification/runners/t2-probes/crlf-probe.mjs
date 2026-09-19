/**
 * T2 measurement: fs-local's line-ending contract, `write` vs `edit`.
 *
 * WHY THIS EXISTS. `durability-advanced.test.ts > T9-C > FS-05` asserted that
 * `writeText` "normalizes content to the file's own style". That assertion failed
 * against the real backend, and the honest question was whether the BACKEND or the
 * EXPECTATION was wrong. Reading `src/index.ts` suggested the two operations have
 * different contracts, but a reading is not a measurement -- so this probe drives
 * the real `LocalFileSystem` and reports the bytes on disk.
 *
 * WHAT IT ESTABLISHES
 *   - `editText` preserves the target's line-ending style (restores what it read).
 *   - `writeText` writes the content it was given, in BOTH directions: LF content
 *     lands as LF, CRLF content lands as CRLF. It does not restore a style.
 *   - `after` (the diff basis) is LF-normalized even when the bytes on disk are
 *     CRLF, which is why a caller must not read `after` as the on-disk content.
 *
 * RUN IT FROM ANYWHERE. The imports are ABSOLUTE paths into the pinned checkout,
 * because ESM resolves bare specifiers relative to the IMPORTING FILE's location,
 * not the process cwd -- so `@deepseek-ai/cordis` does not resolve from this
 * directory even when cwd is the package root.
 *   node D:/DSH/work/dsh-native-daily/qualification/runners/t2-probes/crlf-probe.mjs
 *
 * MEASURED OUTPUT is recorded in ../results/T2-fs/FINDINGS.md.
 */
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import { LocalFileSystem } from 'file:///D:/DSH/src/dsh-src/packages/fs/fs-local/lib/index.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 't2-crlf-'))
const ctx = new Context()
const fs = new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
const hex = s => Buffer.from(s, 'utf8').toString('hex')

const results = {}

// --- A: writeText with LF content onto an existing CRLF file ---
{
  const p = join(root, 'a.txt')
  writeFileSync(p, Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8'))
  const t = await fs.resolve('a.txt')
  const out = await fs.writeText(t, 'x\ny\nz\n')
  results.writeLfOntoCrlf = {
    afterReported: out.after,
    afterReportedHex: hex(out.after),
    onDisk: readFileSync(p, 'utf8'),
    onDiskHex: hex(readFileSync(p, 'utf8')),
    operation: out.operation,
  }
}

// --- B: writeText with CRLF content onto an existing CRLF file ---
{
  const p = join(root, 'b.txt')
  writeFileSync(p, Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8'))
  const t = await fs.resolve('b.txt')
  const out = await fs.writeText(t, 'x\r\ny\r\nz\r\n')
  results.writeCrlfOntoCrlf = {
    afterReported: out.after,
    afterReportedHex: hex(out.after),
    onDisk: readFileSync(p, 'utf8'),
    onDiskHex: hex(readFileSync(p, 'utf8')),
  }
}

// --- C: writeText onto a NEW file (no prior style to preserve) with CRLF ---
{
  const t = await fs.resolve('c.txt')
  const out = await fs.writeText(t, 'p\r\nq\r\n')
  results.writeCrlfOntoNew = {
    afterReported: out.after,
    onDisk: readFileSync(join(root, 'c.txt'), 'utf8'),
    onDiskHex: hex(readFileSync(join(root, 'c.txt'), 'utf8')),
    operation: out.operation,
  }
}

// --- D: editText on a CRLF file (the property FS-05 asserts) ---
{
  const p = join(root, 'd.txt')
  writeFileSync(p, Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8'))
  const t = await fs.resolve('d.txt')
  const out = await fs.editText(t, { oldString: 'two', newString: 'TWO', replaceAll: false })
  results.editOnCrlf = {
    beforeReported: out.before,
    afterReported: out.after,
    onDisk: readFileSync(p, 'utf8'),
    onDiskHex: hex(readFileSync(p, 'utf8')),
  }
}

// --- E: is `after` an honest account of the bytes? (the diff-basis question) ---
{
  const p = join(root, 'e.txt')
  writeFileSync(p, Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8'))
  const t = await fs.resolve('e.txt')
  const out = await fs.writeText(t, 'x\ny\nz\n')
  results.honestyCheck = {
    beforeReportedHex: hex(out.before ?? ''),
    afterReportedHex: hex(out.after),
    diskHex: hex(readFileSync(p, 'utf8')),
    afterMatchesDisk: out.after === readFileSync(p, 'utf8'),
  }
}

console.log(JSON.stringify(results, null, 2))
await ctx.fiber.dispose()
rmSync(root, { recursive: true, force: true })
