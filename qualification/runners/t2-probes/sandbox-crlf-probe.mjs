/**
 * T2 measurement: does the SANDBOX backend differ from the LOCAL one on line
 * endings? This is the control that decides whether the FS-05 CRLF failure was
 * caused by the fs-provider swap or predates it.
 *
 * WHY THIS EXISTS. FS-05 failed after the swap. The cheap explanation -- "the
 * local backend normalizes differently" -- is only true if the two backends
 * actually differ, and `SandboxedFileSystem extends LocalFileSystem` suggests they
 * do not. This probe runs the SAME operations against BOTH classes and reports
 * whether the resulting bytes are identical, so the answer is a comparison rather
 * than an argument from inheritance.
 *
 * MEASURED RESULT: `writeTextOnDiskIdentical: true`, `editOnDiskIdentical: true`.
 * The sandbox backend has no line-ending code of its own, so the CRLF failure was
 * PRE-EXISTING and is a wrong test expectation, not a regression from the swap.
 *
 * THE SANDBOX CLASS IS IMPORTED BY ABSOLUTE PATH because `dsh-fs-sandbox` is not
 * a dependency of `dsh-daily-work` and so is not linked into its `node_modules`.
 * The path is the pinned checkout the launcher itself resolves.
 *
 * RUN IT FROM ANYWHERE. Every import is an ABSOLUTE path into the pinned
 * checkout, because ESM resolves bare specifiers relative to the IMPORTING FILE's
 * location rather than the process cwd -- a bare `@deepseek-ai/...` here would not
 * resolve even with cwd set to the package root.
 *   node D:/DSH/work/dsh-native-daily/qualification/runners/t2-probes/sandbox-crlf-probe.mjs
 */
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import { LocalFileSystem } from 'file:///D:/DSH/src/dsh-src/packages/fs/fs-local/lib/index.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The pinned checkout's built sandbox backend.
import { SandboxedFileSystem } from 'file:///D:/DSH/src/dsh-src/packages/fs/fs-sandbox/lib/index.js'

const hex = s => Buffer.from(s, 'utf8').toString('hex')
const results = {}

async function run(label, Ctor, needsPolicy) {
  const root = mkdtempSync(join(tmpdir(), `t2-${label}-`))
  const ctx = new Context()
  if (needsPolicy) {
    // `danger-full-access` deliberately: the fence is NOT the subject here, so it
    // must not be able to refuse the write and make the comparison vacuous.
    ctx.provide('sandboxPolicy', {
      defaultMode: 'danger-full-access',
      resolve: () => ({ mode: 'danger-full-access', writableRoots: [] }),
    })
  }
  const fs = new Ctor(ctx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const p = join(root, 'a.txt')
  writeFileSync(p, Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8'))
  const t = await fs.resolve('a.txt')
  const out = await fs.writeText(t, 'x\ny\nz\n')
  results[label] = {
    sandboxMode: fs.sandboxMode ?? null,
    afterReportedHex: hex(out.after),
    onDiskHex: hex(readFileSync(p, 'utf8')),
    onDisk: readFileSync(p, 'utf8'),
  }
  // and the edit path
  const p2 = join(root, 'b.txt')
  writeFileSync(p2, Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8'))
  const t2 = await fs.resolve('b.txt')
  const e = await fs.editText(t2, { oldString: 'two', newString: 'TWO', replaceAll: false })
  results[label].editOnDiskHex = hex(readFileSync(p2, 'utf8'))
  results[label].editAfterHex = hex(e.after)
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}

await run('local', LocalFileSystem, false)
await run('sandbox', SandboxedFileSystem, true)
results.delta = {
  writeTextOnDiskIdentical: results.local.onDiskHex === results.sandbox.onDiskHex,
  editOnDiskIdentical: results.local.editOnDiskHex === results.sandbox.editOnDiskHex,
}
console.log(JSON.stringify(results, null, 2))
