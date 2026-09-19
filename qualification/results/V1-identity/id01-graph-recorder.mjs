/**
 * ID-01 graph recorder: record EVERY `@deepseek-ai/*` resolution the booted host
 * performs, from inside the host process, by hooking the loader.
 *
 * WHY A LOADER HOOK AND NOT A PATH CHECK.
 * The oracle asks whether "every `@deepseek-ai/*` specifier resolves under
 * `D:\DSH\src\dsh-src\packages\*\lib\`" and whether "the graph mixes src and
 * lib". T17 answered a narrower version of that question by testing
 * `instanceof` against six hand-listed packages. That is a good instrument but a
 * NARROW one: it can only speak about packages somebody thought to list, and its
 * silence about package seven is indistinguishable from package seven being
 * fine. This hook records the resolution of EVERY such specifier as the host
 * actually performs it, so the answer is a complete list rather than a sample.
 *
 * WHY `registerHooks` AND NOT `--experimental-loader`.
 * Node 24 exposes `module.registerHooks()`, a synchronous in-process hook. A
 * separate loader thread would be a second process and could not see the host's
 * resolutions without a message channel. This runs inside the host.
 *
 * WHY IT WRITES INCREMENTALLY AND NEVER THROWS.
 * A hook that throws breaks the boot it is measuring, and a hook that buffers
 * everything loses the record exactly when the host dies -- which is the
 * interesting case. Each resolution is appended as one JSON line as it happens.
 * `appendFileSync` is deliberate: the hook is synchronous by contract, so an
 * async write could interleave with the boot and reorder or lose lines.
 *
 * WHAT IT DOES NOT DO. It does not decide the verdict, it does not classify
 * paths (the driver does that, so the classification is testable on its own),
 * and it does not touch the module it resolves. It is a recorder.
 *
 * @module v1-id01-graph-recorder
 */
import { appendFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

const outPath = process.env.V1_GRAPH_OUT

if (outPath === undefined || outPath === '') {
  // Refusing loudly is the point: a recorder with nowhere to write would
  // silently produce a boot with no graph, which reads as "no resolutions
  // happened" rather than "the recorder was misconfigured".
  process.stderr.write('v1-id01-graph-recorder: V1_GRAPH_OUT is not set; refusing to run silently\n')
} else {
  const started = Date.now()
  let sequence = 0
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      // Only the deployment's own scope is recorded. `node:*` and every
      // third-party specifier are noise here and would bury the answer.
      if (specifier.startsWith('@deepseek-ai/')) {
        let line
        try {
          line = JSON.stringify({
            seq: sequence++,
            atMs: Date.now() - started,
            specifier,
            url: resolved.url,
            parentURL: context.parentURL ?? null,
            // `shortCircuit` is left false: this hook OBSERVES and does not
            // substitute, so the boot is byte-for-byte the boot it would have
            // been without the recorder. That is what makes the measurement
            // non-invasive.
            shortCircuit: false,
          })
        } catch (error) {
          line = JSON.stringify({ seq: sequence++, specifier, error: String(error) })
        }
        try {
          appendFileSync(outPath, `${line}\n`)
        } catch {
          // A failed write must not break the boot. The driver treats a missing
          // or truncated file as a failed measurement, not as an empty graph.
        }
      }
      return resolved
    },
  })
}
