# The restart arm's variance is real: 4 runs by S13 (1 FAIL), 3 by root (0 FAIL)

S13 falsified a claim R5 made about its own fix, and the falsification is worth
recording precisely because a naive reading of my own run would "disprove" it.

## S13's measurement — four ISOLATED runs, one commit, no source change

```
cd D:/DSH/work/wt-s13/packages/dsh-ipython
node node_modules/vitest/vitest.mjs run src/r5-restart-epoch.test.ts
```

| run | result | test time |
|---|---|---|
| 1 | PASS | 5589 ms |
| 2 | **FAIL** | **63710 ms** |
| 3 | PASS | 5150 ms |
| 4 | PASS | 4875 ms |

Run 2 failed with `KernelTransportError: BROKER_FAILURE: RuntimeError: Kernel
didn't respond in 60 seconds`, in a **fresh process booting one kernel** — which is
the exact configuration R5's file header calls deterministic
(`r5-restart-epoch.test.ts:20-24`).

## My own measurement — three runs on the merged tree, all PASS

```
run 1: Tests  1 passed (1)
run 2: Tests  1 passed (1)
run 3: Tests  1 passed (1)
```

**These do not contradict each other, and the way they could be misread is the
reason this note exists.** S13 measured a rate of 1 in 4; I measured 0 in 3. A 1-in-4
rate produces 0 failures in 3 runs about 42% of the time, so three greens are
entirely consistent with a 1-in-4 rate. Reporting my run as "the arm is stable"
would be exactly the error this project keeps recording — a green run of an
intermittent test treated as evidence of the property.

## What R5 claimed, and what is now false

R5's header says the arm was moved to its own process *"where the product property it
measures is deterministic, and the variance is recorded here and in the report rather
than hidden behind a green run."*

The remedy does NOT remove the variance. The "20th arm of a long file" explanation is
**falsified** — it failed in isolation, which is precisely what a load hypothesis
says should be safe. Cause is NOT isolated and S13 offered no replacement theory
rather than guessing. S13 correctly did not retry until green, widen, delete, raise
the timeout, or attempt a fix.

## The operational consequence

**A single green run of `r5-restart-epoch.test.ts` is not evidence that the property
holds.** Any future gate, report, or qualification pass that cites this arm must say
how many times it ran and what the observed rate was. A 1-in-4 failure rate means a
"pass" is roughly a coin flip away from being a fail on the next run, and the failure
looks like a product defect (`KernelTransportError`) rather than like flakiness.

This is filed rather than fixed: the cause needs its own investigation with
instrumentation, and the honest interim state is a recorded rate plus an explicit
warning against treating one green as proof.
