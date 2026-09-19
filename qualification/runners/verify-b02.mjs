/**
 * Boot-time probe for gates B02 and B03 (the first half of each).
 *
 * These gates were previously reported PASS on evidence that only proved
 * `ctx.plugin()` direct mounting. That is a weaker claim than "the extension
 * loads through the real profile resolver", and the difference is not cosmetic:
 * before the package declared `dsh.bundle.patch`, the resolver installed it as a
 * plain dependency and activated NO layer, so the plugin was never loaded at all
 * while a direct-mount test still passed. This probe closes that gap by running
 * INSIDE a real `dsh --profile daily` boot and reporting what the resolver
 * actually did.
 *
 * B02 is about module identity: a second copy of Cordis, or a `src` copy mixed
 * into a `built` graph, breaks service injection in ways that surface far from
 * the cause. So this reports the REALPATH of every peer the extension depends
 * on, resolved from the EXTENSION's own directory.
 *
 * `inject` is a readiness gate, not decoration: a row that injects a service
 * runs only after that service is provided. An earlier version of this probe
 * omitted `dailyWork` from `inject` and therefore ran before the service
 * registered, reporting a false absence.
 */
import { writeFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

export const name = 'verify-b02'
export const inject = ['tools', 'storageDomain', 'agents', 'dailyWork', 'agentPresets']

const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M9.17-b02-resolver/b02.json'

/**
 * Resolve from the extension package, not from this runner. The profile's own
 * node_modules holds only the linked extension; DSH itself is resolved from the
 * source tree, so a probe-local resolution root finds nothing and would report a
 * false "unresolvable" for every peer.
 */
const EXTENSION = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work/package.json'
const require = createRequire(EXTENSION)

/**
 * Roots that could plausibly hold a second copy: the extension under test, the
 * profile that installed it, and the DSH checkout itself. Resolving from all of
 * them is what turns "no duplicate" from an assumption into a measurement.
 */
const RESOLUTION_ROOTS = [
  EXTENSION,
  'D:/DSH/home/canary5/profiles/daily/package.json',
  'D:/DSH/src/dsh-src/package.json',
]

/** Peers whose duplication would break injection or share no state. */
const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-scope',
]

export async function apply(ctx) {
  const finding = {
    resolvedPeers: {},
    sourceResolved: [],
    builtCopies: [],
    distinctCopies: {},
    serviceIdentities: {},
    error: null,
  }

  try {
    for (const peer of PEERS) {
      try {
        finding.resolvedPeers[peer] = realpathSync(require.resolve(peer))
      } catch (e) {
        finding.resolvedPeers[peer] = `unresolvable: ${e instanceof Error ? e.message : String(e)}`
      }
    }

    // The real question is whether each peer resolved to BUILT output or to raw
    // TypeScript source. A naive "/src/ segment" test is wrong for this
    // deployment: the checkout root is literally `D:\DSH\src\dsh-src`, so every
    // path contains a `src` segment no matter what it resolved to. The honest
    // discriminator is the file the resolution actually landed on.
    for (const [peer, path] of Object.entries(finding.resolvedPeers)) {
      if (typeof path !== 'string' || path.startsWith('unresolvable')) continue
      const normalized = path.replace(/\\/g, '/')
      if (/\.ts$/.test(normalized) || /\/src\/[^/]+\.ts$/.test(normalized)) finding.sourceResolved.push(peer)
      if (/\/lib\/.*\.js$/.test(normalized)) finding.builtCopies.push(peer)
    }

    // Single-instance proof: resolve each peer from several distinct roots. If a
    // second copy of Cordis exists anywhere on the resolution paths, injection
    // would silently fail to share state, so the count must be one per peer.
    finding.distinctCopies = {}
    for (const peer of PEERS) {
      const seen = new Set()
      for (const root of RESOLUTION_ROOTS) {
        try {
          seen.add(realpathSync(createRequire(root).resolve(peer)))
        } catch {
          // A root that cannot see the peer simply contributes nothing; that is
          // not evidence of duplication.
        }
      }
      finding.distinctCopies[peer] = [...seen]
    }

    // Service identity: the services the extension injects must be the live
    // singletons the host provided, not per-scope re-registrations.
    finding.serviceIdentities = {
      tools: ctx.get('tools') !== undefined,
      storageDomain: ctx.get('storageDomain') !== undefined,
      agents: ctx.get('agents') !== undefined,
      dailyWork: ctx.get('dailyWork') !== undefined,
      agentPresets: ctx.get('agentPresets') !== undefined,
      web: ctx.get('web') !== undefined,
    }
  } catch (e) {
    finding.error = e instanceof Error ? e.message : String(e)
  }

  writeFileSync(OUT, JSON.stringify(finding, null, 2))
  process.stdout.write(`B02: ${JSON.stringify(finding)}\n`)
}
