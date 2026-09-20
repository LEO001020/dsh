/**
 * P11 ENV-DIGEST probe: what does `environmentDigest` actually bind?
 *
 * V5 §11.2 asks the environment manifest to include `broker_sha256` and the two
 * client hashes, so that the identity binds THE CODE THAT EXECUTES rather than
 * only the interpreter's path. V5 §18 then asks for an `ENV-DIGEST` case whose
 * property is that a change to the environment MOVES the digest.
 *
 * This probe measures the CURRENT digest against both halves of that property,
 * through the real `KernelService.identityFor` rather than a re-implementation of
 * its hash -- a probe that recomputes the hash itself would agree with the source
 * by construction and could not falsify anything.
 *
 * TWO ARMS, and they fail in OPPOSITE directions. A digest that only fails one is
 * still wrong:
 *
 *   FALSE IDENTITY      the environment CHANGED and the digest did NOT move.
 *                       Measured by varying `brokerScript` -- the Python the
 *                       kernel actually loads -- and reading the identity back.
 *
 *   FALSE DISTINCTION   the environment did NOT change and the digest DID move.
 *                       Measured by spelling the SAME interpreter two ways.
 *                       `pythonw.exe` and `python.exe` sit in one directory,
 *                       load one DLL set and one site-packages, and are the same
 *                       environment by every property a kernel can observe.
 *
 * No kernel is started and nothing is mutated: `identityFor` is pure over the
 * configuration, which is exactly why this is safe to run against a real checkout
 * and against the user's real interpreter.
 *
 * Run: node --experimental-strip-types src/p11-env-digest-probe.ts
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BROKER = resolve(HERE, 'broker.py')
const PYTHON_DIR = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314'
const PYTHON = process.env['DSH_PYTHON'] ?? `${PYTHON_DIR}/python.exe`
const PYTHON_W = `${PYTHON_DIR}/pythonw.exe`
const OUT_DIR = resolve(REPO_ROOT, 'qualification', 'results', 'P11-env')

/** The digest as the CURRENT source computes it, restated so the report can show it. */
const digestOf = (python: string): string => createHash('sha256')
  .update(`${python}\u0000${process.platform}\u0000${process.arch}`)
  .digest('hex')
  .slice(0, 16)

const agent = { session: { header: { id: 'p11-env-digest', cwd: REPO_ROOT } } } as unknown as Agent

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Subprocess)

  // A broker path that EXISTS and is NOT the real broker. This is the cleanest
  // form of the false-identity arm: no file is mutated, and the second broker is
  // a real file with different content, so a digest that binds the executing code
  // must separate the two.
  const scratch = join(REPO_ROOT, 'qualification', 'results', 'P11-env', 'scratch')
  mkdirSync(scratch, { recursive: true })
  const decoyBroker = join(scratch, 'decoy-broker.py')
  writeFileSync(decoyBroker, '# a DIFFERENT broker: different bytes, same identity?\nprint("decoy")\n', 'utf8')

  // ONE service, reconfigured between arms. Cordis refuses a second service of
  // the same name on one context, and `reconfigure` is the host operation that
  // exists for exactly this -- so the probe drives the real path rather than
  // working around it.
  const base = { pythonExecutable: PYTHON, brokerScript: BROKER, root: join(scratch, 'kernels') }
  const service = new KernelService(ctx, base)

  const identityFor = async (config: typeof base): Promise<string> => {
    service.reconfigure(config)
    return (await service.identityFor(agent)).environmentDigest
  }

  // ARM 1 -- FALSE IDENTITY: vary the code that executes.
  const realBrokerDigest = await identityFor(base)
  const decoyBrokerDigest = await identityFor({ ...base, brokerScript: decoyBroker })

  // ARM 2 -- FALSE DISTINCTION: vary the spelling of one interpreter.
  const exeDigest = identityFor(base)
  const exeWAliasDigest = await identityFor({ ...base, pythonExecutable: PYTHON_W })

  // ARM 3 -- a third input that also is not in the identity, as a control that the
  // arm-1 result is about brokerScript and not about any config change at all.
  const otherRootDigest = await identityFor({ ...base, root: join(scratch, 'other-kernels') })

  // ARM 4 -- the reachable form of arm 2. A Windows user setting `DSH_PYTHON`
  // types backslashes; the committed patch file uses forward slashes. Same file,
  // same interpreter, two spellings -- and `!!js process.env.DSH_PYTHON` flows the
  // string into the digest verbatim.
  const backslashDigest = await identityFor({
    ...base,
    pythonExecutable: PYTHON.replace(/\//g, '\\'),
  })
  const upperCaseDigest = await identityFor({ ...base, pythonExecutable: PYTHON.toUpperCase() })

  const sameEnvironment = {
    'pythonw.exe exists': existsSync(PYTHON_W),
    'python.exe exists': existsSync(PYTHON),
    'same directory': dirname(PYTHON_W) === dirname(PYTHON),
  }

  const report = {
    measuredAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    pythonExecutable: PYTHON,
    realBroker: { path: BROKER, sha256Prefix: digestOf(BROKER) },
    decoyBroker: { path: decoyBroker, sha256Prefix: digestOf(decoyBroker) },
    arms: {
      'baseline (real broker)': realBrokerDigest,
      'DIFFERENT broker code': decoyBrokerDigest,
      'pythonw.exe (same interpreter)': exeWAliasDigest,
      'different kernel root': otherRootDigest,
      'backslashes (same file, DSH_PYTHON spelling)': backslashDigest,
      'upper case (same file)': upperCaseDigest,
    },
    verdicts: {
      FALSE_IDENTITY: {
        question: 'does the digest move when the EXECUTING CODE changes?',
        brokerScriptChanged: realBrokerDigest !== decoyBrokerDigest,
        result: realBrokerDigest === decoyBrokerDigest ? 'FALSE IDENTITY -- digest did NOT move' : 'binds code',
      },
      FALSE_DISTINCTION: {
        question: 'does the digest move when the ENVIRONMENT is unchanged?',
        interpreterSpellingChanged: realBrokerDigest !== exeWAliasDigest,
        result: realBrokerDigest !== exeWAliasDigest
          ? 'FALSE DISTINCTION -- digest DID move for one environment'
          : 'stable across spellings',
      },
      REACHABLE_FALSE_DISTINCTION: {
        question: 'is the false distinction reachable through the documented override?',
        backslashSpelling: realBrokerDigest !== backslashDigest,
        upperCaseSpelling: realBrokerDigest !== upperCaseDigest,
        result: (realBrokerDigest !== backslashDigest || realBrokerDigest !== upperCaseDigest)
          ? 'REACHABLE -- DSH_PYTHON spelling alone changes the environment identity'
          : 'not reachable by spelling',
      },
      control: {
        question: 'is the digest sensitive to config at all?',
        kernelRootChanged: realBrokerDigest !== otherRootDigest,
      },
    },
    environmentEqualityEvidence: sameEnvironment,
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, 'env-digest-before.json')
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`\nwritten: ${outPath}\n`)
}

await main()
