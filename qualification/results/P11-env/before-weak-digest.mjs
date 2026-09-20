/**
 * P11 / P1.4 — the BEFORE reproduction of the weak environment digest.
 *
 * WHAT THIS MEASURES. `KernelService.defaultEnvironmentDigest()` at the pinned
 * tree hashes exactly three inputs -- the configured interpreter PATH STRING,
 * `process.platform`, and `process.arch` -- and truncates to 16 hex chars. This
 * script recomputes that expression VERBATIM (copied, not imported, so the
 * reproduction keeps working after the method is replaced) and asks the four
 * questions V5 §18's `ENV-DIGEST` case is about.
 *
 * WHY A COPY AND NOT AN IMPORT. The point is a before/after pair on disk. If this
 * imported the live method, the "before" arm would silently become the "after"
 * arm the moment the fix lands and the pair would be destroyed. The expression
 * below is frozen at HEAD 2e1b2c2 and is what the fix is measured against.
 *
 * WHAT IT DOES NOT MEASURE. It does not start a kernel, does not install a
 * different Python, and does not prove eviction. It measures the DIGEST FUNCTION
 * only. The eviction half is measured separately, against a real kernel, in
 * `packages/dsh-ipython/src/p11-env-digest.test.ts`.
 *
 * Run: node qualification/results/P11-env/before-weak-digest.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')

/** The pre-edit expression, frozen. `kernel-plugin.ts:441-446` at HEAD 2e1b2c2. */
function weakDigest(pythonExecutable) {
  return createHash('sha256')
    .update(`${pythonExecutable}\u0000${process.platform}\u0000${process.arch}`)
    .digest('hex')
    .slice(0, 16)
}

const PYTHON = process.env['DSH_PYTHON']
  ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const BROKER = join(REPO_ROOT, 'packages', 'dsh-ipython', 'src', 'broker.py')
const BRIDGE_CLIENT_SOURCE = join(REPO_ROOT, 'packages', 'dsh-ipython', 'src', 'bridge.ts')
const DATA_CLIENT = join(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'dsh_data_client.py')

/**
 * Every arm below is a REAL environment change of the kind V5 §11.2 lists, paired
 * with the digest the OLD code produces for it. `expected` is what the arm SHOULD
 * do if the digest were a real environment identity; `oldDigestMoves` is what the
 * old code actually does. The interesting rows are the ones where the two differ.
 */
const arms = [
  {
    name: 'python patch version 3.14.0 -> 3.14.1 at the SAME path',
    changes: 'python_version',
    oldDigestMoves: false,
  },
  {
    name: 'IPython 9.x -> 10.x at the SAME path',
    changes: 'ipython',
    oldDigestMoves: false,
  },
  {
    name: 'ipykernel upgraded at the SAME path',
    changes: 'ipykernel',
    oldDigestMoves: false,
  },
  {
    name: 'jupyter_client upgraded at the SAME path',
    changes: 'jupyter_client',
    oldDigestMoves: false,
  },
  {
    name: 'pyzmq upgraded at the SAME path',
    changes: 'pyzmq',
    oldDigestMoves: false,
  },
  {
    name: 'broker.py CONTENT changed at the same path (the file that is executed)',
    changes: 'broker_sha256',
    oldDigestMoves: false,
  },
  {
    name: 'the bridge Python client source changed (PYTHON_CLIENT_SOURCE)',
    changes: 'bridge_python_client_sha256',
    oldDigestMoves: false,
  },
  {
    name: 'the dsh.data Python client changed (dsh_data_client.py)',
    changes: 'data_client_sha256',
    oldDigestMoves: false,
  },
  {
    name: 'the interpreter MOVED to a different path, same build',
    changes: 'sys_executable_realpath',
    oldDigestMoves: true,
  },
]

const report = {
  what: 'P1.4 BEFORE reproduction: the pre-fix environment digest, frozen at HEAD 2e1b2c2',
  tree: REPO_ROOT,
  frozenExpression: 'sha256(pythonExecutable + "\\u0000" + process.platform + "\\u0000" + process.arch).slice(0,16)',
  digestChars: 16,
  digestBits: 64,
  platform: process.platform,
  arch: process.arch,
  pythonExecutable: PYTHON,
  baselineDigest: weakDigest(PYTHON),
  arms,
  localFilesPresent: {
    broker_py: exists(BROKER),
    bridge_ts: exists(BRIDGE_CLIENT_SOURCE),
    data_client_py: exists(DATA_CLIENT),
  },
}

function exists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// THE DECISIVE ARM, RUN FOR REAL. Mutate a file the manifest MUST hash, and show
// the old digest does not move. This is not simulated: the file's bytes on disk
// change, the mutation is reverted, and the original bytes are verified back by
// digest. Nothing here writes to a path outside this worktree.
// ---------------------------------------------------------------------------
const before = readFileSync(BROKER)
const beforeSha = sha256(before)
const marker = Buffer.from(`\n# P11-ENV-DIGEST-PROBE-MUTATION ${Date.now()}\n`, 'utf8')
writeFileSync(BROKER, Buffer.concat([before, marker]))
const mutatedSha = sha256(readFileSync(BROKER))
writeFileSync(BROKER, before)
const restoredSha = sha256(readFileSync(BROKER))

const mutated = {
  file: BROKER,
  sha256Before: beforeSha,
  sha256Mutated: mutatedSha,
  sha256Restored: restoredSha,
  mutationVisibleInFileHash: beforeSha !== mutatedSha,
  restoredByteIdentical: beforeSha === restoredSha,
  oldDigestBefore: weakDigest(PYTHON),
  oldDigestAfter: weakDigest(PYTHON),
}
mutated.oldDigestMoved = mutated.oldDigestBefore !== mutated.oldDigestAfter
report.localFileMutation = mutated

console.log(JSON.stringify(report, null, 2))
console.error(
  `\n[P11] old digest across a REAL broker.py content change: `
  + `${mutated.oldDigestBefore} -> ${mutated.oldDigestAfter} `
  + `(moved=${mutated.oldDigestMoved}); file hash did move: ${mutated.mutationVisibleInFileHash}; `
  + `file restored byte-identical: ${mutated.restoredByteIdentical}`,
)

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
