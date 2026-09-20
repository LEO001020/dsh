/**
 * Boot-time probe: does the `work` tool reach the MODEL's tool list?
 *
 * The service being mounted is not enough. The plan's B06/B08 concern the
 * model-facing surface, so this asks the assembled prompt what tools it carries.
 * That is the same surface `dsh-tool-web` and every other tool consumer feeds.
 *
 * THE OUTPUT PATH IS DERIVED FROM THIS FILE'S OWN LOCATION, not hardcoded.
 *
 * It used to be the literal
 * `'D:/DSH/work/dsh-native-daily/qualification/results/M8.5-c2-real-boot/tools-host.json'`
 * -- an absolute path into ONE checkout, which made every run from a git worktree
 * overwrite the MAIN tree's evidence. See `verify-c2-service.mjs` for the full
 * statement of the hazard (`G-SEAM-61` write side, same class as `G-SEAM-66`).
 *
 * `import.meta.url` is `.../qualification/runners/verify-tools.mjs`, so two levels
 * up is the repository root of whichever tree is running. `TOOLS_OUT` still
 * overrides for an explicit target.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'verify-tools'
export const inject = ['tools']

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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
  const outPath = process.env.TOOLS_OUT
    ?? join(REPO_ROOT, 'qualification', 'results', 'M8.5-c2-real-boot', 'tools-host.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(finding, null, 2))
  process.stdout.write(`TOOLS-VERIFY: ${JSON.stringify(finding)}\n`)
}
