# Wave-2 status: ten agents executing the 109-case spec

Recorded by the root agent while the wave is mid-flight, so a reader can tell
progress from a stall without asking.

## Dispatch

Ten agents, one per family, each owning a disjoint slice directory and a disjoint
set of cases in `qualification/specs/acceptance-spec.trusted-local-v1.json`:

| Agent | Family | Cases | Slice |
|---|---|---|---|
| V1 | IDENTITY | 6 (ID-01..06) | `qualification/results/V1-identity/` |
| V2 | COMPOSITION | 14 (CMP-01..14) | `qualification/results/V2-composition/` |
| V3 | IPYTHON | 15 (IPY-01..15) | `qualification/results/V3-ipython/` |
| V4 | NATIVE BRIDGE | 12 (BR-01..12) | `qualification/results/V4-bridge/` |
| V5 | DATA | 12 (DATA-01..12) | `qualification/results/V5-data/` |
| V6 | RECOVERY | 10 (REC-01..10) | `qualification/results/V6-recovery/` |
| V7 | FILESYSTEM | 6 (FS-01..06) | `qualification/results/V7-fs/` |
| V8 | CONCURRENCY | 13 (CAP-01..13) | `qualification/results/V8-capacity/` |
| V9 | VERIFICATION | 9 (VER-01..09) | `qualification/results/V9-verification/` |
| V10 | RESEARCH + CACHE/OBS | 12 (RES-01..06, OBS-01..06) | `qualification/results/V10-research-obs/` |

## What each was given, so the work is reproducible

Every agent received the same four things, and they are the reason this wave is
not repeating wave 1's mistakes:

1. **The measured state of its family**, from the wave-1 agents that did the work:
   the fs swap's control experiment, the capacity gate table, the four byte
   classes, the bridge's two-instrument reachability result, the recovery gates.
   So no agent re-derives what is already measured.
2. **The CPU rules**, because the user raised CPU pressure three times: one test
   file at a time with `--maxWorkers=1 --no-file-parallelism`, one boot at a time,
   no drive-root walks, no load loops, kill everything you spawn.
3. **The traps that already produced false findings here**: a stale `lib/` (two
   retractions came from it), a stale install, a fixed probe output path, a
   hand-built harness that bypassed the product's own path, and an empty negative.
4. **`qualification/runners/verify-spec.py`**, which I added because ten agents
   were filing evidence into the spec and nothing read it back.

## Mid-flight observations

- **Evidence is accumulating in every slice**, and the shape is right: V9 produced
  real acceptance receipts (`receipt-ver01-zero-tests.json` records
  `outcome: zero_tests, passed: false` with the reason "the runner executed zero
  tests, so a green exit code proves nothing"; `receipt-ver03-weakened-refused.json`
  refuses a weakened definition by digest mismatch). V6 is capturing per-test
  transcripts. V1 is capturing identity re-derivation output.
- **No case has been marked yet**, which is correct: agents are filing evidence
  before statuses, which is the order that prevents a status being written from
  memory.
- **Three mis-addressed messages were sent by the root agent and all three were
  caught by the receiving agents** (G-SEAM-37). One of them prevented a real
  error: the agent noticed the brief's labels were another agent's.
- **A label collision was found and is now documented** (G-SEAM-38): T6's gate
  labels are not the spec's case ids, and `FS-06`/`VER-09` in the test files
  describe entirely different subjects from the spec's cases of the same name.
  Every agent was told to map by oracle.

## State of the deliverable at this moment

| Check | Result |
|---|---|
| Typecheck (`tsc -p tsconfig.check.json --noEmit`) | exit 0 |
| Deployment identity | `0a0996f3…`, doctor exit 0, verify-identity 28/28 |
| Promotion decision | `NOT_READY` |
| Spec cases | 109, all `NOT_RUN` (evidence being gathered) |
| Mounted contract guard | `daily-no-sandbox-contract`, 8 checks, 2 failing = G-SEAM-33 |

## What is NOT claimed

Nothing in this file is a verdict about a case. It records dispatch, the inputs
each agent got, and the fact that evidence is accumulating. The verdicts will be
in each slice's `GATES.md` and in the spec's `status` fields, and they are the
only things that count.
