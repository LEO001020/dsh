/**
 * Regenerate the A10 boundary transcripts: the raw CLI stream and the persisted
 * Session for each scripted outcome.
 *
 * The vitest suite runs the same three scripts itself and asserts against both
 * surfaces live, so `tests.txt` is the authoritative evidence. These files exist
 * so a reader can see the actual bytes without running anything: the bounded
 * `tool_result` line next to the full Session record is the whole point of the
 * gate, and it is easier to read as two files than as an assertion.
 *
 * Each run uses a throwaway `$DSH_HOME` and a scratch patch directory INSIDE
 * this package, because the scripted adapter is a TypeScript module importing
 * `@deepseek-ai/dsh-llm` and Node resolves those bare specifiers by walking up
 * from the FILE's directory.
 *
 * Usage: node make-a10-runs.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DSH_SRC = 'D:/DSH/src/dsh-src'
const LAUNCHER = `${DSH_SRC}/apps/cli/lib/bin.js`
const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/M9.14-profile-config/runs'

const OVERLAY = [
  '- id: llm-deepseek',
  '  disabled: true',
  '',
  '- id: agent-default-model',
  '  config:',
  '    provider: cli-mock',
  '    model: cli-mock',
  '',
  '- id: session-persistence-jsonl',
  '  config:',
  '    root: !!js process.env.M914_SESSION_ROOT',
  '    compression: none',
  '',
  '- id: agent-instructions',
  '  disabled: true',
  '',
  '- insert:',
  '    - id: cli-mock-llm',
  "      name: './m914-mock-llm.ts'",
  '',
].join('\n')

const ADAPTER = readFileSync(
  'D:/DSH/work/dsh-native-daily/qualification/results/M9.14-profile-config/patches/m914-mock-llm.ts',
  'utf8',
)

function run(script, label) {
  const home = mkdtempSync('D:/DSH/work/dsh-native-daily/.m914-a10home-')
  const patchDir = mkdtempSync(join(PKG, '.m914-a10-'))
  const sessionRoot = join(OUT, `a10-${label}`, 'sessions')
  mkdirSync(sessionRoot, { recursive: true })

  const profileDir = join(home, 'profiles', 'headless')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-headless',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

  writeFileSync(join(patchDir, 'overlay.patch.yml'), OVERLAY)
  writeFileSync(join(patchDir, 'm914-mock-llm.ts'), ADAPTER)

  const result = spawnSync(process.execPath, [
    LAUNCHER, '--profile', 'headless', '--patch', join(patchDir, 'overlay.patch.yml'),
    '--json', `m914 ${label}`,
  ], {
    cwd: DSH_SRC,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      M914_SCRIPT: script,
      M914_SESSION_ROOT: sessionRoot,
    },
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  })

  writeFileSync(join(OUT, `a10-${label}`, 'stdout.jsonl'), result.stdout ?? '')
  writeFileSync(join(OUT, `a10-${label}`, 'stderr.txt'), result.stderr ?? '')
  writeFileSync(join(OUT, `a10-${label}`, 'exit.txt'), `exit=${String(result.status)}\nscript=${script}\n`)

  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  walk(sessionRoot)
  process.stdout.write(`${label}: exit=${String(result.status)} session=${String(files.length)} stdout=${String((result.stdout ?? '').length)}B\n`)

  rmSync(home, { recursive: true, force: true })
  rmSync(patchDir, { recursive: true, force: true })
}

run('tool-then-answer', 'smoke')
run('huge-output', 'huge-output')
run('business-failure', 'business-failure')
