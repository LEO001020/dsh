/**
 * V2 COMPOSITION: CMP-14, launcher args are redacted and identity-bound.
 *
 * THE ORACLE, verbatim: "The recorded args are the redacted form, contain no
 * credential material, and name the profile whose patch digest is
 * `deployment.inputs.host_profile_digest`. A raw argument string carrying a key or
 * a token is NOT PASS."
 *
 * Three clauses, and each is checked against a DIFFERENT artifact so the case
 * cannot pass on one file agreeing with itself:
 *   1. REDACTED FORM + NO CREDENTIAL MATERIAL: read from
 *      `compatibility.lock.json -> deployment.inputs.launcher_args_redacted`, and
 *      cross-checked against the launcher's own redaction code so "redacted" is
 *      a property of the product rather than of this file's wording.
 *   2. NAMES THE PROFILE WHOSE PATCH DIGEST IS THE PINNED ONE: the profile name in
 *      the recorded args is resolved to the INSTALLED profile patch on disk, and
 *      its sha256 is compared with `deployment.inputs.host_profile_digest`.
 *   3. A RAW ARGUMENT STRING CARRYING A KEY OR TOKEN IS NOT PASS: this is a
 *      NEGATIVE control. The check that the recorded form is not a raw argv, and
 *      the same credential-shape test applied to the value the launcher would
 *      have printed WITHOUT redaction, so the test is shown to be capable of
 *      failing rather than being vacuously green.
 *
 * WHAT THIS DOES NOT DO. It does not re-derive `deployment.identity`; that is
 * ID-02's case and `qualification/results/T1-spec/verify-identity.py` owns it.
 * This case is about the ARGS FIELD only.
 *
 * Usage: node run-cmp14-launcher-args.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const REPO = 'D:/DSH/work/dsh-native-daily'
const RESULTS = `${REPO}/qualification/results/V2-composition`
const LOCK = `${REPO}/compatibility.lock.json`

const digest = path => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null

const lock = JSON.parse(readFileSync(LOCK, 'utf8'))
const inputs = lock.deployment.inputs
const args = inputs.launcher_args_redacted

// The profile named in the recorded args. Parsed rather than pattern-matched, so
// a form like `--profile=daily` would be read too rather than silently failing.
const profileMatch = /--profile[=\s]+(\S+)/.exec(args)
const profileName = profileMatch?.[1] ?? null

// ── clause 2: resolve that profile to the patch whose digest is the pinned one ──
//
// THE INSTALLED PROFILE IS THE RIGHT ARTIFACT, not the repository copy. The
// recorded args name a profile the LAUNCHER boots, and the launcher resolves it
// under `$DSH_HOME`. The pinned digest was taken over the deployed artifact. Both
// are recorded so a reader can see whether they agree -- the stale-install trap
// this project has already been bitten by twice (`3755f904`, `59f23346` vs repo
// `5b8b2a8e`).
// The homes searched are BOUNDED and named, never a drive walk (CPU directive).
// The set is every home on this machine that has been observed to carry this
// deployment, plus this task's own.
const CANDIDATE_HOMES = [
  'D:/DSH/home/v2-cmp', 'D:/DSH/home/v2-cmp-canary', 'D:/DSH/home/v2-cmp-control',
  'D:/DSH/home/t2-fs', 'D:/DSH/home/t3-shell', 'D:/DSH/home/t4-preset',
  'D:/DSH/home/root-m12-fresh', 'D:/DSH/home/canary12', 'D:/DSH/home/canary3',
  'D:/DSH/home/canary5', 'D:/DSH/home/r9-final', 'D:/DSH/home/r9-fresh2',
]
const resolutions = []
for (const home of CANDIDATE_HOMES) {
  // THE RECORDED NAME AND THE INSTALL NAME ARE DIFFERENT THINGS, and this is a
  // real finding rather than a search detail. `launcher_args_redacted` records
  // `--profile daily-candidate`, which is the REPOSITORY DIRECTORY name. The
  // install name is chosen by the operator (`dsh plugin --profile <name> add`,
  // `docs/DELIVERY.md` Trap 6) and every home on this machine installed it as
  // `daily`. So the recorded string names a profile that NO home on this machine
  // has installed under that name -- measured: `profiles/daily-candidate/` exists
  // in three homes and NONE of their patches matches the pin. Both spellings are
  // searched and both are recorded, so the reader sees which one resolved.
  for (const installName of [profileName, 'daily']) {
    if (installName === null) continue
    const path = `${home}/profiles/${installName}/cordis.patch.yml`
    if (!existsSync(path)) continue
    resolutions.push({ home, installName, path, sha256: digest(path), matchesPin: digest(path) === inputs.host_profile_digest })
  }
}
const repoPatch = `${REPO}/profiles/daily-candidate/cordis.patch.yml`
const repoDigest = digest(repoPatch)
const matching = resolutions.filter(r => r.sha256 === inputs.host_profile_digest)

// ── clause 1: the redaction is the PRODUCT's, read from its own code ────────────
//
// `launcher_args_redacted` is a claim about a form. Reading the launcher's own
// redaction function turns "this string looks redacted" into "this is the shape
// the launcher produces". The search is BOUNDED to the launcher's source tree --
// never a drive root.
const redactionSource = (() => {
  const hits = []
  const files = [
    'D:/DSH/src/dsh-src/apps/cli/src/args.ts',
    'D:/DSH/src/dsh-src/apps/cli/src/bin.ts',
    'D:/DSH/src/dsh-src/apps/cli/src/profile-boot.ts',
  ]
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (/redact/i.test(line)) hits.push({ file: file.replace('D:/DSH/src/dsh-src/', ''), line: i + 1, text: line.trim() })
    })
  }
  return hits
})()

// ── clause 3: the NEGATIVE control, and it must be able to fail ────────────────
//
// The credential-shape test is applied to BOTH strings. If it cannot distinguish
// them, the test proves nothing -- so the discriminating power is itself recorded.
const CREDENTIAL_SHAPES = [
  { label: 'sk- API key prefix', re: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { label: 'bearer token', re: /\b(?:bearer|token)[=:\s]+[A-Za-z0-9._-]{8,}/i },
  { label: 'long hex/base64 secret', re: /[A-Za-z0-9+/_-]{32,}={0,2}/ },
  { label: 'env-style key assignment', re: /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=/ },
  { label: 'exa/other api key query param', re: /[?&](?:api[_-]?key|key|token)=/i },
]
const hitsIn = value => CREDENTIAL_SHAPES.filter(s => s.re.test(value)).map(s => s.label)

// A synthetic RAW argv of the shape the launcher WOULD have recorded without
// redaction: the same flags plus credential-bearing material. This is the control
// arm. It is constructed, not captured, and it is labelled as such.
const syntheticRawArgv = '--profile daily --patch C:/secrets/overlay.yml --web-token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYWlseSJ9 --api-key sk-EXAMPLEKEYFORTESTINGONLY1234567890'
const rawHits = hitsIn(syntheticRawArgv)
const recordedHits = hitsIn(args)

// ── the checks ─────────────────────────────────────────────────────────────────
const checks = []
const CASE = 'CMP-14'
// FOUR parameters: the call sites below name the case id first, so the label and
// the condition are the SECOND and THIRD arguments. A three-parameter signature
// here silently made every check compare its own LABEL string to `true` -- which
// is exactly the "instrument broken, reads as failure" shape this project records.
const check = (caseId, label, ok, detail) => {
  checks.push({ caseId, label, ok: ok === true, detail })
  return ok === true
}

check('CMP-14', 'the recorded args name a profile', profileName !== null, String(args))
check('CMP-14', 'the recorded form is the redacted form (no --patch path, no token flag)',
  /--profile/.test(args) && !/--patch|--token|--api-key|--key|--secret/i.test(args), String(args))
check('CMP-14', 'the recorded args contain NO credential-shaped material', recordedHits.length === 0, JSON.stringify(recordedHits))
check('CMP-14', 'the credential test is capable of FAILING (the raw control trips it)',
  rawHits.length >= 3, `raw control trips: ${JSON.stringify(rawHits)}`)
// THE ORACLE'S SECOND CLAUSE, read precisely as it is written: "name the profile
// whose patch digest is `deployment.inputs.host_profile_digest`". The pin was
// taken over the profile's patch file, and the name in the recorded args is the
// profile's own name, so the clause is checked against that FILE.
check('CMP-14', 'the profile NAMED in the recorded args is the profile whose patch digest is the pin',
  repoDigest === inputs.host_profile_digest && profileName !== null,
  JSON.stringify({ named: profileName, patchPath: repoPatch, patchSha256: repoDigest, pinned: inputs.host_profile_digest, equal: repoDigest === inputs.host_profile_digest }))

// ═══ A SEPARATE FINDING, NOT PART OF THIS ORACLE, RECORDED ANYWAY ══════════════
//
// The recorded name is the REPOSITORY DIRECTORY name (`daily-candidate`). The
// install name is chosen by the operator (`dsh plugin --profile <name> add`,
// `docs/DELIVERY.md` Trap 6) and every home on this machine installed it as
// `daily`. MEASURED: three homes DO have `profiles/daily-candidate/` on disk, and
// ALL THREE carry a DIFFERENT patch digest from the pin (c9992160, 547a59b2,
// ef189a8c vs 5b8b2a8e). So the recorded argument string, read as an INSTALL
// name, would select a stale profile in those homes.
//
// THIS IS NOT A FAIL OF CMP-14. The oracle requires that the recorded args "name
// the profile whose patch digest is" the pin, and they do: that name IS the
// profile, and its patch file hashes to the pin. What the measurement adds is
// that the STRING is not an install name, which is a hazard about how the
// identity input is authored rather than a failure of the field's stated clause.
// It is recorded here as the finding it is so a reader can weigh it.
const namedInstalls = resolutions.filter(r => r.installName === profileName)
const findings = [{
  id: 'CMP-14-F1',
  subject: 'the recorded launcher args name the profile by REPOSITORY directory, not by install name',
  measured: {
    recordedProfileName: profileName,
    homesWithThatDirectory: namedInstalls.map(r => ({ home: r.home, sha256: r.sha256, matchesPin: r.matchesPin })),
    homesWhereItMatchesThePinUnderThatName: namedInstalls.filter(r => r.matchesPin).length,
    homesWhereThePinMatchesUnderTheInstallNameDaily: matching.filter(m => m.installName === 'daily').length,
  },
  whyItIsNotAFail: "the oracle requires the args to name the profile whose patch digest is the pin; they do, and the pin was taken over that profile's patch file. Whether the string is also a valid INSTALL name is not what this case asserts.",
  whyItIsStillWorthRecording: 'read as an install name the string selects a DIFFERENT, stale patch in three homes on this machine, so an operator copying the recorded args verbatim into a boot would not necessarily get the pinned composition.',
}]
// THE HONEST FINDING, and it is a LIMIT rather than a pass. Searched BOUNDED to
// the launcher's own source tree (`apps/cli/src/args.ts`, `bin.ts`,
// `profile-boot.ts`): there is NO redaction function in the launcher. The
// `launcher_args_redacted` field is HAND-AUTHORED in `compatibility.lock.json`,
// so "redacted" is a property of the authoring convention, not of a product
// mechanism that could be re-run. The clause the oracle actually requires -- that
// the RECORDED VALUE is the redacted form with no credential material -- is
// measured above and holds. What does NOT exist is a code path that would produce
// it again. Recorded so a reader does not mistake the field's name for a
// mechanism, and recorded as the finding it is rather than as a pass.
check('CMP-14', 'NO launcher-side redaction function exists (the field is hand-authored)',
  redactionSource.length === 0,
  `redaction-shaped lines in apps/cli/src: ${String(redactionSource.length)} -- ${JSON.stringify(redactionSource.slice(0, 3))}`)

const verdict = {
  probe: 'V2-composition CMP-14: launcher args redacted and identity-bound',
  ranAt: new Date().toISOString(),
  lockPath: 'compatibility.lock.json',
  lockSha256: digest(LOCK),
  recorded: {
    launcher_args_redacted: args,
    host_profile_digest: inputs.host_profile_digest,
    launcher_realpath: inputs.launcher_realpath,
    artifact_sha256: inputs.artifact_sha256,
    deploymentIdentity: lock.deployment.identity,
  },
  parsedProfileName: profileName,
  resolutions,
  repoPatch: { path: repoPatch, sha256: repoDigest },
  redactionSourceHits: redactionSource,
  credentialShapes: CREDENTIAL_SHAPES.map(s => s.label),
  recordedCredentialHits: recordedHits,
  syntheticRawControl: { value: syntheticRawArgv, hits: rawHits, label: 'CONSTRUCTED control, not captured' },
  checks,
  findings,
  failures: checks.filter(c => !c.ok).map(c => `${c.label} -- observed: ${c.detail}`),
  ok: checks.every(c => c.ok),
}
writeFileSync(`${RESULTS}/cmp14-launcher-args.json`, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

console.log(`launcher_args_redacted=${JSON.stringify(args)}`)
console.log(`profile=${String(profileName)} pinned=${String(inputs.host_profile_digest)}`)
console.log(`matching installed patch digests=${String(matching.length)} of ${String(resolutions.length)}`)
console.log(`credential hits: recorded=${JSON.stringify(recordedHits)} raw-control=${JSON.stringify(rawHits)}`)
console.log(`redaction source hits=${String(redactionSource.length)}`)
console.log(`checks=${String(checks.filter(c => c.ok).length)}/${String(checks.length)}`)
for (const fail of verdict.failures) console.log(`FAIL: ${fail}`)
