/**
 * C4 independent loader-hook recorder: record EVERY module resolution the booted
 * host performs, not only the `@deepseek-ai/*` ones.
 *
 * WHY THIS IS NOT THE V1 RECORDER. The archived recorder
 * (`qualification/results/V1-identity/id01-graph-recorder.mjs`) filters inside the
 * hook: it only appends a line when `specifier.startsWith('@deepseek-ai/')`. That
 * filter is the one thing standing between the instrument and the answer, and a
 * filter is exactly where a defect hides -- a specifier that resolves into a source
 * tree by some other spelling would never be written down, and the resulting
 * artifact would read as "no offender" rather than "not looked at".
 *
 * So this recorder writes EVERY resolution and lets the READER filter. It is
 * deliberately less clever than the instrument it is checking: no classification, no
 * prefix test, no opinion. The cost is a larger file, which is not a cost.
 *
 * WHY A SYNC APPEND. `registerHooks`'s resolve hook is synchronous by contract; an
 * async write could interleave with the boot and lose or reorder lines. Each row is
 * one JSON line appended as it happens, so a host that dies mid-boot still leaves the
 * resolutions it performed.
 *
 * WHAT IT DOES NOT DO. It does not decide a verdict, it does not short-circuit
 * (`shortCircuit` is left false, so the boot is byte-for-byte the boot it would have
 * been), and it does not touch the module it resolves. It is a recorder.
 *
 * @module c4-all-resolutions-recorder
 */
import { appendFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

const outPath = process.env.C4_GRAPH_OUT

if (outPath === undefined || outPath === '') {
  // Refusing loudly is the point: a recorder with nowhere to write would produce a
  // boot with no graph, which reads as "no resolutions happened" rather than "the
  // recorder was misconfigured".
  process.stderr.write('c4-all-resolutions-recorder: C4_GRAPH_OUT is not set; refusing to run silently\n')
} else {
  const started = Date.now()
  let sequence = 0
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      let line
      try {
        line = JSON.stringify({
          seq: sequence++,
          atMs: Date.now() - started,
          specifier,
          url: resolved.url,
          parentURL: context.parentURL ?? null,
          shortCircuit: false,
        })
      } catch (error) {
        line = JSON.stringify({ seq: sequence++, specifier, error: String(error) })
      }
      try {
        appendFileSync(outPath, `${line}\n`)
      } catch {
        // A failed write must not break the boot. The reader treats a missing or
        // truncated file as a failed measurement, not as an empty graph.
      }
      return resolved
    },
  })
}
