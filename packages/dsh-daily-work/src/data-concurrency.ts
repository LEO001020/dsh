/**
 * The host-owned read-concurrency limiter for the `dsh.data` plane.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TOOLRUNTIME SCHEDULER.
 *
 * V3 §K3 and §K6 are explicit that this is CAPABILITY-LEVEL read concurrency and
 * NOT ToolRuntime sibling scheduling. The distinction is load-bearing rather than
 * pedantic:
 *
 *   - `ctx.tools.execute()` runs ONE complete ToolRuntime call through
 *     pre-policy -> guards -> body -> post-policy -> result observers. Native
 *     AgentLoop and PTC coordinate their ordered pre/post stages through a
 *     module-local scheduler Symbol that is NOT a public downstream seam
 *     (shared brief §5.5). Calling `ctx.tools.execute()` concurrently therefore
 *     buys no scheduling parity -- it just issues several independent pipelines.
 *   - `dsh.data` is a READ plane over already-authorized capabilities. Its
 *     requests never become tool calls, so the only concurrency question is how
 *     many host-side reads may be in flight against one provider at a time.
 *
 * So this is a plain counting semaphore with a CONSERVATIVE host-owned default,
 * not a scheduler and not a policy pipeline. The model cannot reach the bound:
 * the limit is a construction input, and the only way to change it is to change
 * the deployment's configuration.
 *
 * WHY A DEFAULT RATHER THAN "AS MANY AS THE CALLER ASKS".
 *
 * The audit's instruction is "choose a conservative default; benchmark before
 * raising it". A data plane that fans out unboundedly against one filesystem or
 * one search provider converts a throughput win into a latency and quota
 * incident, and the failure is invisible in a single-call test. Four is chosen
 * because it is below the smallest shipped parallelism bound in this repository
 * (the registry's own `maxParallelSubCalls` default is 10, and
 * `native-call.ts` defaults to 8) so the read plane can never be the component
 * that saturates a provider.
 */

/**
 * The conservative default for concurrent `dsh.data` reads.
 *
 * Deliberately below every shipped parallelism default in this repository, and
 * deliberately a single constant so the value is one place to change after a
 * benchmark rather than a number repeated at call sites.
 */
export const DEFAULT_DATA_READ_CONCURRENCY = 4

/** What a limiter reports about itself, so the configured bound is observable. */
export interface DataConcurrencyReport {
  readonly limit: number
  readonly inFlight: number
  readonly waiting: number
  /** Peak simultaneous holders observed since construction. */
  readonly peakInFlight: number
}

/**
 * A counting semaphore over host-side reads.
 *
 * FIFO by construction: waiters are queued and released in arrival order, so a
 * long queue cannot starve an early caller. `run` releases in a `finally`, so a
 * rejected read does not leak a slot -- a leak here would silently shrink the
 * plane's capacity for the rest of the process lifetime, which is the kind of
 * failure that only appears under load.
 *
 * The class is deliberately NOT reentrant and NOT fair-by-priority. A nested
 * `dsh.data` call is not a thing this plane has: every request is a top-level
 * host read, so there is no parent slot to inherit and no deadlock shape to
 * avoid.
 */
export class DataReadLimiter {
  private readonly maxConcurrent: number
  private active = 0
  private peak = 0
  private readonly waiting: Array<() => void> = []

  constructor(maxConcurrent: number = DEFAULT_DATA_READ_CONCURRENCY) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(
        `data plane: read concurrency must be a positive integer, got ${String(maxConcurrent)}; `
        + 'an unbounded or zero-width limiter is not a bound',
      )
    }
    this.maxConcurrent = maxConcurrent
  }

  /** The configured bound. Host-owned; never derived from a request. */
  get limit(): number {
    return this.maxConcurrent
  }

  /**
   * Run one read under the limiter.
   *
   * @param body - the read to admit.
   * @returns the body's result, once a slot was held for its whole duration.
   */
  async run<T>(body: () => Promise<T>): Promise<T> {
    await this.admit()
    try {
      return await body()
    } finally {
      this.release()
    }
  }

  /** The limiter's own state, for a probe or a metric. */
  report(): DataConcurrencyReport {
    return {
      limit: this.maxConcurrent,
      inFlight: this.active,
      waiting: this.waiting.length,
      peakInFlight: this.peak,
    }
  }

  private admit(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.occupy()
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      this.waiting.push(() => {
        this.occupy()
        resolve()
      })
    })
  }

  private occupy(): void {
    this.active += 1
    if (this.active > this.peak) this.peak = this.active
  }

  private release(): void {
    this.active -= 1
    // Hand the slot DIRECTLY to the next waiter rather than decrementing below
    // zero and letting a newcomer race the queue: a direct handoff keeps the
    // observed concurrency at the bound instead of briefly exceeding it.
    const next = this.waiting.shift()
    if (next !== undefined) next()
  }
}

/**
 * Map over items with a bounded number of concurrent bodies.
 *
 * The results keep INPUT ORDER regardless of completion order, because a caller
 * correlating results to requests must not have to sort them -- an out-of-order
 * result list is how a page gets attributed to the wrong artifact.
 *
 * A rejection propagates after the already-admitted bodies settle, so no read is
 * left running with nobody awaiting it.
 *
 * @param items - the inputs, in caller order.
 * @param limit - the host-owned bound.
 * @param body - the per-item read.
 * @returns results in input order.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  body: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  let failure: unknown
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      if (failure !== undefined) return
      try {
        results[index] = await body(items[index] as T, index)
      } catch (error) {
        // First failure wins and stops new work; in-flight bodies still settle
        // because this worker awaits its own call before returning.
        failure ??= error
        return
      }
    }
  })
  await Promise.all(workers)
  if (failure !== undefined) throw failure
  return results
}
