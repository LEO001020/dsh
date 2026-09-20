/**
 * P10 composition-tier probe: does a REAL daily boot report a DURABLE bridge
 * ledger, and does it report it through the status surface V5 §11.1 names?
 *
 * WHY THE CODE-PATH TIER IS NOT ENOUGH HERE, in this project's own words: a test
 * that mounts the service proves the MODULE works and proves nothing about the
 * PRODUCT. `packages/dsh-ipython/src/p10-ledger-durable.test.ts` measures the
 * service with contexts the test owns, including a storage facility the test
 * mounted. This probe measures what V5 §11.1 actually asks about: the assembled
 * `daily` profile, booted through the shared port-safe harness, with ITS OWN
 * storage domain, resolving ITS OWN `ipython` service, reporting
 * `bridgeLedgerDurable: true`.
 *
 * WHAT IT ESTABLISHES, AND WHAT IT DOES NOT:
 *   - it DOES read ledger durability out of a real boot's own service, and out of
 *     the STATUS surface rather than only a private accessor;
 *   - it does NOT drive a model turn (no LLM is authorized in this deployment),
 *     and it establishes NOTHING about a real power loss. A durable JSON ledger
 *     is not a crash-proof one.
 *
 * OUTPUT PATH IS OVERRIDABLE and unset is a hard error: a probe writing to a
 * fixed path is a shared mutable resource whose result cannot be attributed
 * (G-FIX-13), and it must not write into a tree it does not own.
 */
import { writeFileSync } from 'node:fs'

export const name = 'p10-ledger-durable'
// A readiness gate: if the ipython service is not composed this probe reports
// NOTHING rather than a false absence (the G-FIX-04 shape).
export const inject = ['sessionController', 'ipython', 'tools']

const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('p10-ledger-durable: DSH_PROBE_OUT must name this caller\'s own result path')
}

/** What this probe observed, written as one JSON document. */
const finding = {
  probe: 'p10-ledger-durable',
  serviceResolved: false,
  storageDomainPresent: false,
  sessionCreated: false,
  cellOutcome: null,
  cellPrinted: null,
  // The refusal classification, kept separate from the raw outcome because the
  // tool surfaces a refusal as ordinary text with `isError: false` -- see the
  // note in the body. A reader must be able to tell the two apart.
  cellOutcomeIsErrorFlag: null,
  cellRefused: null,
  cellRan: null,
  kernelEpoch: null,
  kernelLifecycle: null,
  // The accessor the code-path tier used, kept so the status field can be checked
  // AGAINST it rather than instead of it: two readers of one fact must agree.
  ledgerIsDurable: null,
  // THE FIELD V5 §11.1 REQUIRES, read from the status surface a doctor reads.
  bridgeLedgerDurable: null,
  statusRead: false,
  error: null,
}

export async function apply(ctx) {
  try {
    const service = ctx.get('ipython')
    finding.serviceResolved = service !== undefined
    if (service === undefined) throw new Error('the ipython service is not composed in this profile')

    // Is a storage facility actually mounted in THIS boot? Without it the service
    // would now REFUSE to publish a kernel, so this separates "durable" from "the
    // composition lost its storage row" -- the two causes of the same symptom.
    finding.storageDomainPresent = ctx.get('storageDomain') !== undefined

    // A REAL Session on the profile's own default preset, and the LIVE agent the
    // boot created for it. The agent object is the scope key `ctx.tools.execute`
    // needs, exactly as the agent loop supplies it.
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: process.cwd() })
    const sessionId = created?.sessionId ?? created?.id ?? null
    finding.sessionCreated = sessionId !== null
    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) throw new Error('the created session has no live agent in this process')

    // ONE REAL CELL through the product's own tool registry. This is what makes
    // the kernel publish, and therefore what makes the creation transaction --
    // including the ledger open -- actually run in the product.
    const tools = ctx.get('tools')
    const result = await tools.execute({
      callId: 'p10-ledger-durable-outer-1',
      name: 'ipython',
      arguments: { code: 'print("P10_BOOT_CELL_OK")' },
      agent,
      signal: new AbortController().signal,
    })
    finding.cellOutcome = result.isError ? 'error' : 'ok'
    const printed = (result.isError
      ? String(result.error?.message ?? '')
      : String(result.value?.text ?? '')).slice(0, 2000)
    finding.cellPrinted = printed

    // THE TOOL REPORTS A REFUSAL AS TEXT, NOT AS `isError`, and that is worth
    // recording rather than working around: `ipython-tool.ts` maps a
    // `KernelTransportError` to `'outcome: transport_failure\n' + message` as an
    // ordinary successful tool RESULT, so `result.isError` is FALSE for a kernel
    // that refused to publish. A reader who trusted `isError` alone would record
    // this boot as a successful cell -- measured, in the first run of this probe,
    // which is why the classification below reads the text.
    finding.cellOutcomeIsErrorFlag = result.isError === true
    finding.cellRefused = /^outcome:\s*(transport_failure|failed|refused)/mu.test(printed)
    finding.cellRan = finding.cellOutcomeIsErrorFlag === false && finding.cellRefused === false

    finding.kernelEpoch = service.currentEpoch?.(agent) ?? null
    finding.kernelLifecycle = service.lifecycleOf?.(agent) ?? null

    // ---- READ 1: the accessor the code-path tier already used ----------------
    finding.ledgerIsDurable = service.ledgerIsDurable?.(agent) ?? null

    // ---- READ 2: THE STATUS SURFACE (V5 §11.1's own requirement) -------------
    const status = await service.status?.(agent)
    finding.statusRead = status !== undefined
    finding.bridgeLedgerDurable = status?.bridgeLedgerDurable ?? null
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`, 'utf8')
}
