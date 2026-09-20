/**
 * P10 composition-tier DRIVER: boot the real `daily` profile and read the bridge
 * ledger's durability out of that boot's OWN service and status surface.
 *
 * WHY A DRIVER AND NOT A DIRECT BOOT. `boot-harness.mjs` picks a genuinely free
 * port by BINDING it, kills the host afterwards, and VERIFIES the port was
 * released. A second agent booting on a guessed port produces EADDRINUSE ->
 * "2 required plugins did not activate" -> a boot that LOOKS like a composition
 * failure but is only a port conflict. That has already cost this project an
 * investigation, so every boot goes through the harness.
 *
 * THE OUTPUT PATHS ARE THIS WORKTREE'S OWN, derived from this file's location, so
 * a run here cannot write into a tree it does not own (the stale-artifact trap
 * that produced two retracted findings, G-SEAM-29 / G-SEAM-36).
 *
 * TWO ARMS, AND THE SECOND IS THE ONE THAT MATTERS:
 *
 *   1. `daily` as composed. The ledger must open and the status surface must
 *      report `bridgeLedgerDurable: true` (V5 §11.1).
 *   2. `daily` with the `storage-domain` row DISABLED. V5 §18 LEDGER-DURABLE
 *      requires this to REFUSE rather than degrade. A positive arm alone cannot
 *      tell "durable" from "the fallback is still there and it happens to work
 *      because storage is present", so the negative arm is what makes arm 1 mean
 *      something.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { bootAndWait, sleep } from './boot-harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const RESULTS = resolve(REPO, 'qualification', 'results', 'P10-ledger')

const HOME = process.env.P10_DSH_HOME ?? 'D:/DSH/home/p10'
const PROFILE = process.env.P10_PROFILE ?? 'daily'

/**
 * Materialise an overlay that mounts THIS tree's probe, and nothing else.
 *
 * THE `name:` IS A MODULE SPECIFIER, not a path the harness resolves for us: the
 * loader turns an absolute specifier into a `file://` URL and imports exactly that
 * file. So a committed literal would make a boot from THIS worktree execute
 * ANOTHER writer's probe while believing it measured its own composition -- cross-
 * tree CODE EXECUTION, not merely a cross-tree read. That is why the overlay is
 * written at run time with this tree's own path rather than committed as a
 * runnable file.
 *
 * There is deliberately NO ipython service row and NO ipython tool row here: the
 * case is about what the `daily` profile's OWN composition registers, and adding
 * either would prove the bridge works when a row is present while proving nothing
 * about the product (the G-FIX-04 shape).
 */
function materialiseProbeOverlay(name) {
  const target = resolve(RESULTS, name)
  const probe = resolve(HERE, 'p10-ledger-durable.mjs').replace(/\\/g, '/')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, [
    '# P10 overlay: the PROBE ONLY, materialised at run time with this tree\'s own',
    '# probe path. See the driver for why a committed literal would be cross-tree',
    '# code execution.',
    '- insert:',
    '    - id: p10-ledger-durable-probe',
    `      name: '${probe}'`,
    '',
  ].join('\n'), 'utf8')
  return target
}

/**
 * The negative arm's overlay: occupy the ledger domain before the service opens
 * it, so the service's own open fails while everything else stays intact.
 *
 * See `p10-ledger-occupier.mjs` for why this instrument replaced two coarser
 * ones. `P10_LEDGER_MODULE` is passed through the boot environment so the
 * occupier and the service contend for the SAME domain spec from the SAME tree.
 */
function materialiseOccupierOverlay() {
  const target = resolve(RESULTS, 'p10-ledger-occupier.patch.yml')
  const occupier = resolve(HERE, 'p10-ledger-occupier.mjs').replace(/\\/g, '/')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, [
    '# P10 negative arm: the composition stays INTACT; only the bridge ledger\'s',
    '# open is made to fail, by occupying its domain name first.',
    '- insert:',
    '    - id: p10-ledger-occupier',
    `      name: '${occupier}'`,
    '',
  ].join('\n'), 'utf8')
  return target
}

/** Boot one arm and return what the probe wrote, plus the boot's own outcome. */
async function runArm(label, patches, outName, env = {}) {
  const outPath = resolve(RESULTS, outName)
  const boot = await bootAndWait({
    home: HOME,
    profile: PROFILE,
    patches,
    outPath,
    cwd: REPO,
    timeoutMs: 180_000,
    env,
  })
  await sleep(500)
  let finding = null
  let readError = null
  try {
    finding = JSON.parse(readFileSync(outPath, 'utf8'))
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
  }
  return {
    label,
    outPath,
    port: boot.port,
    portReleased: boot.portReleased,
    hostExitCode: boot.exitCode,
    timedOut: boot.timedOut,
    finding,
    readError,
    stderrTail: String(boot.stderr).slice(-4000),
    stdoutTail: String(boot.stdout).slice(-2000),
  }
}

const probeOverlay = materialiseProbeOverlay('p10-ledger-durable.patch.yml')
const positive = await runArm('daily-as-composed', [probeOverlay], 'composition-tier.json')

const occupierOverlay = materialiseOccupierOverlay()
const negative = await runArm(
  'ledger-domain-occupied',
  [occupierOverlay, probeOverlay],
  'composition-tier.no-storage.json',
  // The occupier imports the domain spec from THIS tree, so the name it occupies
  // is the name the service will try to open.
  { P10_LEDGER_MODULE: resolve(REPO, 'packages', 'dsh-ipython', 'src', 'bridge-ledger.ts').replace(/\\/g, '/') },
)

const verdict = {
  scope: 'P10 composition tier',
  tree: REPO,
  home: HOME,
  profile: PROFILE,
  positive,
  negative,
  // THE CLAIMS, stated explicitly so a reader checks them rather than infers them.
  positiveClaims: {
    serviceResolved: positive.finding?.serviceResolved === true,
    storageDomainPresent: positive.finding?.storageDomainPresent === true,
    cellRan: positive.finding?.cellRan === true,
    ledgerIsDurable: positive.finding?.ledgerIsDurable === true,
    bridgeLedgerDurableOnStatus: positive.finding?.bridgeLedgerDurable === true,
  },
  negativeClaims: {
    // The probe itself must have RUN for this arm to mean anything: if it never
    // wrote, the arm measured a collapsed composition and not the ledger gate.
    probeRan: negative.finding !== null,
    cellRefused: negative.finding?.cellRefused === true,
    // The refusal must be the LEDGER's, naming the ledger -- not some unrelated
    // failure that happens to stop the cell.
    refusalNamesLedger: /ledger/iu.test(String(negative.finding?.cellPrinted ?? '')
      + String(negative.finding?.error ?? '')),
    noKernelPublished: negative.finding?.kernelLifecycle === null
      || negative.finding?.kernelLifecycle === undefined,
  },
}
mkdirSync(RESULTS, { recursive: true })
writeFileSync(resolve(RESULTS, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
process.stdout.write(`P10 POSITIVE: ${JSON.stringify(verdict.positiveClaims)}\n`)
process.stdout.write(`P10 NEGATIVE: ${JSON.stringify(verdict.negativeClaims)}\n`)
process.stdout.write(`P10 wrote ${resolve(RESULTS, 'verdict.json')}\n`)
