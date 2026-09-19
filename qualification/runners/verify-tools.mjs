/**
 * Boot-time probe: does the `work` tool reach the MODEL's tool list?
 *
 * The service being mounted is not enough. The plan's B06/B08 concern the
 * model-facing surface, so this asks the assembled prompt what tools it carries.
 * That is the same surface `dsh-tool-web` and every other tool consumer feeds.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-tools'
export const inject = ['tools']

export function apply(ctx) {
  // The tool consumer lives in the AGENT PRESET, not the host. So this probe
  // reports what the HOST sees and states plainly that the preset half is
  // checked separately.
  const names = ctx.get('tools').schemas().map(s => s.name).sort()
  const finding = {
    hostVisibleToolCount: names.length,
    workToolPresentInHostScope: names.includes('work'),
    sample: names.slice(0, 12),
  }
  writeFileSync('D:/DSH/work/dsh-native-daily/qualification/results/M8.5-c2-real-boot/tools-host.json', JSON.stringify(finding, null, 2))
  process.stdout.write(`TOOLS-VERIFY: ${JSON.stringify(finding)}\n`)
}
