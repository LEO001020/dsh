/**
 * IPY-13 — late output is classified separately and never rides another cell.
 *
 * THE ORACLE, verbatim from `qualification/specs/acceptance-spec.trusted-local-v2.definition.json`:
 *
 *   stimulus: "A background thread writes to stdout after the cell has returned;
 *              then start another cell while the thread is still writing."
 *   oracle:   "The post-return write is reported as late/unattributed and does
 *              not appear in any later cell's result. A write landing DURING a
 *              later cell is reported as undecidable rather than attributed. A
 *              claim that the originating cell's parent id is always preserved
 *              is NOT PASS, because it is false for a thread started with an
 *              empty context."
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `v3-spec-gates.test.ts`. That file's
 * CLAUSE 2 arm PINS THE DEFECT: it asserts `attributedToThird === true`, which
 * is the measured old behaviour, so it FAILS once this fix lands. The defect is
 * real and must stay in the record, but a gate that asserts a defect cannot also
 * be the gate for the fix. This file is the fix's gate; `v3-spec-gates.test.ts`
 * CLAUSE 2 is updated in the same commit to assert the oracle instead.
 *
 * WHAT IS MEASURED HERE, and the arm that must not regress:
 *
 *   A  the straddling write   -> late/undecidable, NOT in the later cell's stdout
 *   B  ordinary in-cell print -> in the cell (control)
 *   C  thread + join() IN ONE CELL -> STILL in the cell
 *      (This is the arm that a naive "the contextvar is unset, so it must be
 *      background" gate breaks. `bootstrap-probe.json` P2 measured that cost.
 *      A thread joined by its own cell is ordinary Python and its output is the
 *      cell's.)
 *   D  a raw `_thread.start_new_thread` writer -> undecidable, not attributed
 *   E  the bootstrap's own load is REPORTED, not assumed
 *
 * ONE KERNEL PER TEST, shut down in `afterEach`. CPU discipline: this file is
 * run alone (`node node_modules/vitest/vitest.mjs run src/s5-ipy13.test.ts`).
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost } from './kernel.ts'
import { DSH_BACKGROUND_ORIGIN } from './protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let host: KernelHost | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-s5-'))
})

afterEach(async () => {
  if (host !== undefined) {
    await host.shutdown().catch(() => undefined)
    host = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function makeHost(): KernelHost {
  host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: 's5-ipy13', executionWorld: 'local', environmentDigest: 's5-env' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
  })
  return host
}

describe('IPY-13: late output is classified separately and never rides another cell', () => {
  it('the sentinel is the SAME string in broker.py and protocol.ts', async () => {
    // The sentinel is defined in BOTH languages: broker.py stamps frames with it
    // and protocol.ts is what a caller tests against. Two copies of a string that
    // must agree is exactly the drift this project keeps recording, and the
    // failure would be silent -- a caller comparing against a stale value would
    // simply never match an undecidable frame. Reading the Python source and
    // comparing is cheap; the duplication matches the existing convention
    // (`MAX_FRAME_BYTES` is also defined in both), so the fix is a check rather
    // than a new build step.
    const source = await readFile(resolve(HERE, 'broker.py'), 'utf8')
    const match = /^DSH_BACKGROUND_ORIGIN\s*=\s*"([^"]+)"/m.exec(source)
    expect(match, 'broker.py no longer defines DSH_BACKGROUND_ORIGIN').not.toBeNull()
    expect(match?.[1]).toBe(DSH_BACKGROUND_ORIGIN)
  })

  it('the straddling write is undecidable, and ordinary in-cell output still works', async () => {
    const h = makeHost()
    const started = await h.start()

    // THE FIX IS REPORTED, NOT ASSUMED. `attributionBootstrapLoaded: false` means
    // the kernel-side bootstrap did not load, i.e. the defect is live. Without
    // this assertion a silently-failed injection would show up as a mysterious
    // attribution failure much later.
    expect(started.attributionBootstrapLoaded).toBe(true)

    // ---- ARM A: THE ORACLE'S STIMULUS -------------------------------------
    // Cell A starts a daemon thread that writes after A returns. Cell B then
    // runs WHILE that thread is still writing -- the straddling case.
    const cellA = await h.execute([
      'import threading, time',
      'def straddler():',
      '    time.sleep(1.2)',
      '    print("IPY13-STRADDLER-WRITE")',
      'threading.Thread(target=straddler, daemon=True).start()',
      'print("cellA-settled")',
    ].join('\n'))
    expect(cellA.outcome).toBe('ok')
    // Not in the cell that STARTED it either: the cell was protocol-complete
    // before the write happened.
    expect(cellA.stdout.text).toContain('cellA-settled')
    expect(cellA.stdout.text).not.toContain('IPY13-STRADDLER-WRITE')

    const cellB = await h.execute([
      'import time',
      'for i in range(5):',
      '    print("tick", i, flush=True)',
      '    time.sleep(0.4)',
      'print("cellB-settled")',
    ].join('\n'))
    expect(cellB.outcome).toBe('ok')

    await sleep(600)
    const late = h.drainLateOutput()
    const lateText = late.map(entry => entry.text).join('')

    console.log('[S5-MEASURED] IPY-13 ' + JSON.stringify({
      bootstrapLoaded: started.attributionBootstrapLoaded,
      straddlerInCellB: cellB.stdout.text.includes('IPY13-STRADDLER-WRITE'),
      straddlerInCellA: cellA.stdout.text.includes('IPY13-STRADDLER-WRITE'),
      lateCount: late.length,
      lateText: lateText.trim(),
      lateCellIds: late.map(entry => entry.cellId),
      cellBStdout: cellB.stdout.text.trim(),
    }))

    // THE ORACLE: "A write landing DURING a later cell is reported as
    // undecidable rather than attributed."
    expect(cellB.stdout.text).not.toContain('IPY13-STRADDLER-WRITE')
    expect(lateText).toContain('IPY13-STRADDLER-WRITE')
    // And the ordinary output of cell B is intact and complete: the fix must not
    // buy correctness by dropping the cell's own frames.
    expect(cellB.stdout.text).toContain('cellB-settled')
    for (let i = 0; i < 5; i++) expect(cellB.stdout.text).toContain(`tick ${i}`)

    // ---- ARM C: THE REGRESSION THAT A NAIVE GATE WOULD CAUSE ---------------
    // A thread joined by its own cell. Its output IS that cell's: the cell is
    // still running and blocked on it. Gating on "ipykernel's contextvar is
    // unset" alone would move this out of the cell and lose it.
    const joined = await h.execute([
      'import threading',
      'def worker():',
      '    print("IPY13-JOINED-WORKER")',
      't = threading.Thread(target=worker)',
      't.start(); t.join()',
      'print("joined-cell-settled")',
    ].join('\n'))
    expect(joined.outcome).toBe('ok')
    expect(joined.stdout.text).toContain('IPY13-JOINED-WORKER')
    expect(joined.stdout.text).toContain('joined-cell-settled')

    // ---- ARM E: A DESCENDANT THREAD'S ORIGIN IS STILL THE CELL'S -----------
    // A thread started BY a cell-started thread descends from the cell just as
    // surely as a direct child does, and its origin is knowable. Without the
    // grandchild case in the bootstrap it would be reported undecidable when it
    // can be attributed exactly. This arm was added after the traps probe
    // (`qualification/results/S5-ipy13/s5-ipy13-traps-probe.json` T11) measured
    // that gap.
    const grandchild = await h.execute([
      'import threading, time',
      'def inner():',
      '    time.sleep(0.3)',
      '    print("IPY13-GRANDCHILD-WRITE")',
      'def outer():',
      '    t = threading.Thread(target=inner)',
      '    t.start()',
      '    t.join()',
      't = threading.Thread(target=outer)',
      't.start()',
      't.join()',
      'print("grandchild-cell-settled")',
    ].join('\n'))
    expect(grandchild.outcome).toBe('ok')
    // Joined by its own cell, so it is that cell's output -- and it must NOT be
    // sentinel-stamped just because it is one level deeper.
    expect(grandchild.stdout.text).toContain('IPY13-GRANDCHILD-WRITE')
    expect(grandchild.stdout.text).toContain('grandchild-cell-settled')

    // ---- ARM B: ORDINARY IN-CELL OUTPUT STILL WORKS (control) --------------
    const plain = await h.execute('print("IPY13-PLAIN-CONTROL")')
    expect(plain.outcome).toBe('ok')
    expect(plain.stdout.text).toContain('IPY13-PLAIN-CONTROL')

    // ---- ARM D: NO ORIGIN AT ALL -> undecidable, never attributed ----------
    // `_thread.start_new_thread` is unreachable by any thread-start hook and has
    // an empty context, so its origin genuinely cannot be established. The
    // oracle's warning applies here: no claim of preserved origin is made.
    const raw = await h.execute([
      'import _thread, time',
      'def raw_writer():',
      '    time.sleep(0.4)',
      '    print("IPY13-RAW-THREAD-WRITE")',
      '_thread.start_new_thread(raw_writer, ())',
      'time.sleep(1.2)',
      'print("raw-cell-settled")',
    ].join('\n'))
    expect(raw.outcome).toBe('ok')
    // It lands while THIS cell is still running, and it still must not be
    // attributed to it: the origin is unknown, so it is undecidable.
    expect(raw.stdout.text).not.toContain('IPY13-RAW-THREAD-WRITE')
    expect(raw.stdout.text).toContain('raw-cell-settled')

    await sleep(400)
    const lateAll = h.drainLateOutput()
    const lateAllText = lateAll.map(entry => entry.text).join('')
    expect(lateAllText).toContain('IPY13-RAW-THREAD-WRITE')
    // The sentinel is a NAMED undecidable origin, not an empty or borrowed one.
    const rawEntry = lateAll.find(entry => entry.text.includes('IPY13-RAW-THREAD-WRITE'))
    expect(rawEntry?.cellId).toBe(DSH_BACKGROUND_ORIGIN)

    // ---- ARM F: THE BOOTSTRAP SURVIVES A RESTART, AND IS RE-REPORTED --------
    // `KernelManager.restart_kernel` re-runs with the saved `_launch_args`, so
    // the bootstrap SHOULD be re-injected. "Should" is not evidence, and a
    // restart that quietly lost it would restore the defect for the rest of the
    // Session's life -- so it is measured here.
    const restarted = await h.restart()
    expect(restarted.attributionBootstrapLoaded).toBe(true)

    const afterRestartA = await h.execute([
      'import threading, time',
      'def straddler2():',
      '    time.sleep(1.2)',
      '    print("IPY13-POST-RESTART-STRADDLER")',
      'threading.Thread(target=straddler2, daemon=True).start()',
      'print("post-restart-cellA-settled")',
    ].join('\n'))
    expect(afterRestartA.outcome).toBe('ok')

    const afterRestartB = await h.execute([
      'import time',
      'for i in range(4):',
      '    print("post-restart-tick", i, flush=True)',
      '    time.sleep(0.4)',
      'print("post-restart-cellB-settled")',
    ].join('\n'))
    expect(afterRestartB.outcome).toBe('ok')
    expect(afterRestartB.stdout.text).not.toContain('IPY13-POST-RESTART-STRADDLER')
    expect(afterRestartB.stdout.text).toContain('post-restart-cellB-settled')

    await sleep(400)
    const lateAfterRestart = h.drainLateOutput().map(entry => entry.text).join('')
    expect(lateAfterRestart).toContain('IPY13-POST-RESTART-STRADDLER')

    await h.shutdown()
    host = undefined
  }, 300_000)
})
