/**
 * How long after this row's `apply` starts does `sandboxPolicy` become readable?
 *
 * WHY THIS NUMBER IS NEEDED. The startup boundary must run AFTER `sandboxPolicy`
 * mounts (running earlier reads a half-mounted graph and reports three false
 * violations — the first-attempt boot log is kept as evidence). But the entry
 * must NOT declare a row-level `inject`, because a hard inject makes the guard
 * PENDING on exactly the degraded graph it exists to report. So the ordering has
 * to come from a BOUNDED wait inside `apply`, and the bound must be chosen from a
 * measurement rather than a guess.
 */
import { writeFileSync } from 'node:fs'

export const name = 'measure-mount-latency'
export const inject = []

const OUT = process.env.DSH_PROBE_OUT ?? 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local/mount-latency.json'

export function apply(ctx) {
  const applyStarted = Date.now()
  const record = { probe: 'measure-mount-latency', applyStartedAt: applyStarted, samples: [] }

  // Sample on both seams: the event, if it fires, and the inject callback.
  ctx.on('internal/service', (serviceName) => {
    if (serviceName === 'sandboxPolicy') {
      record.samples.push({ via: 'internal/service', service: serviceName, msAfterApplyStart: Date.now() - applyStarted })
    }
  }, { global: true })

  const already = ctx.get('sandboxPolicy')
  record.samples.push({ via: 'synchronous read', present: already !== undefined, msAfterApplyStart: 0 })

  ctx.inject(['sandboxPolicy'], () => {
    record.samples.push({ via: 'inject callback', msAfterApplyStart: Date.now() - applyStarted })
    record.sandboxPolicyMode = ctx.get('sandboxPolicy')?.defaultMode ?? null
    // Write late enough that the boot's other entries have had their chance, so
    // the sample is the real ordering rather than a race.
    setTimeout(() => writeFileSync(OUT, JSON.stringify(record, null, 1)), 1500)
  })
}
