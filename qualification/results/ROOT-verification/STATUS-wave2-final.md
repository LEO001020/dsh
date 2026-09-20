# Wave-2 status: the acceptance spec, per family

Recorded by the root agent. This is the state a reader can verify by running
`python qualification/runners/verify-spec.py` and `python qualification/runners/verify-spec.py --summary`.

## Filed — 64 of 109 cases

| Family | Cases | PASS | FAIL | NOT_RUN |
|---|---|---|---|---|
| VERIFICATION | 9 | 9 | 0 | 0 |
| COMPOSITION | 14 | 12 | 2 | 0 |
| CONCURRENCY | 13 | 12 | 1 | 0 |
| DATA | 12 | 10 | 2 | 0 |
| RECOVERY | 10 | 8 | 2 | 0 |
| IDENTITY | 6 | 3 | 3 | 0 |
| **filed total** | **64** | **54** | **10** | **0** |

## Pending — 45 cases

| Family | Cases | State |
|---|---|---|
| IPYTHON | 15 | evidence collected; `GATES.md` and filing outstanding |
| NATIVE BRIDGE | 12 | briefed; two arms measured, no filing yet |
| FILESYSTEM | 6 | `VERDICT.json` reports **47/47**; `GATES.md` and filing outstanding |
| RESEARCH | 6 | transcripts and a zloop-port verification captured |
| CACHE/OBSERVABILITY | 6 | transcripts captured; the G-SEAM-23 cache defect reproduced |

## The ten FAILs, each with its mechanism

A FAIL here is a finding, not a gap in the work. Every one has a measured cause:

| Case | What it found | GAPS row |
|---|---|---|
| ID-01 | a BUILT file imports an upstream `src/*.ts` path, so the host holds two instances of a module and splits its module-scope state | G-SEAM-47 |
| ID-05 | `tsconfig.json` MISSES a type error that `tsconfig.check.json` catches (control arm) | G-SEAM-48 |
| ID-06 | the pinned checkout's tree is not clean | G-SEAM-49 |
| CMP-02 | the policy mode is `workspace-write`, not `danger-full-access` | G-SEAM-33 |
| CMP-04 | a spec SELF-CONTRADICTION: it requires `pwsh` present while CMP-13 requires it absent | G-SEAM-46 |
| DATA-09 | two of six gap stages have no producer; the planes do not meet | G-SEAM-40 |
| DATA-11 | a cursor is refused across a revision but not across a store | G-SEAM-41 |
| REC-09 | a stale settlement IS applied through the reachable `transition` | G-SEAM-21 |
| REC-10 | the epoch guard is unreachable from any production path | G-SEAM-21 |
| CAP-10 | concurrent drains over-admit and `capacityDeficit` reads 0 | G-SEAM-45 |

## Verification state

| Check | Result |
|---|---|
| `verify-spec.py` | no problems: every evidence path exists, every hash matches disk, every path is under `qualification/results/`, every status agrees with its artifacts |
| `verify-identity.py` | **30/30** — the pin and the anti-rigging pair now check the FROZEN as-authored snapshot, so filing a verdict does not trip them |
| `helpers/doctor.py` | exit 0 — every recorded input matches the tree |
| `tsc -p tsconfig.check.json` | exit 0 |
| Deployment identity | `0a0996f3…`, unchanged since the re-derivation, so every verdict filed this round is valid |
| Promotion | `NOT_READY` |

## Two structural problems found and fixed during the wave

1. **The spec was both a pinned identity input and the evidence ledger** (G-SEAM-46 adjacent). The first filing changed its digest and broke four `verify-identity.py` checks, two of which forbid filing at all when applied to the live file. Fixed by freezing the as-authored artifact at `qualification/specs/frozen/`, which hashes to exactly the pinned `e5b6a1d2…`. The pin now protects the authored artifact; two new checks constrain the live ledger (same case ids; statuses from the vocabulary).
2. **The spec is a shared mutable file nine agents write to**, and an uncommitted filing was lost once (G-SEAM-42). One agent solved it correctly without being asked: a per-family write script that re-reads immediately before writing, touches only its own cases, and **refuses if another family changed**.

## What this file is not

Nothing here is a verdict. The verdicts are the spec's `status` fields and each
slice's `GATES.md`. This is an index, and the index is worth exactly what the
files it points at are worth.
