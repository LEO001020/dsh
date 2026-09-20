/**
 * Boot-time probe: is the daily-work service actually live in the resolved host?
 *
 * This is a PLUGIN, not a test, so it runs in the same tree the daily profile
 * boots. It writes its finding to stdout and to a file, then lets the host
 * continue. It proves the extension is mounted through the REAL profile
 * resolver rather than through a test harness.
 *
 * THE OUTPUT PATH IS DERIVED FROM THIS FILE'S OWN LOCATION, not hardcoded.
 *
 * It used to be the literal
 * `'D:/DSH/work/dsh-native-daily/qualification/results/M8.5-c2-real-boot/finding.json'`
 * -- an absolute path into ONE checkout. That is a cross-tree WRITE: a writer
 * running this probe from a git worktree (which the multi-agent discipline
 * requires) deposited its finding into the MAIN tree, and the artifact it landed
 * on is the one `dep-gates.test.ts` and the C2 verdict READ. It is invisible as a
 * diff because the finding is a small JSON object that looks the same from either
 * tree, so the overwrite reads as "the value is what it always was" rather than
 * "another tree wrote here". This is the write-side hazard of `G-SEAM-61` and the
 * same class as `G-SEAM-66`.
 *
 * `import.meta.url` is
 * `.../qualification/runners/verify-c2-service.mjs`, so two levels up is the
 * repository root of WHICHEVER tree is running -- verified for a worktree, where
 * it resolves to that worktree rather than to the main checkout. The finding
 * therefore lands in that tree's evidence directory, beside the run record it
 * describes. `C2_OUT` still overrides for an explicit target.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'c2-verify'
export const inject = ['dailyWork']

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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
  const outPath = process.env.C2_OUT
    ?? join(REPO_ROOT, 'qualification', 'results', 'M8.5-c2-real-boot', 'finding.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(finding, null, 2))
  process.stdout.write(`C2-VERIFY: ${JSON.stringify(finding)}\n`)
}
