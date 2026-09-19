# M9.7 — profile/preset isolation and bad-session refusal

Gates closed: **A06** (profile/preset layering), **A07** (preset identity),
**A11** (bad session resume).

Everything here was driven against real artifacts. A06/A07 boot the real
`@deepseek-ai/dsh-agent-presets` roster; A11 spawns the real built launcher
(`node D:/DSH/src/dsh-src/apps/cli/lib/bin.js`) as a subprocess with a controlled
`DSH_HOME` in a temp directory. No canary home was read or written.

- Test file: `packages/dsh-daily-work/src/profile-isolation.test.ts`
- Test run: `tests.txt` — **27 passed / 27**, `test_exit=0`
- Typecheck: `tsc.txt` — package `tsc_exit=0`, test file `iso_test_tsc_exit=0`
- Digests: `source-digests.txt` — the test file, the DSH sources each rule was
  read from, the shipped compositions, and `apps/cli/lib/bin.js`
- Raw launcher output: `launcher-transcripts.txt` — every block a separate
  process, verbatim exit code / stdout / stderr

---

## A06 — profile/preset layering: CLOSED

The gate's oracle is three negatives: no duplicate host registry, no sibling
service visible, no cross-Session closure pollution. Each is now a passing
assertion with a falsifiable failure mode.

**Two presets, two Sessions, two catalogs.** `alpha` and `beta` each compose
their own tool pair. Session A sees `[alpha_read, alpha_write]`, Session B sees
`[beta_read, beta_write]`, and `livePresetMounts()` shows exactly one standing
mount per preset — not one per Session. The tool view is keyed by the AGENT
object (`ctx.tools.schemas(agent)`), and passing `agent.ctx` collapses to the
empty global layer, which the test asserts as `0` so the wrong key cannot pass
silently. DSH's own e2e probe made that mistake once; it is pinned here.

**No duplicate host registry.** `tools`, `systemPrompt` and `agentPresets` are
host-level services every preset registers *into*, so after two mounts each must
still appear exactly once in the service store. Asserted per name. A preset that
minted its own registry would show a second entry, and the second Session's
registrations would stop being visible to the first.

**No cross-Session leak, in the shape that actually matters.** A value written
while serving preset A is visible to A (`memo: 'A-ONLY-VALUE'`) and absent from
B (`memo: null`), with `appliedTags` showing each preset's `apply` ran against
its own module instance.

**Jobs and compaction, per preset.** Both are services, so per-preset ownership
requires an `isolate` realm — a service published into the root realm is
process-global and `mountPreset` rejects it outright. The test composes the real
`@deepseek-ai/dsh-jobs-local` + `@deepseek-ai/dsh-tool-jobs` and the real
`@deepseek-ai/dsh-compaction-basic` behind entry-local realms, the way the
shipped presets do. Result: both Sessions get the real `job_kill` / `job_list` /
`job_output` trio, and `serviceForAgent()` returns **distinct** `jobs` and
**distinct** `compaction` instances per Session. Neither reaches the root realm
(`ctx.get('jobs')` is `undefined`), which is what "no sibling service visible"
means concretely.

### The standing-composition trap — what is true, and what is NOT

The plan names "a preset's plugin closure is shared across Sessions of that
generation" as a cross-session bug to rule out. Measured, the situation is more
specific than "shared closure", and one part of it is a real, unfixed hazard:

**What DSH does contain.** Registrations are per-Session. Each Session gets its
own scoped tool layer, its own prompt sections, and — where the preset isolates
them — its own service instances. A child agent joins its parent's generation
by scope parentage rather than remounting, so a second copy of every row is
never composed. Disposing one Session unwinds only its own registrations. All of
that is asserted above and holds.

**What DSH does NOT contain — a real finding.** Two presets that name the *same
composition file* get **one** module instance, because ESM caches by file URL.
Module-scope state in that file is therefore shared across both presets'
Sessions. The test asserts this explicitly (`shares one module instance between
two presets naming the SAME file`): after preset `gamma` writes its memo, preset
`delta` reads `memo: 'G-VALUE'` and `appliedTags: ['gamma', 'delta']`. The tool
catalogs stay correctly separate — registrations are scoped and a scoped
registration shadows rather than collides — but the module does not.

This is not a DSH bug: a preset composition is a Cordis file, and Cordis files
are imported, not instantiated. It is a constraint the daily system must respect,
and it is the reason `packages/dsh-daily-work/src/tools.ts` holds no cross-session
mutable state: every call resolves the exact live Agent and its run instead of
caching a `currentRun`. That design decision is now backed by a measured
property rather than by an assumption.

**Not asserted, deliberately:** that a preset's closure is fresh per preset.
It is not, and a test claiming otherwise would have to arrange its fixtures to
hide the behaviour. The constraint is recorded here instead.

### A preset is not self-contained

Mounting a **real shipped** preset against a hand-rolled context **fails**, and
the failure is informative: every shipped preset names rows that inject HOST
services (`fs`, `shell`, `subprocess`, `jobs`, `skills`, `subagents`, `web`,
`commands`, `userQuestions`), so those rows stay pending and `mountPreset`
rejects the whole mount with a per-row diagnostic. The test pins this
(`refuses to mount a shipped preset when the host plane its rows inject is
absent`), including the complete rollback — no half-composed Session, no
standing mount left behind.

This is why A06's layering assertions use authored fixtures: the layering rule
is about the ROSTER, and mounting a shipped preset drags the entire host plane
into the measurement. It also means a gate that "proved" preset layering by
mounting a shipped preset against a test context would have been measuring the
test context.

---

## A07 — preset identity: CLOSED

The precedence rules the `discoverPresets` implementation actually encodes:

| Rule | Asserted |
|---|---|
| An earlier root wins a duplicate id | `trust: 'system'` wins, and the winner's `path` points into the earlier root — not merely its label |
| A unique user id is discovered alongside shipped ones | `['daily-candidate', 'minimal', 'standard']` — shadowing is per id, not per root |
| A shipped preset shadows a same-id user directory | End-to-end through the real roster with the real shipped root: `resolve('minimal')` returns `trust: 'system'` and a path under `SHIPPED_PRESET_ROOT` |
| `resolve()` on an unknown id throws | `code: 'agent-preset/not-found'`, message names the id and the available alternatives |
| The mounting path propagates the refusal | `sessionOn(..., 'nope')` rejects and **no** Agent is published |

Root order is not incidental: the roster's `resolvedRoots` is
`[shipped, ...configured, user]`, so the shipped root is first and the user root
last. That ordering *is* the precedence rule.

**The real user preset.** `D:\DSH\home\canary5\.agent-presets\daily-standard`
was inspected as the example of the copy-plus-one-diff authoring rule: it is
byte-for-byte the shipped `standard` composition plus one appended row
(`dsh-daily-work/tools`). `copyComposition` is the only authoring write, and it
copies the whole directory, so a copy cannot be less loadable than its source.
It was **read only** — nothing under `D:/DSH/home/canary*` was modified.

**mtime/size is the generation stamp, and it is not a content hash.** A standing
generation is identified by `{mtimeMs, size}` only. The test writes a same-length
different-content composition and restores the stamp, then confirms the two
files genuinely differ while the stamp is identical — so an edit under those
conditions is **invisible** to the generation check. Nothing may claim a content
hash backs this. (The hazard is bounded in production today because
`copyComposition` mints a new directory rather than editing in place, but it is
real for any future in-place editor.)

**A Session keeps the generation it joined.** After a real edit (different
content *and* a later stamp), a new Session gets the new catalog while the
existing Session keeps the old one, and both generations stay live. This is the
"already-running conversation cannot silently change composition" property.

---

## A11 — bad session resume: CLOSED

Driven through the real launcher. Every case is a **refusal**; nothing here
asserts success where the launcher is supposed to refuse.

| Command | Exit | stderr |
|---|---|---|
| `--profile headless --session-id session-does-not-exist-0000 hello` | 1 | `dsh: session "session-does-not-exist-0000" does not exist; omit --session-id to start a new Session` |
| `--profile no-such-profile-xyz --dump-config` | 1 | `Error: dsh: profile "no-such-profile-xyz" does not exist; create it with 'dsh plugin --profile no-such-profile-xyz add <package>'` |
| `--dump-config` (no `--profile`) | 1 | `error: --profile <name> is required` |
| resume from a different cwd | 1 | `dsh: session "…" was recorded in "…", not "…"` |

Three properties make these refusals rather than just error strings:

1. **Nothing is created.** After a bad `--session-id`, `$DSH_HOME/sessions` does
   not exist at all — the launcher did not create the empty history its message
   promises it did not create.
2. **Nothing is created for a bad profile either.** The unknown-profile check
   precedes `initProfile`, so no `profiles/<name>` directory is left behind.
3. **The refusals are not indiscriminate.** A positive control runs the *same*
   command with a real, correctly-placed Session: it gets past identity and
   stops only at `MISSING_CREDENTIAL`. Without this control, every refusal above
   could be passing because the launcher refuses everything.

A cwd mismatch also leaves the Session count unchanged — the refusal did not
fork a new Session.

**No credential was needed for any of this.** Every refusal happens before a
provider call. Where a boot is unavoidable (creating a real Session to test cwd
mismatch), the boot fails with `MISSING_CREDENTIAL`, which is itself a correct
and assertable outcome rather than a reason to skip.

### Graph inspection did not boot the app

`--dump-default-config` / `--dump-config` compose the profile tree and exit, so
the roster's presence in the real graph is asserted with no credential and no
Session. Findings:

- The **web** profile composes `@deepseek-ai/dsh-agent-presets` with
  `default: standard` (163 rows total).
- `--dump-default-config` **omits** the user layer; `--dump-config` **includes**
  it. Verified by writing a temp home's `profiles/web/cordis.patch.yml` setting
  `default: minimal`: the patched dump shows `minimal`, the default dump still
  shows `standard`. A gate that used `--dump-config` where it meant "the shipped
  graph" would silently include whatever the developer's home held.
- The **headless** profile does **not** compose the roster at all. Its
  `--session-id` path is therefore a session-identity and credential check, not
  a preset check — worth knowing before anyone reads an A11 result as
  preset-related.

---

## Left open

- **A06's Jobs/compaction coverage is structural, not a live run.** The test
  proves two presets each own a distinct registry and engine. It does not start
  a job or trigger a compaction, which needs a model provider — that is C01/T5
  territory and is BLOCKED_EXTERNAL (no authorized budget).
- **A11 does not exercise the `preset incompatible` arm of its stimulus.** The
  headless profile composes no roster, so there is no preset to be incompatible
  with; the arm that exists is `session runs under agent preset "X", which the
  one-shot runner does not compose`, and reaching it needs a Session recorded
  under a preset, which needs a boot with a credential.
- **`child ID` resume was not exercised.** The headless runner rejects
  subagent/forked Sessions (`is a subagent or forked session and cannot be
  driven directly`), but producing such a Session needs a live child, i.e. a
  provider.
- **The superseded generation is never reclaimed.** `ensureStanding` carries an
  explicit `TODO` about it: a superseded mount lives until whole-tree teardown.
  Bounded by how often compositions change rather than by Session count, so not
  urgent, but it is a real unbounded-in-time retention that this gate observed
  (two generations live at once) rather than introduced.

## Files added by this task

- `packages/dsh-daily-work/src/profile-isolation.test.ts`
- `qualification/results/M9.7-profile-isolation/{FINDINGS.md,tests.txt,tsc.txt,source-digests.txt,launcher-transcripts.txt}`

## Junctions created (test-only; no DSH source was modified)

`packages/dsh-daily-work/node_modules/@deepseek-ai/` gained junctions so the
real preset machinery resolves: `dsh-agent-presets`, `cordis-plugin-loader`,
`cordis-plugin-include`, `cordis-plugin-group`, `dsh-app-boot`, `dsh-scope`,
`dsh-session-projection`, `dsh-home-paths`, `dsh-typert-protocol`,
`dsh-invariants`, `dsh-atomic-write`, `dsh-tool-jobs`, `dsh-timeout`,
`dsh-persona`, `dsh-agent-instructions`, `dsh-compaction`,
`dsh-compaction-basic`, `dsh-compaction-tool-result-pruner`, `dsh-token-meter`,
`dsh-util-values`, `dsh-output-retention`, `dsh-commands`.
