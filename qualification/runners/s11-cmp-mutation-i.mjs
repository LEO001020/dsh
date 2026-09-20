/**
 * Mutation I — the FIXED-OUTPUT-PATH trap, which is what the `provenance` group
 * exists to catch.
 *
 * WHY THIS MUTATION AND NOT ANOTHER. Every other group in MEASUREMENT.json is
 * already reached by a mutation. `provenance` is the group that asks "is this
 * artifact about the home THIS wave booted", and the only way to reach it is to
 * make the artifact name a DIFFERENT home -- which is exactly the G-FIX-13
 * failure: a probe writing to a fixed path is a shared mutable resource, so a
 * caller can read another writer's result and report it as its own.
 *
 * A mutation that merely deleted a field would also flip the group, but it would
 * not demonstrate that the check catches the REAL failure mode. This one does.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const DIR = 'D:/DSH/work/wt-s11/qualification/results/S11-cmp'

function run() {
  try {
    return execFileSync(process.execPath, ['qualification/runners/s11-cmp-verdict.mjs'], { encoding: 'utf8' })
  } catch (error) {
    return String(error.stdout ?? '') + String(error.stderr ?? '')
  }
}

function parse(stdout) {
  const match = /=== VERDICTS[^}]*\{([^}]*)\}/.exec(stdout)
  return match ? JSON.parse(`{${match[1]}}`) : 'PARSE FAILED'
}

const real = readFileSync(`${DIR}/healthy-probe.json`, 'utf8')
const mutated = JSON.parse(real)
// R1's home, which is NOT the home this wave booted. If the verdict script only
// checked "presetRoots is non-empty" this would pass.
mutated.presetRoots = [
  { path: 'D:\\DSH\\src\\dsh-src\\packages\\preset\\agent-presets\\presets\\', trust: 'system' },
  { path: 'D:/DSH/home/r1/profiles/daily/presets/', trust: 'system' },
  { path: 'D:\\DSH\\home\\r1\\.agent-presets', trust: 'user' },
]
writeFileSync(`${DIR}/mutation/I-foreign-home.json`, `${JSON.stringify(mutated, null, 1)}\n`, 'utf8')

writeFileSync(`${DIR}/healthy-probe.json`, `${JSON.stringify(mutated, null, 1)}\n`, 'utf8')
const withMutation = parse(run())
writeFileSync(`${DIR}/healthy-probe.json`, real)
const restored = parse(run())

writeFileSync(`${DIR}/mutation/RESULTS-4.json`, `${JSON.stringify({
  note: 'Mutation I targets the provenance group by making the artifact name ANOTHER home (the G-FIX-13 fixed-output-path trap). RESTORED-UNMUTATED is the control.',
  mutations: { 'I-foreign-home': withMutation, 'RESTORED-UNMUTATED': restored },
}, null, 1)}\n`, 'utf8')

console.log('I-foreign-home:', JSON.stringify(withMutation))
console.log('restored:', JSON.stringify(restored))
