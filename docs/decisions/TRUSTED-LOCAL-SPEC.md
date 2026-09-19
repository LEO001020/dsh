# The trusted-local acceptance spec: why it was versioned, and what it does not claim

> **Status:** the spec exists and is bound to a new deployment identity. Every one of its
> 109 cases is `NOT_RUN` with empty evidence. The promotion decision is `NOT_READY`.
>
> **Files:**
> - the spec: `qualification/specs/acceptance-spec.trusted-local-v1.json`
> - the identity: `compatibility.lock.json` -> `deployment`
> - the arithmetic check: `qualification/results/T1-spec/verify-identity.py`
> - the old spec, unchanged: `qualification/specs/acceptance-spec.json`

---

## 1. What "trusted-local" means as a trust model

**The OS user account is the execution authority boundary.** DSH runs as the invoking
Windows user with no sandbox, no WSL, no Linux VM and no SSH execution world. Every process
it starts — including the persistent IPython kernel — is that same OS user, with that user's
full filesystem, network and process visibility. The consequence is not a weakness to be
apologised for; it is the design. It means the boundary that decides what this system may
touch is the one the operating system already enforces for the human sitting at the machine,
and that boundary is well understood, centrally administered, and not something this project
has to re-implement or pretend to enforce.

What the deployment therefore does **not** claim, in its own words: no host-secret read
isolation, no network or egress isolation, no filesystem write confinement, no process
visibility confinement, no second execution world, and no privilege separation between the
verification environment and the host. Those absences are recorded in
`deployment.trust_model_statement` and in the spec's `trust_model.explicitly_not_claimed`,
so a reader meets them at the top of both files rather than discovering them by failing to
find a claim.

What the deployment **does** claim is narrower and entirely checkable: a locked artifact
identity, a composed profile that actually activates, one programmable execution surface
with host-owned lifecycle, correct and honestly-bounded data and recovery behaviour, a hard
child ceiling that no path can bypass, verification that cannot be weakened by the thing it
verifies, and research provenance that says where a claim came from.

### Why the sandbox rows still exist

`sandbox` and `sandboxPolicy` remain in the profile, configured as `danger-full-access`.
This is not a compromise and not a leftover. Two measured reasons:

1. **The pinned DSH ABI requires them.** `sandboxPolicy` is a SERVICE that seven entries
   inject, and `inject` is a readiness gate. Deleting the row leaves those seven entries
   permanently `pending`, which cascades so that `shell`, `fs` and `ptcRuntime` never
   publish, the preset fails to mount, and the model's tool face goes to **zero**
   (`toolCount: 0`; `pwsh`, `ipython` and `work` all absent). "Off" is achievable;
   "deleted" is not.
2. **`danger-full-access` is DSH's own first-class path.** `ConfinedSandboxMode` excludes it
   *by type*, and the shell executors short-circuit on it. Setting the mode is the supported
   way to say "no confinement" — it is the harness's own vocabulary for this deployment's
   decision.

The rows are therefore kept so the ABI is satisfied, and their value is set so the
deployment says what it means.

---

## 2. Why the spec was versioned rather than edited

The old spec (`qualification/specs/acceptance-spec.json`, 112 cases, `schema_version: 2`) was
**not edited**. It is byte-identical to what it was, and its digest is retained in the new
identity as a historical input. Three reasons, in order of weight:

**1. Its digest is an identity input, and identity is the whole mechanism.** The project's
central rule is that a PASS is bound to the artifact it was measured on, and that any change
to the artifact, lockfile, profile, preset, resolved graph or spec changes the identity and
invalidates every PASS recorded against the old one. Editing the old spec in place would
have changed the identity of the *old* deployment too, silently retroactively invalidating
the 85 PASSes in `qualification/gates.json` as statements about their own tree. Those 85 are
real measurements of a real system, and they should stay true statements about the tree they
describe. A new spec under a new identity keeps them that way.

**2. An edited oracle is indistinguishable from a weakened one.** The old spec contains
`SEC-01`, `SEC-03`, `SEC-08`, `DEP-04`, `DEP-05` and `VER-04` as live cases. The honest
disposition of five of them changes under the new architecture (see §3). Rewriting those
entries in place would produce a file whose history cannot be read: a reader could not tell
whether a case changed because the architecture changed or because it was inconvenient. A new
file makes the change of standard explicit and auditable, which is exactly what the project's
own rule demands — *changing the acceptance definition requires a separate explanation and
the old results must be kept*.

**3. The two specs answer different questions.** The old spec asked "does this deployment
hold these isolation invariants?". The new one asks "is this deployment correct and honest
about what it is?". Those are not the same target, and forcing them into one file would make
the second question look like a revision of the first.

**What was NOT done, and must not be done.** No case was carried across with a status. No
evidence was copied. No threshold was lowered. The new spec's 109 cases are 109 new cases;
where they overlap in subject with an old case, the old evidence is *relevant* but not
*sufficient*, because it was measured against a different identity. Anyone filing evidence
must produce it under the new identity.

### Numbering: one deliberate collision, flagged in both places

This spec **re-issues the `VER-` numbering**. Its `VER-01..09` are new cases, and its
`VER-04` (receipt freshness) is **not** the old `VER-04` (host execution bypass). Because a
silent id reuse is exactly the kind of thing that makes an evidence trail unreadable, the
collision is stated in two places: in the `VER` family's `numbering_warning` and inside the
new `VER-04`'s own oracle text. The verification script checks that both statements exist.
The other four inherited ids (`SEC-01`, `SEC-03`, `SEC-08`, `DEP-04`) do **not** reappear as
cases at all, and the script checks that too.

---

## 3. Why the five gates are `NOT_APPLICABLE` and not `FAIL`

The five are recorded in the spec's `not_applicable_inherited` section, each with its old
oracle, its old measured state, and its reasoning. They are **not** cases: they carry no
status field, they are not in `cases`, and no evidence may be filed against them.

**The distinction that decides it:**

- `FAIL` means *this architecture claims the invariant and did not achieve it.*
- `PASS` means *this architecture claims the invariant and achieved it.*
- `NOT_APPLICABLE` means *this architecture does not claim the invariant, so there is nothing
  to achieve or fail.*

Marking these `FAIL` would assert a claim this deployment does not make and cannot make.
Marking them `PASS` would assert an achievement that does not exist. Under a trust model
whose whole content is "the OS user account is the boundary", there is no isolation domain
in which any of the five could hold. `NOT_APPLICABLE` is the only state that is true, and it
is honest only because the trust model states the absence out loud — which is why §1 and this
section have to be read together.

**Why they were not simply dropped.** Each was measured or analysed in the old deployment,
and that work is the reason they are out of scope. Dropping them would let a reader think
they were never considered. Two of them (`SEC-01`, `SEC-03`) were **honest FAILs measured on
this platform** before the architecture changed — the sandbox's write boundary could not
restrict a read, and the seam's own documentation says network is outside its vocabulary.
Those measurements are what made the architecture decision a decision rather than a
preference. Silently deleting the evidence would erase the reasoning.

The five, with their dispositions:

| Old id | Subject | Old measured state | New state | Why |
|---|---|---|---|---|
| `SEC-01` | host secret isolation | **FAIL** (measured on Windows) | `NOT_APPLICABLE` | No read isolation is claimed at any level. The old FAIL was measured: a confined child read a canary outside the workspace root verbatim, exit 0, in *both* confining modes, and four candidate levers were probed with none able to restrict a read. |
| `SEC-03` | egress isolation | **FAIL** (measured on Windows) | `NOT_APPLICABLE` | No network boundary is claimed. Measured: a confined child completed a real HTTP round trip and reached a LAN address, and the seam documents network as outside its vocabulary, so no configuration of it could ever have provided this. |
| `SEC-08` | role / read-permission-domain transition | `NOT_RUN` (needs a second world) | `NOT_APPLICABLE` | The requirement's **precondition is dissolved**. One execution world means no domain to transition between and no cross-domain reuse to test. The requirement itself disappears; it is not an unbuilt capability. |
| `DEP-04` | SSH path consistency | `NOT_RUN` (needs a second world) | `NOT_APPLICABLE` | Same dissolved precondition. In a single world the oracle is vacuously true, so leaving it `NOT_RUN` would read as an outstanding obligation when it is an empty one. Its genuinely live half is preserved as **`FS-03`**, where it is actually checkable. |
| `VER-04` | verification-environment privilege separation | `NOT_RUN` (verifier not built) | `NOT_APPLICABLE` | No separation is claimed, and none exists: candidate tests run as the same OS user as the host. **This is the most consequential of the five** — see below. |

### The one that has to be stated loudly

`VER-04` guarded something different in kind from the other four. `SEC-01`/`SEC-03` guard a
runtime boundary; `VER-04` guarded **the credibility of the verification chain itself**. If
the verification environment has the same authority as the host, then "the candidate passed
verification" is a weaker statement than it sounds, because the candidate could have read
what it liked or changed what it was measured against while being measured.

That consequence is **carried forward explicitly rather than absorbed**. The new spec's
`VER-09` requires every recorded verdict in this deployment to name its tier *and* to state
that no privilege separation between verifier and verified exists. Presenting a same-account
verification as privileged isolation is a `NOT PASS` condition. The absence is also stated in
`deployment.trust_model_statement` and in the spec's `explicitly_not_claimed` list.

What is *not* carried forward is any claim of isolation, because there is none to test.

---

## 4. No PASS is inherited. The old 85 stay valid for the old identity only

This is the single most important sentence in this document:

> **No PASS is inherited from the old spec or the old gate report.**

Concretely:

- `qualification/gates.json` holds **85 PASSes against the OLD identity**
  (`ece4037a…`). They remain **true statements about the tree they were measured on**, and
  they are retained as history. They are **not** evidence for any case in the new spec.
- The old spec's 112 cases remain `NOT_RUN` and were not touched.
- The new spec's **109 cases are all `NOT_RUN` with empty `evidence`**. Nothing was
  pre-marked. The verification script fails if any case is not `NOT_RUN` or carries evidence.
- Where a new case covers ground an old PASS covered, the old evidence is *relevant context*
  and *insufficient evidence*, because it is bound to a different identity. Filing it
  unchanged would be inheritance by another name.

The promotion decision is therefore `NOT_READY`, and it is `NOT_READY` for a stated reason
rather than by default: 109 mandatory cases are unrun, and the layer-T5 cases are
`BLOCKED_EXTERNAL` while `runtime_authorization.live_provider_budget_authorized` is `false`.

---

## 5. The identity change, and its verification

The identity moved from `ece4037a9d5bbb014aa5a8395ed15531715a11949f2aa687166fcfeb5717576f`
to `549732b5d8cad4e86d3df7c55dbf090598753a8fa015e8207ff6f851e376d813`.

**Exactly two inputs changed**, and they are the only two:

| Input | Change |
|---|---|
| `trusted_local_acceptance_spec_sha256` | **ADDED** — `e5b6a1d2…` the digest of the new 109-case spec |
| `isolation_image_or_policy_digest` | `sandbox-windows-acl-partial` → `none-trusted-local-os-user-account-is-the-execution-authority-boundary` |

`acceptance_spec_sha256` (the old spec's digest) is **retained unchanged** as a historical
input, which is what makes "the old spec was not edited" a checkable statement rather than a
promise.

**The arithmetic is reproducible in steps**, so the note's explanation is falsifiable rather
than a story:

| Step | Identity |
|---|---|
| Old inputs | `ece4037a…` |
| + new spec input only | `e89a583c…` |
| + isolation input restated | `549732b5…` (final) |

**A wrong identity hash is worse than none**, so the recomputation is a script rather than a
claim: `qualification/results/T1-spec/verify-identity.py` (output saved beside it as
`identity-verification.txt` and `.json`). It runs 28 checks, including: the identity
recomputes from the inputs; the new spec digest on disk matches the pinned input; **the old
spec on disk still matches its retained digest** (proving it was not edited); every case id
is unique; the family counts match the mandated minimum; no case is pre-marked PASS; no case
ships with evidence; the five `NOT_APPLICABLE` entries exist with reasoning and do not appear
as cases; the promotion section names `trusted-local-daily` and is `NOT_READY`; and the two
intermediate identities reproduce.

The checks were tested against tampering rather than assumed to work: corrupting the identity,
pre-marking a case `PASS`, and deleting a case each make the script exit non-zero and name
the specific failure.

### A defect found while doing this, recorded rather than quietly fixed

The lock's previous revision recorded `promotion.gate_spec_sha256` as
`2fe95835425eb9…` while naming `spec_path = qualification/specs/gate-spec.json`. That digest
is **not** `gate-spec.json`'s — it is `acceptance-spec.json`'s. The true digest of
`gate-spec.json` is `b6e68075e097b5d790a406cb92820465381b6a716a84b53b0a8b8d99d584ad47`.

Both values are now recorded, with the correction in the file, so a reader can verify the
fix instead of trusting it. No checker in this repository reads
`promotion.gate_spec_sha256`, so nothing consumed the wrong value: it was a documentation
defect, not a live one. It is recorded here because an unverified negative claim is worth as
little as an unverified positive one, and because silently correcting a digest in a file
whose entire purpose is digest integrity would be the wrong instinct.

---

## 6. What this spec does not establish

- **It does not certify anything.** 109 `NOT_RUN` cases establish nothing about the system.
  The identity is arithmetic over files; the verification script says so in its own output.
- **It does not claim any safety property.** Read §1 again if that is the question.
- **It does not close `DEP-05`.** The old `DEP-05` ("removing subprocess/sandbox/SSH
  dependencies must fail loudly and must not silently degrade to `danger-full-access`") is the
  one old case whose subject survives the architecture change, because a *silent* degradation
  and an *explicitly configured* `danger-full-access` are different facts and the difference
  still matters. It is re-expressed as **`CMP-03`**, which requires the two to be
  distinguishable and requires the provider-missing case to fail loudly. Its old oracle is
  not carried over verbatim, because that oracle is undecidable in a deployment whose
  configured mode *is* `danger-full-access`; the old wording and the reason for the change are
  on the record in `docs/decisions/2026-09-20-six-gate-impact-explained.md` §DEP-05.
- **It does not establish that the shell has left the daily preset.** `CMP-13` states that
  requirement and is `NOT_RUN`; the measured catalog still contains `pwsh`. A requirement
  written down is not a requirement met.
- **It does not verify the T5 cases**, which need a live provider and stay
  `BLOCKED_EXTERNAL` while `live_provider_budget_authorized` is `false`.

---

## 7. How another agent files evidence against this spec

1. Read the case's `oracle` and `layer`. The oracle states what would be **observed**; the
   layer states the tier the verdict may be claimed at.
2. Produce the measurement at that tier. A T0/T1 result may not be filed as T2/T3.
3. Write the evidence to a file under `qualification/results/<your-slice>/`, with the exact
   command, the raw output, and the environment.
4. Record on the case: the repo-relative `path` and the file's `sha256`.
5. Set the status to `PASS` **only** if the file establishes *this* oracle. Otherwise
   `FAIL`, or `NOT_RUN` with the reason, or `BLOCKED_EXTERNAL` with the concrete blocker.
6. Do not edit an oracle, skip a case, lower a threshold, widen a permission, or record a
   result you did not produce. Those are the six ways to make this spec worthless, and the
   only one that is harder to detect than to do is the last.
