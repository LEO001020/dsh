/**
 * Regenerate every `--dump-config` artifact this gate directory cites.
 *
 * Each dump is taken with the REAL built launcher over a throwaway `$DSH_HOME`
 * built here, so the artifacts are reproducible rather than hand-captured. The
 * launcher is the qualified built artifact; `--dump-config` composes through the
 * same single `applyEntryPatches` call the boot include makes and never boots the
 * app, so no credential and no network are involved.
 *
 * Usage: node make-dumps.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DSH_SRC = 'D:/DSH/src/dsh-src'
const LAUNCHER = `${DSH_SRC}/apps/cli/lib/bin.js`
const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M9.14-profile-config/dumps'
const HOME = 'D:/DSH/home/m914'

const WEB = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const HEADLESS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']

function profile(name, bundles, userLayer, dependencies = {}) {
  const dir = join(HOME, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles: [...bundles] } },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), userLayer ?? '# this profile adds nothing of its own\n[]\n')
  return dir
}

function dump(label, args) {
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: DSH_SRC,
    env: { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`${label} failed (${String(result.status)}): ${result.stderr}`)
  writeFileSync(join(OUT, `${label}.yml`), result.stdout)
  writeFileSync(join(OUT, `${label}.err`), result.stderr)
  process.stdout.write(`${label}: ${String(result.stdout.length)} bytes, stderr ${String(result.stderr.length)} bytes\n`)
}

mkdirSync(OUT, { recursive: true })
// The two home-layer files this script writes are the A05 stimulus. They are
// removed first so a leftover from an earlier run cannot silently become the
// baseline for a dump that is supposed to have no home layer.
rmSync(join(HOME, 'cordis.patch.yml'), { force: true })

// A04: the stock row, then the same row with ONE field changed.
profile('m914-a04', HEADLESS)
writeFileSync(join(HOME, 'a04-one-field.yml'), [
  '# A04: change exactly ONE field of ONE row.',
  '- id: session-query-sqlite',
  '  config:',
  '    openAt: first-search',
  '',
].join('\n'))
dump('a04-stock-row', ['--profile', 'm914-a04', '--dump-config'])
dump('a04-one-field', ['--profile', 'm914-a04', '--dump-config', '--patch', join(HOME, 'a04-one-field.yml')])

// A05: the same profile under a clean home and under a polluted one. The two
// dumps differ ONLY by the home layer, which is the whole claim.
const POLLUTION = [
  '# A05: a home overlay that changes the model route AND the preset roster.',
  '- id: agent-default-model',
  '  config:',
  '    provider: polluted-provider',
  '    model: polluted-model',
  '',
  '- id: agent-presets',
  '  config:',
  '    default: polluted-preset',
  '',
].join('\n')
profile('m914-a05', WEB)
dump('a05-clean-home', ['--profile', 'm914-a05', '--dump-config'])
dump('a05-clean-home-default-only', ['--profile', 'm914-a05', '--dump-default-config'])
writeFileSync(join(HOME, 'cordis.patch.yml'), POLLUTION)
dump('a05-polluted-home', ['--profile', 'm914-a05', '--dump-config'])
dump('a05-polluted-home-default-only', ['--profile', 'm914-a05', '--dump-default-config'])
rmSync(join(HOME, 'cordis.patch.yml'), { force: true })

// A08: C0 (bundles only) against C2 (the two documented differences).
profile('m914-c0', WEB)
profile('m914-c2', WEB, [
  '# Difference 1: raise the continuable-child capacity to the user N=10.',
  '- id: subagent',
  '  config:',
  '    maxActiveSubagents: 10',
  '    maxDepth: 1',
  '',
  '# Difference 2: mount the work extension host service.',
  '- insert:',
  '    - id: daily-work-host',
  '      name: dsh-daily-work/host',
  '      config:',
  '        targetChildren: 10',
  '        maxDepth: 1',
  '        budgetCeiling: 200',
  '        currency: USD',
  '        priceVersion: unversioned-2026-09-19',
  '',
].join('\n'))
dump('a08-c0', ['--profile', 'm914-c0', '--dump-config'])
dump('a08-c2', ['--profile', 'm914-c2', '--dump-config'])

// A12: the daily composition's own resolved graph, so the profile the host
// boots can be read next to the host transcript. The dependency on the work
// extension is declared here exactly as the delivered template declares it
// (profiles/daily-candidate), so this graph is the composition the host ran.
profile('m914-daily', WEB, null, {
  'dsh-daily-work': 'link:D:/DSH/work/dsh-native-daily/packages/dsh-daily-work',
})
writeFileSync(join(HOME, 'profiles', 'm914-daily', 'cordis.patch.yml'),
  (await import('node:fs')).readFileSync(
    'D:/DSH/work/dsh-native-daily/profiles/daily-candidate/cordis.patch.yml', 'utf8'))
dump('a12-daily-profile', ['--profile', 'm914-daily', '--dump-config'])

// A12 boundary: the SDK profile shares the same llm-deepseek row, so its
// resolved route is recorded here too.
profile('m914-sdk', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'])
dump('a12-sdk-profile', ['--profile', 'm914-sdk', '--dump-config'])

process.stdout.write('done\n')
