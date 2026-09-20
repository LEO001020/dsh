# dsh-native-daily

A DSH-native personal daily system for coding and research, built on
DeepSeek Harness.

> **Status: AUDIT SNAPSHOT / NOT QUALIFIED FOR DAILY USE**
>
> Nothing in this repository is certified for daily use. The architecture is
> converging and the implementation is closing; the **qualification is not
> closed**, so the release is `NOT_READY`. Read
> [Current status](#current-status) before using anything here.

## Cloning this repository (read this first on Windows)

**A plain `git clone` can fail on Windows and leave an apparently empty
checkout.** The failure is a path-length limit, not a missing file.

```sh
# either clone somewhere short...
git clone https://github.com/LEO001020/dsh D:/dsh
# ...or enable long paths (this clone)
git -c core.longpaths=true clone https://github.com/LEO001020/dsh D:/dsh
# ...or enable them for every clone and checkout on this machine
git config --global core.longpaths true
```

**The diagnosis matters, because the symptom is easy to misread.** `git clone`
prints `Filename too long`, exits **128**, and never writes the index — so the
checkout that remains looks merely *empty* rather than *broken*. The tell is:

```sh
git ls-files | wc -l     # 0 after a failed clone
```

If that returns 0 in a directory that has a `.git`, this is the cause, not a
network or credential problem.

**Why it happens.** The longest tracked **relative** path is 222 characters and
**zero** tracked paths exceed 259 on their own, so the repository is inside
Windows' `MAX_PATH` by itself. The failure is `PREFIX + 222` crossing 260, which
is why the *destination* decides the outcome: a short root such as `D:/dsh`
works, a deep temporary directory does not.

Measured and narrowed, with all three arms, in
`qualification/results/ROOT-round2/clone-path-length.md` and re-measured at
`2e1b2c2` in `qualification/results/P15-status/CLONE-PATH-CLAIM-CHECK.md`:

| clone destination | prefix | result |
|---|---|---|
| `D:/v/lp-short` | 5 | exit 0, `git ls-files` = 1127 |
| `%TEMP%/lp-deep` | 12 | **exit 128, `git ls-files` = 0** |
| `%TEMP%/lp-long` + `core.longpaths=true` | 12 | exit 0, `git ls-files` = 1127 |

**The evidence paths are not being renamed.** They encode the workspace the
Session store scoped them to, and recorded digests reference them; rewriting them
would falsify historical evidence. A future release package should solve this by
publishing the source/runtime package separately from the audit evidence archive
rather than by shortening paths — that is a packaging decision, recorded here as
an open item, not applied.

## Current status

**Do not read a PASS/FAIL count out of this file.** Counts move, and this README
previously carried several of them by hand in more than one paragraph, which is
how a reader ends up citing a number that no longer describes the tree. The
authoritative status is machine-readable; read it there:

```sh
# The promotion decision and the deployment identity this repo is bound to.
python -c "import json;d=json.load(open('compatibility.lock.json'));print(d['promotion']['decision'], d['deployment']['identity'])"

# Per-family case counts, read from the spec itself rather than from prose.
python qualification/runners/verify-spec.py --summary

# Which cases are not PASS, and why.
python -c "import json;[print(c['id'],c['status']) for c in json.load(open('qualification/specs/acceptance-spec.trusted-local-v1.json'))['cases'] if c['status']!='PASS']"
```

| field | where it comes from | value at `2e1b2c2` |
|---|---|---|
| Promotion decision | `compatibility.lock.json` → `promotion.decision` | `NOT_READY` |
| Deployment identity | `compatibility.lock.json` → `deployment.identity` | `533c8cb08b2ccd7f…` |
| Acceptance spec | `compatibility.lock.json` → `promotion.spec_path` | `acceptance-spec.trusted-local-v1.json`, 109 cases |
| Live provider budget | `compatibility.lock.json` → `runtime_authorization.live_provider_budget_authorized` | `false` |

`RELEASE_DECISION.json` — the artifact V5 §22 (`P2.8`) names as the home for this
block — **does not exist yet** (verified: it appears nowhere in this repository's
history). Until it does, `compatibility.lock.json` is the machine-readable source
and the commands above are how to read it. This section is deliberately a *link
plus a command* rather than a transcription.

### The two commands that are NOT green

`README.md` previously stated that all four diagnostic commands were green. Two of
them exit non-zero at `2e1b2c2`, and the reason is not a code defect — it is the
identity having moved underneath the evidence:

| command | exit | meaning |
|---|---|---|
| `python qualification/results/T1-spec/verify-identity.py` | **0** | all 30 checks pass; the identity recomputes from the files |
| `python qualification/runners/verify-spec.py` | **1** | `317 problem(s)`, every one of them `evidence was filed under identity 0a0996f3… but the lock's identity is 533c8cb0…` |
| `python helpers/doctor.py` | **1** | `host_profile_digest is STALE: pinned 0e8e370e… but cordis.patch.yml hashes to 4e3aa20c…` |
| `python qualification/runners/build-gates.py` | not run | regenerates a report; not a read-only check |

Both failures are **intended consequences of a recorded decision, not new
breakage** — the lock's own `promotion.decision_reason` says every verdict bound
to `0a0996f3…` is stale as evidence for `533c8cb0…`, and the profile patch gained
a row after the identity was last derived. The consequence a reader must take is
the important part: **the 95 PASSes are history for a superseded identity and must
be re-measured, not inherited.** Raw output is archived in
`qualification/results/P15-status/STATUS-MEASUREMENT.md`.

## What this is

An implementation of the mandatory rolling child-work capability on top of DSH's
own machinery, plus the evidence needed to say what works and what does not.

It is **not** a port of any earlier orchestration project. There is exactly one
model loop and it is DSH's. This project adds a resource controller: it decides
whether a child may be admitted, holds a credit reservation, and keeps a
reconciliation relation. It does not decide what work means.

**Trust model: `trusted-local`.** The OS user account is the execution authority
boundary. There is no sandbox, no WSL, no Linux VM and no SSH execution world.
Every process this deployment starts — including the persistent IPython kernel —
runs as the invoking user with that user's full filesystem, network and process
visibility. **This deployment claims no confinement of reads, writes, network or
process visibility**, and no case in the acceptance spec may be read as
establishing one.

## Layout

| Path | What it is |
|---|---|
| `AGENTS.md` | Navigation for an agent working here, plus the hard constraints |
| `ARCHITECTURE.md` | How the pieces fit and why the record exists at all |
| `docs/DELIVERY.md` | Operations manual: install, doctor, start, pause, recover, shutdown, N, permissions, backup, rollback, gate reading |
| `docs/DELETE-AUDIT.md` | The shrink audit: real import graph, per-module classification, named-candidate verification, old-vs-new inventory |
| `docs/DSH_SEAMS.md` | Every DSH interface used, with file:line, read at the pinned commit |
| `docs/INVARIANTS.md` | 48 invariants, each bound to the gate that must fail if broken |
| `docs/SECURITY.md` | Trust boundaries and what is enforced where |
| `docs/RECOVERY.md` | Crash behaviour and the measured shutdown order |
| `docs/OPERATIONS.md` | Install, run, stop, upgrade, roll back |
| `docs/GAPS.md` | Everything missing, unverified or externally blocked |
| `docs/exec-plans/0001-master.md` | The living plan and status log |
| `compatibility.lock.json` | The pinned artifact, the deployment identity, and the promotion decision |
| `qualification/gates.json` | **Historical.** All 104 gates of the OLD spec (schema_version 1), bound to the superseded identity `ece4037a…`. Kept as evidence for that identity only. |
| `qualification/specs/` | The acceptance specs. `acceptance-spec.trusted-local-v1.json` is the current one; `frozen/` holds the as-authored snapshot |
| `qualification/results/` | One directory per slice, with real output |
| `profiles/` | C0 (stock) and C2 (daily candidate) profile templates |
| `packages/dsh-daily-work/` | The rolling child-work extension package (12 entry points) |
| `packages/dsh-ipython/` | The persistent-IPython extension package (5 entry points) |

## The extension packages

**Two** packages ship, and both are loaded as bundles by the composed profile:
`packages/dsh-daily-work` (the rolling child-work controller) and
`packages/dsh-ipython` (the persistent IPython execution surface).

`packages/dsh-daily-work` declares **12 entry points** (count them rather than
trusting this sentence:
`python -c "import json;print(len(json.load(open('packages/dsh-daily-work/package.json'))['exports'])-1)"`).
The ones that carry the capability this README is about:

- `dsh-daily-work/host` — the host service. Mounted ONCE by the host profile.
  Owns the run record, the credit reservation and the admission state machine.
- `dsh-daily-work/tools` — the agent-scoped `work` tool. Mounted in the agent
  preset. Holds no cross-session state.
- `dsh-daily-work/command` — the human `/work` command: the product's
  run-authorization entry point. Registered through DSH's **human** command
  registry (`ctx.commands`), which resolves the handler without sending the line
  to the model and logs `source.kind = 'user'`. This is the seam that makes a run
  creatable by a user action; see `packages/dsh-daily-work/src/command-work.ts`.
- `dsh-daily-work/service` — the service class, for tests and embedders.
- `dsh-daily-work/web-search` — the ported search provider, registered through
  `ctx.web.registerSearchProvider`.
- `dsh-daily-work/tool-protocol-guards` — the exact-owner guard for `work`,
  mounted at the host plane so it applies deployment-wide.
- `dsh-daily-work/no-sandbox-contract` — the guard that checks the deployment's
  sandbox mode at three distinct boundaries (`startup`, `session-resume`,
  `ptc-execution`), because a deployment can be correct at startup and changed by
  a later session. It adds no model tool and makes no permission decision.

The rest are mounted by the bundle patch: `data-host` and `data-service` (the
observation/artifact plane), `history` (authorized history and web provenance),
`writers` (writer isolation and integration), and `programmatic-scope` (the
extracted nested-dispatch scope).

`packages/dsh-ipython` exports `host` (the kernel service), `tool` (the ONE
model-facing `ipython` tool), `kernel`, `plugin` and `protocol`. Its model-facing
surface is deliberately one tool with one `code` parameter — no lifecycle tool
(`ipython_open`/`_send`/`_read`/`_status`/`_close`) is registered anywhere in the
package, and that absence is asserted in a real boot.

## Quick start

```sh
# 1. The pinned DSH checkout must exist and be built.
#    See docs/DELIVERY.md for the exact commands and the six traps in them.

# 2. Run this package's tests (no live provider needed).
cd packages/dsh-daily-work
powershell -NoProfile -ExecutionPolicy Bypass -File link-all-dsh.ps1
vitest run

# 3. Typecheck — the ONE official command. Both packages, tests included.
cd ../..
pnpm typecheck

# 4. Read the status (see "Current status" above for what these report).
python qualification/runners/verify-spec.py --summary
```

`pnpm typecheck` is **the** typecheck to cite. `tsc -p tsconfig.json` is **not**:
it excludes `src/**/*.test.ts` and therefore exits 0 with or without a test file
present. `tsconfig.check.json` keeps identical strict flags and clears only that
exclude, and the official command drives it for every package while refusing to
pass if a config stops including the tests. Measured both ways, with the control
arm, in `qualification/results/R2-F10F11/mutation-test.txt`.

## What is proven, and what is not

This section states **what kind of thing** each claim is, because the distinction
is the one this project keeps getting wrong. A mechanism that works while nothing
in the product calls it is this repository's single most-recorded defect, and it
has been filed more than twelve times.

### Product paths that now exist and were measured on a real boot

These were fixed in earlier, merged waves. Each is stated with the artifact that
measured it; none of them is a claim about a PASS count.

- **A user action creates a run.** The human `/work` command is registered in the
  agent-scoped view and `authorizationRef` names the human command that authorized
  the run. Measured through `CommandRuntime` on a real composed-profile boot, 33/33
  checks: `qualification/results/R4-authorization/report-after.json`. Source:
  `packages/dsh-daily-work/src/command-work.ts`, mounted at
  `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml:384`. The
  model-facing `work` tool still refuses when no run exists — that refusal is the
  authorization edge, not the defect. (Closes `G-SEAM-31`.)
- **A Python cell reaches a DSH tool.** A real `daily` boot constructed a live
  `BridgeServer` (`packages/dsh-ipython/src/kernel-plugin.ts:493`), the `ipython`
  tool dispatched a nested call, the cell reported `DSH_BOUND=True`, and the
  durable ledger recorded the call `settled` with STARTED and SETTLED both set:
  `qualification/results/R5-bridge/composition-tier.json` and
  `qualification/results/R5-bridge/RESULTS.md`. The ledger holds occurrence
  records and digests, not a credential. (Closes `G-SEAM-34`.)
- **The deployment's sandbox mode is the one it claims.** `sandbox-policy` is
  `mode: danger-full-access` (`profiles/daily-candidate/cordis.patch.yml:607`),
  and a real boot records `danger-full-access`:
  `qualification/results/R1-trusted-local/composition-after.json`. The
  `no-sandbox-contract` guard checks this at three boundaries. (Closes
  `G-SEAM-33`.)
- **The hard child capacity is enforced in production**, not only by this
  project's bookkeeping: a genuine `startContinuable` call was refused at 30 with
  the refusal naming the deployment constant
  (`qualification/results/T10-capacity/prod-capacity-report.json`).
- **Admission is not execution.** Every task lands in `accepted`, and an
  unobserved child is not counted as an active assignment.
- **A run survives a real SIGKILL.** The record, every task state and the exact
  reservation were recovered from a fresh process, and reconciliation returned
  `unknown` rather than relaunching anything.
- **The acceptance runner does not trust exit codes.** Two cases with a real exit
  code of 0 — an all-skipped suite and a zero-test run — are still non-PASS.
- **An A→B→A mutation during verification is caught by an immutable snapshot**,
  and the in-place control arm proves endpoint hashing alone would have certified
  the tampered run.

### What is NOT proven, and must not be implied

Read `docs/GAPS.md` for the full list; it is the ledger, and it records a status
per row. The ones that matter most:

- **No case is currently PASS for the current identity.** The 95 PASSes in the
  trusted-local spec were filed under the superseded identity `0a0996f3…`; the
  lock's identity is `533c8cb0…`. The lock's own record says every verdict bound
  to the old identity is stale as evidence for the new one. **No PASS is
  inherited**, and the FAILs must be re-judged rather than re-labelled.
- **The kernel epoch and the run-record epoch are different fields that share a
  name** (`G-SEAM-43`, OPEN). The kernel epoch advances on kernel death and is
  reachable through `dsh-ipython`. The **run record has no `epoch` field at all**
  and neither does any guard read one — the guard and the field were deleted under
  F8 / REC-09 / REC-10. This is a **NON-CLAIM, not a fix**: v2 does not claim that
  a settlement from a superseded generation is fenced across a process boundary,
  because no production path can construct one. What IS enforced is object
  identity for the in-process resume case (`tool-protocol-guards.ts`). See
  `qualification/results/R9-recovery-topology/`.
- **A spec self-contradiction is still open** (`G-SEAM-46`): `CMP-04` requires
  `pwsh` present while `CMP-13` requires it absent. It is a spec defect, not a
  product defect, and the resolution is the delivery owner's.
- **No live paid run.** `live_provider_budget_authorized` is `false`. A key being
  present would not authorize large paid evaluation. Cases at layer T5 stay
  `BLOCKED_EXTERNAL` while this is false.
- **`ctx.web.search()` reaches a different backend than the ported provider**
  (`G-SEAM-52`): the row is mounted, the tests pass, and the selection string
  names another id. The mis-selection is real but currently **unobservable**,
  because neither provider has a credential on this machine, so both report
  `available() === false`.

### Open items owned by other work in flight

These are stated as open items **on purpose**. They are being changed right now by
other work, the merge has not happened, and a claim written from any single
worktree would be true of that worktree and false of the published tree. Nothing
below asserts an outcome.

| item | what is unresolved | where it will be decided |
|---|---|---|
| The model-facing tool catalog | The count and membership have moved in both directions as rows were added and disabled. **Any specific tool count is a property of one composition, not of the repository.** | The composition that resolves the preset; re-measure rather than citing a number |
| `dsh.data` model-facing reachability | The plane's mechanism exists; whether a model call reaches it end-to-end on the assembled profile is an open measurement | `qualification/results/P5-data/` and the data-plane slices |
| The durable READY queue and completion-driven refill | Whether a submitted assignment survives a full target, and whether a completion triggers refill without the root asking again | The rolling-N slice |
| Work UI / default-target semantics | Whether changing a setting edits the **live** run's target or only the default for a future run | The target-semantics slice |
| The Windows clone failure, for a future release package | Whether to publish source/runtime separately from the audit evidence archive instead of shipping the raw evidence tree in the install artifact | Release packaging; see the clone section above |

### Historical: the OLD 104-gate report

Everything in this subsection is **history for a superseded identity** and is kept
because the work was real. `qualification/gates.json` holds 104 gates with **84
PASS, 3 FAIL, 10 NOT_RUN, 6 NOT_APPLICABLE, 1 BLOCKED_EXTERNAL**. The 84 PASS rows
carry `deployment_identity` `ece4037a…` and are valid evidence for **that identity
only**; they are **not inherited** by the current spec. The 20 non-PASS rows carry
no `deployment_identity` field at all — worth knowing before citing any of them,
because a row with no identity is not bound to a candidate either way. Among them, ten are the **M6 terminal block
(T01–T10)**, whose subject is the native PTY as the model's execution surface —
exactly what the new architecture removes. `docs/DELETE-AUDIT.md` §4.2 lists every
obsolete PASS.

Likewise, the **112-case spec** (`qualification/specs/acceptance-spec.json`) is
retained unchanged as history; it is the identity input for the OLD identity. All
112 of its cases are `NOT_RUN`, and the reason the earlier revision of this file
gave for that — "the architecture they describe is not built" — was true when
written and is **not true of current code**: the persistent IPython surface, the
native bridge and the capacity guard all exist now. They have simply not been
judged under that spec, which is a different statement.

The `docs/DELETE-AUDIT.md` §1 import graph is a snapshot at `2d4534f` and says so.
It is older than the `/work` command entry point, so it does not list `./command`
among the export roots; prefer a fresh run of
`node qualification/runners/import-graph.mjs packages/dsh-daily-work` when the two
disagree.

## Promotion decision

`NOT_READY`, and it is read from `compatibility.lock.json` rather than copied
here. Two independent reasons, and neither is a PASS count:

1. **The identity moved and the evidence did not.** Every verdict in the
   trusted-local spec is bound to a superseded identity. The correct next step is
   to **re-measure**, not to re-label.
2. **The named defects must be repaired or explicitly accepted.** V5's release
   rule requires no FAIL, no FLAKY, no `NOT_RUN` for mandatory offline cases, no
   invalidated evidence counted as a pass, and only explicit `BLOCKED_EXTERNAL`
   remaining — plus post-integration CI evidence on the exact merged candidate.
   None of that exists yet.

Nothing in this repository is certified for daily use, and the machine-readable
record says so in its own vocabulary rather than in a footnote.

### How to falsify everything above

Do not trust this file. It is a document, and the defect this project records most
often is a document describing a state the code has left behind. Every claim here
names the artifact that establishes it; re-run the artifact. Where a claim is a
count, re-derive the count. Where a claim is "the product does X", the evidence is
a boot, not a test that mounts the module.
