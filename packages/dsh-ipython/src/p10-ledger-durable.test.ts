/**
 * P10 LEDGER-DURABLE — the V5 §18 case, plus the two defects P10's slice names.
 *
 * THE ORACLE (V5 §11.1 / §18 LEDGER-DURABLE):
 *
 *   "final daily refuses READY when the durable bridge ledger unavailable."
 *   "Memory ledger allowed only in explicit unit/development configuration:
 *    durableLedger = false."
 *   "Status/doctor must show: bridgeLedgerDurable: true."
 *
 * WHAT THIS FILE IS, AND WHY IT IS NOT ANOTHER UNIT TEST OF `openBridgeLedger`.
 * The defect is not that `openBridgeLedger` misbehaves -- it is that
 * `KernelService.entryFor` SWALLOWS its failure and substitutes an in-memory
 * ledger. So every arm here drives the REAL `KernelService` through its real
 * creation transaction and asks what the SERVICE did, never what the helper
 * returned. The stimulus is a storage facility that genuinely cannot open a
 * domain, not a mocked function: a mock would prove the mock.
 *
 * WHY A REAL FAILING FACILITY IS CONSTRUCTIBLE. `storage-domain`'s
 * `open(spec)` refuses a domain name that is already open
 * (`@deepseek-ai/dsh-storage-domain`, `src/index.ts`, `DomainError('already-open')`).
 * That is a real failure mode of the real facility, reachable without stubbing
 * anything: open the ledger domain by hand first, and every subsequent open of
 * the same name fails. The other arm is the plainer one -- a context with no
 * storage facility at all, which is what a deployment that lost its storage row
 * looks like.
 *
 * THE DEFAULT IS THE SUBJECT. Every arm except the explicit-development one
 * leaves `durableLedger` UNSET, because unset is what the production profile
 * does (`packages/dsh-ipython/cordis.patch.yml` sets neither `durableLedger` nor
 * anything that would change it). A test that passed `durableLedger: true`
 * explicitly would prove the flag works while leaving the production default
 * unmeasured, which is the whole defect.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelService } from './kernel-plugin.ts'
import { MemoryBridgeLedger, bridgeLedgerDomainSpec, storageFacilityOf } from './bridge-ledger.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let service: KernelService | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-ledger-durable-'))
})

afterEach(async () => {
  if (service !== undefined) {
    await service.close().catch(() => undefined)
    service = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function agentFor(sessionId: string): Agent {
  return { session: { header: { id: sessionId, cwd: root } } } as unknown as Agent
}

/** Mount the same three-row storage stack the profile's base bundle mounts. */
async function mountStorage(target: Context, storeRoot: string): Promise<void> {
  await target.plugin(Storage)
  await target.plugin(storageJsonPlugin as never, { root: storeRoot } as never)
  await target.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
}

// ---------------------------------------------------------------------------
// LEDGER-DURABLE 1 — the required arm: a requested durable ledger that cannot
// open must REFUSE, not degrade.
// ---------------------------------------------------------------------------

describe('LEDGER-DURABLE: a requested durable ledger that cannot open refuses READY', () => {
  it('refuses when the deployment has NO storage facility and durability was not opted out of', async () => {
    // THE PRODUCTION CONFIGURATION. `durableLedger` is deliberately NOT set:
    // that is what `cordis.patch.yml` does, so this is the default the product
    // rides. A storage facility is absent, which is what a deployment that lost
    // its storage row -- or booted before it -- actually looks like.
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
    })

    // BEFORE THE FIX this resolves and returns a kernel backed by an in-memory
    // ledger, which is the silent degradation the slice is about.
    await expect(service.runCell(agentFor('ledger-required-nostorage'), 'pass'))
      .rejects.toThrow(/ledger/iu)
  }, 180_000)

  it('refuses when the storage facility is present but the ledger domain cannot open', async () => {
    // THE FACILITY-IS-PRESENT, DOMAIN-FAILS ARM. A real storage stack is mounted,
    // and then the ledger domain name is opened by hand first. `storage-domain`
    // refuses a second open of the same name (`DomainError('already-open')`), so
    // `openBridgeLedger` genuinely rejects -- the same class of failure as a
    // corrupt or unwritable medium, without stubbing anything.
    const storeRoot = join(root, 'store')
    await mountStorage(ctx, storeRoot)
    const facility = storageFacilityOf(ctx)
    expect(facility).toBeDefined()
    await facility!.open(bridgeLedgerDomainSpec)

    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
    })

    await expect(service.runCell(agentFor('ledger-required-domainfail'), 'pass'))
      .rejects.toThrow(/ledger/iu)
  }, 180_000)

  it('refuses without publishing READY: no kernel, no bridge, and no entry left behind', async () => {
    // A REFUSAL THAT LEAVES A USABLE KERNEL BEHIND IS NOT A REFUSAL. The
    // creation transaction's failure arm disposes the bridge and the process
    // range, so a reader must observe no kernel for that Session -- the same
    // property the existing transaction already guarantees for a bridge failure.
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
    })
    const agent = agentFor('ledger-required-nopublish')

    await expect(service.runCell(agent, 'pass')).rejects.toThrow(/ledger/iu)

    expect(service.hasKernel(agent)).toBe(false)
    expect(service.bridgeFor(agent)).toBeUndefined()
    expect(service.lifecycleOf(agent)).toBeUndefined()
  }, 180_000)
})

// ---------------------------------------------------------------------------
// LEDGER-DURABLE 2 — the explicit development arm still works, and is HONESTLY
// reported as non-durable.
// ---------------------------------------------------------------------------

describe('LEDGER-DURABLE: an explicit development configuration still works', () => {
  it('runs a cell with durableLedger: false and reports non-durability rather than claiming it', async () => {
    // THE EXPLICIT OPT-OUT, which V5 §11.1 permits for unit/development hosts.
    // This is the ONLY configuration in which an in-memory ledger is allowed,
    // and the arm asserts BOTH halves: the cell runs, AND the service reports
    // the truth about what it used. A configuration that ran but reported
    // `true` would be the original defect wearing the fix as a costume.
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
      durableLedger: false,
    })
    const agent = agentFor('ledger-explicit-memory')

    const result = await service.runCell(agent, 'print("memory-ledger-ok")')
    expect(result.stdout.text).toContain('memory-ledger-ok')

    expect(service.ledgerIsDurable(agent)).toBe(false)
    expect(service.ledgerFor(agent)).toBeInstanceOf(MemoryBridgeLedger)
  }, 180_000)
})

// ---------------------------------------------------------------------------
// LEDGER-DURABLE 3 — the control: the durable path is still reachable, so the
// refusals above are not the trivial "nothing ever opens a ledger" outcome.
// ---------------------------------------------------------------------------

describe('LEDGER-DURABLE: the control arm, without which the refusals prove nothing', () => {
  it('runs a cell on the durable default and reports durability, with no opt-out needed', async () => {
    // A GATE THAT REFUSES EVERYTHING PASSES EVERY REFUSAL TEST. If the fix were
    // "always throw", the three arms above would all pass and the product would
    // be dead. This arm is the one that must still work: storage mounted, no
    // `durableLedger` key at all, and the service reports `true`.
    await mountStorage(ctx, join(root, 'store'))
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
    })
    const agent = agentFor('ledger-durable-control')

    const result = await service.runCell(agent, 'print("durable-ledger-ok")')
    expect(result.stdout.text).toContain('durable-ledger-ok')

    expect(service.ledgerIsDurable(agent)).toBe(true)
    expect(service.ledgerFor(agent)).not.toBeInstanceOf(MemoryBridgeLedger)
  }, 180_000)

  it('gives a SECOND session in the same process a durable ledger too', async () => {
    // THE MULTI-SESSION ARM, and the reason it is here rather than in a separate
    // file: `openBridgeLedger` is called once per NEW Session, and
    // `storage-domain` refuses a domain name that is already open. If the
    // service re-opens the domain per Session instead of holding one handle,
    // session 2 silently gets memory while session 1 is durable -- a partial
    // degradation that a single-session test cannot see.
    await mountStorage(ctx, join(root, 'store'))
    service = new KernelService(ctx, {
      pythonExecutable: PYTHON,
      brokerScript: BROKER,
      root: join(root, 'kernels'),
    })

    const first = agentFor('ledger-multisession-1')
    const second = agentFor('ledger-multisession-2')
    await service.runCell(first, 'print("first")')
    await service.runCell(second, 'print("second")')

    expect(service.ledgerIsDurable(first)).toBe(true)
    expect(service.ledgerIsDurable(second)).toBe(true)
  }, 240_000)
})
