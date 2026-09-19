/**
 * Boot-time probe for gate B03: the plugin lifecycle, three load/unload cycles,
 * with work still awaiting.
 *
 * The requirement is not "it mounts once". It is that a cycle leaves nothing
 * behind: no orphan timer, no orphan listener, no un-closed storage-domain
 * handle, and no way for a disposed generation to keep accepting work.
 *
 * This runs INSIDE a real `dsh --profile daily` boot, so the module identity it
 * cycles is the one the profile resolver actually loaded (proven separately by
 * verify-b02: one realpath per peer, all built output). A lifecycle test in a
 * bare vitest process would cycle a DIFFERENT module instance and could pass
 * while the deployed graph leaks.
 *
 * Two corrections were forced by measurement, and both are the reason this
 * probe is shaped the way it is:
 *
 * 1. The leak signal is the delta BETWEEN cycles, not against a pre-cycle
 *    baseline. An earlier version reported "9 orphan handles" that were really
 *    one-time lazy initialization in the host.
 * 2. `process._getActiveHandles()` does NOT report timers, so it cannot see the
 *    exact resource this gate names. `process.getActiveResourcesInfo()` does,
 *    and is what this probe counts.
 *
 * The control arm runs FIRST so that whatever the host initializes on its first
 * plugin mount is charged to the control rather than to the extension. The
 * extension arm then runs against an already-warm host, which is the state a
 * real reload happens in.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-b03'
export const inject = ['dailyWork']

const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M9.18-b03-lifecycle/b03.json'

/**
 * Count live resources by kind.
 *
 * `getActiveResourcesInfo` is the only standard API that reports timers, which
 * are precisely what a plugin that forgets its disposer leaks.
 */
function census() {
  const resources = process.getActiveResourcesInfo?.() ?? []
  const kinds = {}
  for (const kind of resources) kinds[kind] = (kinds[kind] ?? 0) + 1
  return {
    total: resources.length,
    kinds,
    listeners: process.eventNames().reduce((sum, name) => sum + process.listenerCount(name), 0),
  }
}

/**
 * Cycle one plugin body three times, awaiting disposal each time with work
 * still pending, and return the per-cycle census.
 * @param ctx - the live host context.
 * @param install - registers the plugin body's resources.
 * @param label - recorded so the two arms are distinguishable in evidence.
 */
async function cycle(ctx, install, label) {
  const cycles = []
  for (let n = 1; n <= 3; n += 1) {
    const fiber = ctx.plugin({ name: `b03-${label}-${n}`, inject: ['storageDomain'], apply: install })
    // Work still in flight when the unload is requested. Disposal must not be
    // defeated by a pending await.
    const pending = new Promise(resolve => setTimeout(resolve, 250))
    await fiber.dispose()
    await pending
    cycles.push({ n, after: census() })
  }
  return cycles
}

/** Per-cycle deltas: a flat tail means each cycle released what it took. */
function deltas(series) {
  return series.slice(1).map((v, i) => v - series[i])
}

export async function apply(ctx) {
  const finding = { control: null, arm: null, error: null }

  try {
    // ── Control FIRST: an empty plugin that owns nothing. ───────────────────
    // Any one-time host initialization is paid here, so the extension arm is
    // measured against a warm host and cannot be blamed for it.
    const ctlBefore = census()
    finding.control = { label: 'empty-control', before: ctlBefore, cycles: await cycle(ctx, () => {}, 'ctl') }

    // ── Arm: a plugin body that owns a long-lived timer. ────────────────────
    // The timer is the resource whose release the gate asks about, and it is
    // only detectable through getActiveResourcesInfo.
    const armBefore = census()
    finding.arm = {
      label: 'timer-owning-body',
      before: armBefore,
      cycles: await cycle(ctx, inner => {
        const timer = setInterval(() => {}, 3_600_000)
        inner.effect(() => () => clearInterval(timer), 'b03: keepalive timer')
      }, 'ext'),
    }

    const ctlSeries = [ctlBefore.total, ...finding.control.cycles.map(c => c.after.total)]
    const armSeries = [armBefore.total, ...finding.arm.cycles.map(c => c.after.total)]
    finding.controlTotalSeries = ctlSeries
    finding.armTotalSeries = armSeries
    finding.controlPerCycleDelta = deltas(ctlSeries)
    finding.armPerCycleDelta = deltas(armSeries)

    // The gate's actual question: does the tail stay flat? Compare the last two
    // cycles, which is after every one-time cost has been paid.
    const tail = series => series[series.length - 1] - series[series.length - 2]
    finding.armFinalCycleGrowth = tail(armSeries)
    finding.controlFinalCycleGrowth = tail(ctlSeries)

    // Timer-specific check. The disposer clears the timer, so the Timeout count
    // must return to what it was before the plugin mounted. If it climbs by one
    // per cycle, the disposer is not wired.
    const timeouts = s => s.after.kinds.Timeout ?? 0
    finding.armTimeoutSeries = [armBefore.kinds.Timeout ?? 0, ...finding.arm.cycles.map(timeouts)]
    finding.armTimerLeak = finding.armTimeoutSeries[finding.armTimeoutSeries.length - 1]
      - finding.armTimeoutSeries[0]

    // The domain must still be usable after the cycles: a lifecycle that
    // "cleans up" by breaking the shared host handle is not a pass either.
    const service = ctx.get('dailyWork')
    finding.domainUsableAfterCycles = service !== undefined && typeof service.listRunIds === 'function'
    finding.runIdsAfterCycles = service?.listRunIds?.() ?? null
  } catch (e) {
    finding.error = e instanceof Error ? e.message : String(e)
  }

  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`B03: ${JSON.stringify(finding)}\n`)
}
