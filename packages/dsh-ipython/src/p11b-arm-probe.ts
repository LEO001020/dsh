/**
 * P11b INDEPENDENT ACCEPTANCE PROBE: does the NEW digest satisfy "arm 1 moves,
 * arm 2 must not"?
 *
 * WHY A SECOND PROBE EXISTS WHEN P11 SHIPPED `p11-env-digest.test.ts`. That file
 * is a strong gate for arm 1 (a real `broker.py` mutation moves the digest and
 * refuses a live kernel) and for the manifest being the digest's input. It does
 * NOT contain a single arm for the OTHER direction: `grep -c pythonw` and any
 * spelling variant over it return nothing. The acceptance property this slice is
 * judged on has TWO halves, and only one of them is covered.
 *
 * This probe measures BOTH halves through the REAL `KernelService.identityFor`,
 * exactly as root's G-SEAM-80 measurement did, so its numbers are comparable to
 * the BEFORE pair (`qualification/results/P11-env/env-digest-before.json` on the
 * integrate branch, and `before-weak-digest.json` here).
 *
 * IT DOES NOT RECOMPUTE THE HASH. A probe that re-implements the digest agrees
 * with the source by construction and can falsify nothing; this one calls the
 * product's own `environmentStatus()`, which is the status surface P11 added.
 *
 * NO KERNEL IS STARTED. `environmentStatus()` is documented not to start one, so
 * this is safe against the user's real interpreter and costs one probe per arm.
 *
 * CPU: ONE service, reconfigured between arms, one probe per distinct config.
 * Run: node --experimental-strip-types src/p11b-arm-probe.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelService, type KernelServiceConfig } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BROKER = resolve(HERE, 'broker.py')
const PYTHON_DIR = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314'
const PYTHON = process.env['DSH_PYTHON'] ?? `${PYTHON_DIR}/python.exe`
const PYTHON_W = `${PYTHON_DIR}/pythonw.exe`
const OUT_DIR = resolve(REPO_ROOT, 'qualification', 'results', 'P11b-env')

const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex')

const agent = { session: { header: { id: 'p11b-arm-probe', cwd: REPO_ROOT } } } as unknown as Agent

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Subprocess)

  const scratch = join(OUT_DIR, 'scratch')
  mkdirSync(scratch, { recursive: true })

  // ARM 1's instrument: a second broker with different bytes. Written by this
  // probe, into this probe's own directory -- NOT into another writer's path.
  const decoyBroker = join(scratch, 'decoy-broker.py')
  writeFileSync(decoyBroker, '# a DIFFERENT broker: different bytes, same identity?\nprint("decoy")\n', 'utf8')

  const base: KernelServiceConfig = { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(scratch, 'kernels') }
  const service = new KernelService(ctx, base)

  const digestFor = async (config: KernelServiceConfig): Promise<string> => {
    service.reconfigure(config)
    const status = await service.environmentStatus()
    return status.digest
  }

  // ARM 1 -- FALSE IDENTITY: the code that EXECUTES changed. Must MOVE.
  const baseDigest = await digestFor(base)
  const decoyDigest = await digestFor({ ...base, brokerScript: decoyBroker })

  // ARM 2 -- FALSE DISTINCTION: the environment is the same, spelled differently.
  // Must NOT move. Three spellings of ONE file: the DSH_PYTHON reachability path.
  const fwdDigest = await digestFor(base)
  const backslashDigest = await digestFor({ ...base, pythonExecutable: PYTHON.replace(/\//g, '\\') })
  const upperDigest = await digestFor({ ...base, pythonExecutable: PYTHON.toUpperCase() })

  // ARM 2b -- the pythonw pair. This is the half my first measurement says
  // `os.path.realpath` does NOT collapse, and the half P11's test does not cover.
  let pywDigest: string | null = null
  let pywError: string | null = null
  const pywPresent = existsSync(PYTHON_W)
  if (pywPresent) {
    try {
      pywDigest = await digestFor({ ...base, pythonExecutable: PYTHON_W })
    } catch (error) {
      pywError = error instanceof Error ? error.message : String(error)
    }
  }

  // The manifests, so a reader can see WHICH input moved rather than only that
  // the digest did -- the property P11's arm 2 asserts with `differing`.
  service.reconfigure(base)
  const baseManifest = (await service.environmentStatus()).manifest
  service.reconfigure({ ...base, pythonExecutable: PYTHON_W })
  const pywManifest = (await service.environmentStatus()).manifest
  service.reconfigure(base)

  const differingFields = baseManifest === undefined || pywManifest === undefined
    ? null
    : Object.keys(baseManifest).filter(
      key => (baseManifest as Record<string, unknown>)[key] !== (pywManifest as Record<string, unknown>)[key],
    )

  // ARM 3 -- CONTROL: a config change that is NOT part of the environment must
  // leave the digest alone, or "arm 1 moved" would be satisfied by any change.
  const otherRootDigest = await digestFor({ ...base, root: join(scratch, 'other-kernels') })

  const verdict = {
    arm1_code_change_moves_digest: baseDigest !== decoyDigest,
    arm2_spelling_does_not_move_digest:
      baseDigest === backslashDigest && baseDigest === upperDigest,
    'arm2b_pythonw_does_not_move_digest':
      pywDigest !== null && baseDigest === pywDigest,
    control_root_change_does_not_move_digest: baseDigest === otherRootDigest,
  }

  const report = {
    measuredAt: new Date().toISOString(),
    probe: 'P11b independent acceptance probe (arm 1 must move, arm 2 must not)',
    platform: `${process.platform}/${process.arch}`,
    pythonExecutable: PYTHON,
    files: {
      realBroker: { path: BROKER, sha256: sha256(readFileSync(BROKER)) },
      decoyBroker: { path: decoyBroker, sha256: sha256(readFileSync(decoyBroker)) },
    },
    digests: {
      'baseline (real broker)': baseDigest,
      'ARM 1: DIFFERENT broker code': decoyDigest,
      'ARM 2: same file, backslash spelling': backslashDigest,
      'ARM 2: same file, upper-case spelling': upperDigest,
      'ARM 2b: pythonw.exe (sibling binary)': pywDigest,
      'ARM 3 control: different kernel root': otherRootDigest,
    },
    manifests: {
      baseline: baseManifest,
      pythonw: pywManifest,
      'fields that differ between python.exe and pythonw.exe': differingFields,
    },
    verdict,
    pythonwError: pywError,
    pythonwPresent: pywPresent,
    note:
      'arm2b measures whether V5 11.2\'s required `sys_executable_realpath` field '
      + 'collapses pythonw.exe onto python.exe. os.path.realpath does not resolve '
      + 'between two DIFFERENT executables in one directory, so this arm is a '
      + 'statement about the SPEC\'s field, not about a missed normalisation.',
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, 'after-arm-probe.json')
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`\nwritten: ${outPath}\n`)
}

await main()
