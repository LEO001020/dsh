# Final status: the trusted-local acceptance spec, fully executed

**Deployment identity `0a0996f3…`. Promotion `NOT_READY`. All 109 cases filed.**

## The tally

| Status | Count |
|---|---|
| PASS | 95 |
| FAIL | 13 |
| BLOCKED_EXTERNAL | 1 |
| NOT_RUN | **0** |

Per family:

| Family | Cases | Result |
|---|---|---|
| VERIFICATION | 9 | 9 PASS |
| COMPOSITION | 14 | 12 PASS, 2 FAIL |
| CONCURRENCY | 13 | 12 PASS, 1 FAIL |
| DATA | 12 | 10 PASS, 2 FAIL |
| RECOVERY | 10 | 8 PASS, 2 FAIL |
| IDENTITY | 6 | 3 PASS, 3 FAIL |
| IPYTHON | 15 | 12 PASS, 2 FAIL, 1 BLOCKED |
| NATIVE BRIDGE | 12 | 11 PASS, 1 FAIL |
| RESEARCH | 6 | 6 PASS |
| CACHE/OBSERVABILITY | 6 | 6 PASS |
| FILESYSTEM | 6 | 6 PASS |

## Four independent checks, all green

| Check | Command | Result |
|---|---|---|
| Spec/evidence agreement | `python qualification/runners/verify-spec.py` | no problems: every evidence file exists, every recorded sha256 matches disk, every path is under `qualification/results/`, every status agrees with its artifacts |
| Deployment identity | `python qualification/results/T1-spec/verify-identity.py` | **30/30** |
| Metadata inputs | `python helpers/doctor.py` | exit 0 |
| Typecheck | `tsc -p tsconfig.check.json --noEmit` | exit 0 |

**None of these four judges whether an oracle was established.** That is a reading
of the evidence, and each `GATES.md` is where a reader does it. The scripts check
the mechanical properties — existence, hashes, identity, status/artifact agreement
— which is the part that gets skipped when a result is written up in a hurry.

## Why NOT_READY despite 95 PASSes

**Three FAILs are reasons a user cannot use the product as intended, and each is a
mechanism that works with nothing in the product that calls it:**

1. **`G-SEAM-31` — no user action creates a run.** `WorkService.createRun` has no
   production caller, so the model-facing `work` tool throws `this session has no
   active run`. The **mandatory** N=10 rolling top-up cannot be exercised on the
   composed profile; every N=10 measurement came from a test calling `createRun`
   directly. The hard cap of 30 **is** measured binding in production.
2. **`G-SEAM-34` — the Python cell cannot reach a DSH tool.** The native bridge is
   outside the transitive closure of every package entry point, and
   `new BridgeServer` has zero production call sites. The FORBIDDEN seam is
   correctly absent, which makes the sanctioned one being unwired **worse** rather
   than better, because `ipython` is the model's only execution surface.
3. **`G-SEAM-33` — the policy says `workspace-write`.** The model is told a false
   statement about its own authority, and the PTC path still confines. The mounted
   `daily-no-sandbox-contract` guard detects this on every boot.

**The other ten FAILs are findings too**, each with a `docs/GAPS.md` row:
`G-SEAM-21` (epoch guard unreachable), `G-SEAM-40` (two gap stages have no
producer), `G-SEAM-41` (a cursor is refused across a revision but not a store),
`G-SEAM-45` (concurrent drains over-admit while the deficit reader reads 0),
`G-SEAM-46` (a spec self-contradiction: CMP-04 requires `pwsh` present while
CMP-13 requires it absent), `G-SEAM-47` (a built file imports an upstream
`src/*.ts` path, splitting module-scope state), `G-SEAM-48` (`tsconfig.json`
misses a type error `tsconfig.check.json` catches), `G-SEAM-49` (the pinned
checkout is not clean), and the `IPY-13` / `IPY-15` defects (late output silently
mis-attributed; the frame-loss counter has no producer).

**The one BLOCKED_EXTERNAL is `IPY-08`**, blocked on an authorization rather than
on code.

**The correct next step is to repair or explicitly accept each named defect — not
to re-run the cases, and not to promote.** A deployment whose mandatory
requirement is unreachable is not ready for daily use regardless of its PASS count.

## What was fixed during the execution, because it would have invalidated the work

1. **The deployment identity was stale in THREE inputs** (`host_profile_digest`,
   `agent_preset_digest`, `agent_preset_id`), re-derived to `0a0996f3…`. Two of the
   three were found by re-checking *every* input rather than the one reported.
2. **The spec was both a pinned input and the evidence ledger**, so the first
   filing broke four identity checks — two of which forbid filing at all when
   applied to the live file. Fixed by freezing the as-authored artifact at
   `qualification/specs/frozen/`, which hashes to exactly the pinned `e5b6a1d2…`.
3. **`helpers/doctor.py` did not exist** although both manuals told operators to
   run it. Written, and verified in both directions.
4. **`qualification/runners/verify-spec.py` did not exist** while ten agents were
   filing into the spec. Written, and verified in both directions.
5. **The no-sandbox contract guard was compiled and tested but never mounted.** An
   exports entry and a patch row were added; it now boots and reports, and its two
   failures are exactly `G-SEAM-33`.
6. **Two of my own findings were retracted** (`G-SEAM-29`, `G-SEAM-36`) after
   re-measurement showed they were harness artifacts, and one of my hypotheses
   (`G-SEAM-39`'s candidate cause) was refuted by an experiment an agent ran.

## What this report is not

It is an index. Every number is reproducible with the commands above, and every
verdict's substance is in the spec's `status`/`evidence` fields and in the
per-family `GATES.md`. A reader who wants to check a PASS should read its oracle
and then its evidence — not this file.
