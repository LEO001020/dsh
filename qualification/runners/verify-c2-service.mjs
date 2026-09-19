/**
 * Boot-time probe: is the daily-work service actually live in the resolved host?
 *
 * This is a PLUGIN, not a test, so it runs in the same tree the daily profile
 * boots. It writes its finding to stdout and to a file, then lets the host
 * continue. It proves the extension is mounted through the REAL profile
 * resolver rather than through a test harness.
 */
import { writeFileSync } from 'node:fs'

export const name = 'c2-verify'
export const inject = ['dailyWork']

export function apply(ctx) {
  const service = ctx.get('dailyWork')
  const finding = {
    servicePresent: service !== undefined,
    hasCreateRun: typeof service?.createRun === 'function',
    hasDrain: typeof service?.drain === 'function',
    hasCounts: typeof service?.counts === 'function',
    hasTakeContinuation: typeof service?.takeContinuation === 'function',
    hasListRunIds: typeof service?.listRunIds === 'function',
    profileName: ctx.get('profileContext')?.profile?.name ?? 'unknown',
  }
  writeFileSync('D:/DSH/work/dsh-native-daily/qualification/results/M8.5-c2-real-boot/finding.json', JSON.stringify(finding, null, 2))
  process.stdout.write(`C2-VERIFY: ${JSON.stringify(finding)}\n`)
}
