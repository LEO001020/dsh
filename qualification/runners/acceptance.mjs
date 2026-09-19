/**
 * Acceptance runner CLI (M9.1).
 *
 * Runs ONE acceptance definition from a JSON file and writes a receipt. The
 * implementation lives in the package so it is covered by the package's tests;
 * this file is only the command-line surface.
 *
 *   node qualification/runners/acceptance.mjs <definition.json> [--out receipt.json] [--keep-snapshot]
 *   node qualification/runners/acceptance.mjs <definition.json> --print-digest
 *   node qualification/runners/acceptance.mjs <definition.json> --check <receipt.json>
 *   node qualification/runners/acceptance.mjs <definition.json> --cas <ref> <expected-sha>
 *
 * Exit codes, which are the machine-readable half of the contract:
 *   0  the acceptance PASSED
 *   1  it did not pass (fail, timeout, zero tests, unknown, ...)
 *   2  the invocation or the definition file itself was unusable
 *
 * Exit 2 is deliberately distinct: a malformed definition is an operator error,
 * not a verdict about the candidate, and collapsing the two would let a broken
 * invocation read as a failed candidate.
 *
 * --check re-verifies a stored receipt against the tree on disk. That is what
 * makes a receipt a statement about a tree rather than a note that something
 * once passed (F03).
 *
 * --cas reads an integration ref and compares it with the sha the candidate was
 * verified against. It only ever reads: there is no force path here, so a moved
 * ref is a refusal (F08).
 *
 * The definition file is JSON with these fields (see AcceptanceDefinition in
 * packages/dsh-daily-work/src/verify.ts for the authoritative shape):
 *
 *   {
 *     "id": "M9.1-example",
 *     "command": ["node", "some-runner.mjs", "run"],
 *     "cwd": "D:/path/to/candidate",
 *     "inputs": ["src", "package.json"],
 *     "expectedExitCode": 0,
 *     "timeoutMs": 120000,
 *     "expectTests": { "passed": 30 },
 *     "testReporter": "vitest",
 *     "authorizedDigest": "<sha256 from --print-digest>"
 *   }
 *
 * `--print-digest` is how `authorizedDigest` is obtained. It is a deliberate
 * two-step: the digest has to be recorded by a human or a separate, reviewed
 * step, so a definition cannot authorize itself in the same breath as it is
 * written. An acceptance that changes its own threshold then fails the digest
 * check rather than quietly going green (F05).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const VERIFY_MODULE = pathToFileURL(
  resolve(REPO_ROOT, 'packages', 'dsh-daily-work', 'src', 'verify.ts'),
).href

/** Print a usage error and exit 2. */
function usage(message) {
  process.stderr.write(`acceptance: ${message}\n`)
  process.stderr.write(
    'usage: node qualification/runners/acceptance.mjs <definition.json> [--out <receipt.json>] [--keep-snapshot]\n'
    + '       node qualification/runners/acceptance.mjs <definition.json> --print-digest\n'
    + '       node qualification/runners/acceptance.mjs <definition.json> --check <receipt.json>\n'
    + '       node qualification/runners/acceptance.mjs <definition.json> --cas <ref> <expected-sha>\n',
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
if (argv.length === 0) usage('a definition file is required')
const definitionPath = argv[0]
const flag = (name) => argv.includes(name)
const flagValue = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

let definition
try {
  definition = JSON.parse(readFileSync(resolve(definitionPath), 'utf8'))
} catch (error) {
  usage(`the definition file could not be read as JSON: ${error.message}`)
}

const verify = await import(VERIFY_MODULE)

if (flag('--print-digest')) {
  // The digest of the definition as written, so it can be recorded separately
  // and pasted back in as authorizedDigest.
  process.stdout.write(`${verify.acceptanceDefinitionDigest(definition)}\n`)
  process.exit(0)
}

if (flag('--cas')) {
  const ref = argv[argv.indexOf('--cas') + 1]
  const expectedSha = argv[argv.indexOf('--cas') + 2]
  if (ref === undefined || expectedSha === undefined) usage('--cas needs a ref and an expected sha')
  const result = await verify.refCas({ cwd: definition.cwd, ref, expectedSha })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.accepted ? 0 : 1)
}

if (flag('--check')) {
  const receiptPath = flagValue('--check')
  if (receiptPath === undefined) usage('--check needs a receipt path')
  const receipt = JSON.parse(readFileSync(resolve(receiptPath), 'utf8'))
  const freshness = verify.receiptFreshness(receipt, definition)
  process.stdout.write(`${JSON.stringify(freshness, null, 2)}\n`)
  if (!freshness.fresh) {
    process.stderr.write('acceptance: the stored receipt does not describe the current tree; re-verify\n')
    process.exit(1)
  }
  // A fresh receipt still has to have PASSED. Freshness alone is not a verdict.
  process.exit(receipt.passed === true ? 0 : 1)
}

const receipt = await verify.runAcceptance(definition, { keepSnapshot: flag('--keep-snapshot') })
const outPath = flagValue('--out')
const serialized = verify.serializeReceipt(receipt)
if (outPath !== undefined) writeFileSync(resolve(outPath), serialized, 'utf8')
process.stdout.write(serialized)

// The verdict goes to stderr so stdout stays a clean receipt for a pipe.
process.stderr.write(
  `acceptance: ${definition.id} -> ${receipt.outcome} (${receipt.passed ? 'PASS' : 'NOT PASS'})\n`
  + receipt.reasons.map(reason => `  - ${reason}\n`).join(''),
)
process.exit(receipt.passed ? 0 : 1)
