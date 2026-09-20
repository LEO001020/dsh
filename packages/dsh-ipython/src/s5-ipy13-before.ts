/**
 * IPY-13 BEFORE reproduction — run against the REAL broker, the REAL ipykernel,
 * through the REAL `KernelHost`, in THIS worktree.
 *
 * WHY A PROBE AND NOT ONLY A TEST. The brief requires the OLD reproduction
 * archived BEFORE the behaviour changes, so the before/after pair is on disk. A
 * vitest file asserts; this records the raw frames and the exact result objects
 * so a later reader can compare numbers rather than trust a tick.
 *
 * WHAT IT MEASURES. The oracle's own stimulus: "A background thread writes to
 * stdout after the cell has returned; then start another cell while the thread
 * is still writing."
 *
 *   cell A  starts a thread that sleeps, then prints, and returns immediately
 *   cell B  runs while that thread is still writing
 *
 * The straddling write is the case IPY-13 is about. `requirements.test.ts`
 * requirement 9 and `v3-spec-gates.test.ts` CLAUSE 2 already record it; this
 * probe re-measures it in THIS worktree so the BEFORE artifact belongs to the
 * tree the fix is committed in.
 *
 * Run:
 *   node --experimental-strip-types src/s5-ipy13-before.ts
 * or through vitest's runner when the strip flag is unavailable.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelHost } from './kernel.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const OUT = process.env['S5_BEFORE_OUT'] ?? resolve(HERE, '..', '..', '..', 'qualification', 'results', 'S5-ipy13', 'before.json')

interface LateEntry { cellId: string, text: string, epoch: number }

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Subprocess)
  const root = await mkdtemp(join(tmpdir(), 's5-ipy13-before-'))

  const late: LateEntry[] = []
  const host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: 's5-ipy13-before', executionWorld: 'local', environmentDigest: 'before-env' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
    onLateOutput: entry => { late.push({ cellId: entry.cellId, text: entry.text, epoch: entry.epoch }) },
  })

  const observed: Record<string, unknown> = {}
  try {
    await host.start()

    // ---- ARM 1: the post-return write, with NO later cell -------------------
    // The decidable half. This is expected to be classified late already.
    const arm1 = await host.execute([
      'import threading, time',
      'def background():',
      '    time.sleep(0.7)',
      '    print("S5-BEFORE-POSTRETURN")',
      'threading.Thread(target=background, daemon=True).start()',
      'print("arm1-settled")',
    ].join('\n'))
    observed['arm1_outcome'] = arm1.outcome
    observed['arm1_stdout'] = arm1.stdout.text
    await new Promise(r => setTimeout(r, 2500))
    const lateAfterArm1 = [...late]
    observed['arm1_late'] = lateAfterArm1
    observed['arm1_lateText'] = lateAfterArm1.map(e => e.text).join('')

    // ---- ARM 2: the straddling write — THE DEFECT ---------------------------
    // Cell A returns; cell B runs while A's thread is still writing.
    late.length = 0
    const arm2a = await host.execute([
      'import threading, time',
      'def straddler():',
      '    time.sleep(1.2)',
      '    print("S5-BEFORE-STRADDLER")',
      'threading.Thread(target=straddler, daemon=True).start()',
      'print("arm2-cellA-settled")',
    ].join('\n'))
    observed['arm2_cellA_outcome'] = arm2a.outcome
    observed['arm2_cellA_stdout'] = arm2a.stdout.text

    // Cell B runs long enough for the straddling write to land inside it.
    const arm2b = await host.execute([
      'import time',
      'for i in range(5):',
      '    print("arm2-tick", i, flush=True)',
      '    time.sleep(0.4)',
      'print("arm2-cellB-settled")',
    ].join('\n'))
    observed['arm2_cellB_outcome'] = arm2b.outcome
    observed['arm2_cellB_stdout'] = arm2b.stdout.text
    observed['arm2_cellB_contains_straddler'] = arm2b.stdout.text.includes('S5-BEFORE-STRADDLER')
    await new Promise(r => setTimeout(r, 800))
    const lateAfterArm2 = [...late]
    observed['arm2_late'] = lateAfterArm2
    observed['arm2_lateText'] = lateAfterArm2.map(e => e.text).join('')

    // ---- ARM 3: control — ordinary in-cell output still works ---------------
    const arm3 = await host.execute('print("S5-BEFORE-CONTROL")')
    observed['arm3_outcome'] = arm3.outcome
    observed['arm3_stdout'] = arm3.stdout.text

    // ---- ARM 4: the metadata carrier — is it even reachable? ---------------
    // Measured separately by `s5-ipy13-probe.py`; recorded here as a pointer.
    observed['metadata_probe'] = 'see qualification/results/S5-ipy13/mechanism-probe.json'

    observed['verdict'] = arm2b.stdout.text.includes('S5-BEFORE-STRADDLER')
      ? 'DEFECT_REPRODUCED: the straddling write is folded into the LATER cell stdout and is NOT reported as late'
      : 'defect not reproduced by this arm'
  } finally {
    await host.shutdown().catch(() => undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }

  const text = JSON.stringify(observed, null, 2)
  await writeFile(OUT, text, 'utf8')
  process.stdout.write(text + '\n')
}

await main()
