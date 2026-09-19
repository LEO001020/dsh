/**
 * Boot-time probe for the M2 programmatic-call scope service.
 *
 * WHY A BOOT PROBE AND NOT A TEST. `src/programmatic-scope.test.ts` mounts the
 * scope with `ctx.plugin` inside vitest. That proves the scope works; it proves
 * NOTHING about whether the shipped profile loads it. This project has shipped
 * that exact defect three times (docs/GAPS.md G-FIX-04, G-FIX-05): a capability
 * whose only caller was a test, and a plugin with no `dsh.bundle.patch` that
 * never activated at all while its test passed. So this probe runs INSIDE a real
 * `dsh --profile daily` boot and reports what the resolver actually did.
 *
 * NO IMPORTS FROM DSH PACKAGES, deliberately. A probe file under
 * `qualification/runners/` has no node_modules of its own, so a bare specifier
 * like `@deepseek-ai/dsh-tools` fails to resolve at boot and the loader reports
 * "failed to import" — which is a property of the probe, not of the product. An
 * earlier version of this file made exactly that mistake and produced a warning
 * that looked like a product defect. Everything here goes through `ctx`.
 *
 * WHAT IT MEASURES, in the order the failure modes actually occur:
 *   1. The service is present on the live context (`ctx.programmaticScope`).
 *      A row that resolves but throws on mount shows up here as absent.
 *   2. It reports the interface a consumer needs — `open`, `close`, `closeAll`,
 *      `openCount`, `store` — so "it mounted" is not confused with "it is
 *      usable".
 *   3. It opens a REAL scope over the LIVE registry and invokes a REAL tool
 *      through it, so the probe exercises the same pipeline a `python_exec`
 *      cell will. The tool is registered by the probe into the live registry,
 *      so nothing stock is touched and the probe cannot pass by finding a
 *      pre-existing tool.
 *   4. It reports the disposition accounting BRG-07 rests on.
 *
 * `inject` is a readiness gate, not decoration: a row that injects a service
 * runs only after that service is provided. An earlier probe in this project
 * omitted a service from `inject` and ran before it registered, reporting a
 * false absence.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-m2-scope'
export const inject = ['tools', 'programmaticScope']

const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M2-scope/boot-probe.json'

export async function apply(ctx) {
  // `ctx.get(...)` is the accessor that works from a row that declared `inject`;
  // a bare property read (`ctx.tools`) is refused by Cordis for a context that
  // did not inject it. Measured: the first version of this probe used `ctx.tools`
  // and reported 'cannot get property "tools" without inject'.
  const tools = ctx.get('tools')
  const report = {
    probe: 'M2-scope',
    ranAt: new Date().toISOString(),
    servicePresent: false,
    interface: [],
    registeredTool: false,
    valueDelivery: undefined,
    referenceDelivery: undefined,
    dispositions: undefined,
    errors: [],
  }

  try {
    const service = ctx.get('programmaticScope')
    report.servicePresent = service !== undefined
    if (service === undefined) {
      report.errors.push('ctx.programmaticScope is absent: the profile row did not mount the service')
    } else if (tools === undefined) {
      report.errors.push('ctx.tools is absent: the probe cannot exercise the pipeline')
    } else {
      // What a consumer can actually call. A mounted service missing these would
      // satisfy "the row resolved" and still fail its consumer.
      report.interface = ['open', 'close', 'closeAll', 'openCount', 'store']
        .map(member => `${member}:${typeof service[member]}`)

      // A real tool, registered into the LIVE registry by this probe. `defineTool`
      // is reached through the registry's own `register` contract via a plain
      // object: the loader validates the definition, so a malformed one fails
      // here rather than silently passing.
      tools.register({
        name: 'm2_scope_probe',
        description: 'Boot probe target for the programmatic-call scope.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { value: { type: 'string', required: true } },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: args => Promise.resolve(`probe:${args.value}`),
      })
      report.registeredTool = tools.get('m2_scope_probe') !== undefined

      // The enclosing execution's own capabilities, as a transport tool supplies
      // them. `parent` is the HOST's token; this probe stands in for a transport
      // execution it is not, and records that rather than implying it minted one.
      const deferred = []
      let conclusions = 0
      const scope = service.open({
        parent: Symbol('boot-probe.parent'),
        signal: new AbortController().signal,
        callIdPrefix: 'boot-probe',
        deferContext: context => { deferred.push(context) },
        concludeTurn: () => { conclusions += 1 },
      })

      report.valueDelivery = await scope.invoke('m2_scope_probe', { value: 'value-route' }, 'value')

      const reference = await scope.invoke('m2_scope_probe', { value: 'reference-route' }, 'reference')
      const stored = await scope.read(reference)
      report.referenceDelivery = {
        kind: reference.kind,
        bytes: reference.bytes,
        // Whether the retained bytes recover the post-policy canonical value.
        recovers: typeof stored === 'string' && stored.includes('probe:reference-route'),
      }

      await service.close(scope, 'completed')
      report.dispositions = scope.dispositions().map(entry => ({
        name: entry.name, disposition: entry.disposition, nested: entry.nested,
      }))
      report.openAfterClose = service.openCount()
      report.notices = scope.notices().length
      report.content = scope.content().length
      report.conclusions = conclusions
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
  }

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  // Never fail the boot: this probe records, it does not gate.
  return undefined
}
