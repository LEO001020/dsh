/**
 * Boot-time probe: is the `work` tool reachable from the AGENT PRESET?
 *
 * The host scope legitimately carries zero agent tools; tools belong to the
 * preset. So the honest probe is:
 *   1. does the roster resolve our preset id, and does it declare the consumer?
 *   2. does a real Session created on that preset end up with the tool?
 *
 * Step 1 is what this probe can assert from inside a host plugin. Step 2 needs a
 * live turn, which is reported separately.
 *
 * THE OUTPUT PATH IS DERIVED FROM THIS FILE'S OWN LOCATION, not hardcoded.
 *
 * It used to be the literal
 * `'D:/DSH/work/dsh-native-daily/qualification/results/M8.5-c2-real-boot/preset-tools.json'`
 * -- an absolute path into ONE checkout, which made every run from a git worktree
 * overwrite the MAIN tree's evidence. See `verify-c2-service.mjs` for the full
 * statement of the hazard (`G-SEAM-61` write side, same class as `G-SEAM-66`).
 *
 * `import.meta.url` is `.../qualification/runners/verify-preset-tools.mjs`, so two
 * levels up is the repository root of whichever tree is running. `PRESET_TOOLS_OUT`
 * still overrides for an explicit target.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'verify-preset-tools'
export const inject = ['agentPresets']

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function apply(ctx) {
  const finding = {
    presetId: 'daily-standard',
    rosterContainsPreset: false,
    rosterIds: [],
    presetCompositionDeclaresConsumer: false,
    error: null,
  }
  try {
    const presets = ctx.get('agentPresets')
    const listed = await presets.list()
    finding.rosterIds = listed.map(p => p.id).sort()
    finding.rosterContainsPreset = finding.rosterIds.includes('daily-standard')

    const resolved = await presets.resolve('daily-standard')
    // `resolve` returns the preset descriptor; the composition text is what
    // carries the rows. Record whether our row is present in it.
    const composition = JSON.stringify(resolved)
    finding.presetCompositionDeclaresConsumer = composition.includes('dsh-daily-work/tools')
    finding.resolvedKeys = Object.keys(resolved).sort()
  } catch (e) {
    finding.error = e instanceof Error ? e.message : String(e)
  }
  const outPath = process.env.PRESET_TOOLS_OUT
    ?? join(REPO_ROOT, 'qualification', 'results', 'M8.5-c2-real-boot', 'preset-tools.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(finding, null, 2))
  process.stdout.write(`PRESET-TOOLS: ${JSON.stringify(finding)}\n`)
}
