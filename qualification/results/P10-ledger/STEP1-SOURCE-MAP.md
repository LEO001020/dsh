# P10 STEP 1 — SOURCE MAP (reading only, no behaviour changed yet)

Slice P1.3 — a requested durable bridge ledger silently degrades to memory.
worktree `D:\DSH\work\wt-p10` / branch `wt/p10`.
This file is a reconnaissance record committed BEFORE any edit, so the reading
survives even if the edit does not.

---

## (a) THE EXACT LEDGER-OPEN CALL SITE

`packages/dsh-ipython/src/kernel-plugin.ts`, inside `KernelService.entryFor`
(the creation transaction), **lines 529–546**:

```ts
529:      // ---- STEP 6: publish READY --------------------------------------------
530:      // The ledger is opened here too, and it is the LAST thing before the insert
531:      // for the same reason as the bridge: a Session whose kernel is published
532:      // must have somewhere to record what its cells did.
533:      const opened = this.config.durableLedger === false
534:        ? undefined
535:        : await openBridgeLedger(storageFacilityOf(this.ctx)).catch(() => undefined)
536:      const entry: Entry = {
537:        host,
538:        identity,
539:        bridge: capability,
540:        ledger: opened?.ledger ?? new MemoryBridgeLedger(),
541:        ledgerDurable: opened?.durable === true,
542:        lifecycle: 'READY',
...
546:      }
547:      this.entries.set(identity.sessionId, entry)
548:      return entry
```

THE DEFECT, in two places on two lines:

- `:535` — `.catch(() => undefined)` swallows every failure of
  `openBridgeLedger`. There is no record that it failed, and no rethrow.
- `:540` — `opened?.ledger ?? new MemoryBridgeLedger()` substitutes an
  in-memory ledger for the durable one that was REQUESTED.

So a caller that left `durableLedger` at its default (unset, i.e. "yes please")
receives an in-memory ledger, and the only difference from a genuinely durable
run is a boolean nobody is required to look at. The evidence that decides
whether an external effect may be retried is then destroyed at process exit,
silently.

Re-verified against the tree, not copied from the brief: the brief cites
`:540` for the fallback and `:541` for the field. Both match exactly at HEAD
`2e1b2c2`. The surrounding guard at `:533` is also already present and is the
half of the V5 semantics that already exists.

### The default is `undefined`, and `undefined` means "required"

`KernelServiceConfig.durableLedger` (`kernel-plugin.ts:182`, optional):

> "Whether to record the bridge ledger in the DSH storage domain when one is
> mounted. **Default true.**"

Its own doc comment at `:174-181` states the reasoning that produced the silent
fallback:

> "Stated as a knob rather than hardwired because a minimal test host has no
> storage facility, and refusing to bridge for want of a ledger would turn a
> provenance gap into a capability outage."

That reasoning is not absurd — but it is a decision made for the *test* host
and applied to the *final daily* deployment. V5 §11.1 separates the two:
`false` is the explicit development arm, everything else must open.

`openBridgeLedger` (`bridge-ledger.ts:438-442`) returns `undefined` for
`facility === undefined` rather than throwing, and its doc comment says the
caller decides. The caller (`:533-541`) does not decide — it falls back.

## (b) DOES ANYTHING READ `ledgerDurable`?

YES — exactly one reader, and it is not the enforcement path.

| location | what it does |
|---|---|
| `kernel-plugin.ts:309` | `readonly ledgerDurable: boolean` — the `Entry` field |
| `kernel-plugin.ts:541` | the only WRITER (`opened?.durable === true`) |
| `kernel-plugin.ts:718-720` | `KernelService.ledgerIsDurable(agent)` — the only READER |
| `qualification/runners/r5-bridge-product.mjs:214` | probe reads `ledgerIsDurable` |
| `qualification/results/S13-br07/s13-br07-probe.mjs:263` | probe reads `ledgerIsDurable` |

**Nothing in the production path branches on it.** The two consumers are
qualification probes that RECORD the value into a JSON artifact. No code
refuses, retries, warns, or changes behaviour based on `ledgerDurable`.

This is the "mechanism with no consumer" class this project records repeatedly
(G-SEAM-31, G-SEAM-34, G-SEAM-52). The information that durability was lost is
computed, stored on the entry, exposed on a public method, and read only by
instruments that write it into a file. A boot that silently degraded to memory
reports `ledgerDurable: false` in a probe artifact and nothing else happens.

**Stated plainly: the field is honest and inert.** The fix is therefore not to
compute the truth — it already does — but to make the truth load-bearing.

## (c) EVERY CALL SITE THAT MOUNTS A KERNEL, AND WHETHER IT HAS A STORAGE FACILITY

Classification key:
- **PRODUCTION** — the real deployment path; must now REQUIRE storage.
- **TEST/DEV-EXPLICIT** — a genuine unit-test/development host with no storage
  facility; `durableLedger: false` is the CORRECT, honest value.
- **TEST-SHOULD-UPGRADE** — a test that mounts no storage today but whose
  subject is the ledger itself; must mount storage rather than opt out.
- **AMBIGUOUS** — needs a decision (see notes).

### Production

| # | site | storage facility? | verdict |
|---|---|---|---|
| 1 | `packages/dsh-ipython/src/host-plugin.ts:70` — `new KernelService(ctx, config)`, config from `cordis.patch.yml` | YES — the `daily-candidate` profile mounts `@deepseek-ai/dsh-base`, whose `packages/bundle/base/cordis.patch.yml:160-163` inserts `storage-domain` with `backend: json` | **PRODUCTION — must REQUIRE.** `cordis.patch.yml` does NOT currently set `durableLedger` at all, so it rides the default. This is the site the V5 requirement is about. |

That is the ONLY production construction site. `grep -rn "new KernelService"`
over the repo (excluding `node_modules`/`lib`) returns exactly one non-test
caller: `host-plugin.ts:70`.

### Tests and probes with NO storage facility

These construct a `KernelService` on a context that mounts only
`SystemPrompt` + `ToolRuntime` + `Subprocess`. There is no `storageDomain`
row, so `storageFacilityOf(ctx)` is `undefined` and
`openBridgeLedger(undefined)` returns `undefined` **by design**. Under the new
semantics these would all refuse READY unless they opt out explicitly.

| # | site | subject | verdict |
|---|---|---|---|
| 2 | `bridge-seam.test.ts:216` | bridge seam, hand-minted lease | **TEST/DEV-EXPLICIT** — not about the ledger; mounts no storage. `false` explicit. |
| 3 | `bridge-seam.test.ts:286` | same | TEST/DEV-EXPLICIT |
| 4 | `bridge-seam.test.ts:348` | same | TEST/DEV-EXPLICIT |
| 5 | `bridge-seam.test.ts:419` | same | TEST/DEV-EXPLICIT |
| 6 | `bridge-seam.test.ts:514` | error arm (`kernels-err`) | TEST/DEV-EXPLICIT |
| 7 | `bridge-seam.test.ts:557` | unknown-outcome arm | TEST/DEV-EXPLICIT |
| 8 | `bridge-seam.test.ts:610` | deny arm | TEST/DEV-EXPLICIT |
| 9 | `bridge-seam.test.ts:686` | deny2 arm | TEST/DEV-EXPLICIT |
| 10 | `bridge-seam.test.ts:747` | slow arm | TEST/DEV-EXPLICIT |
| 11 | `bridge-seam.test.ts:819` | big arm | TEST/DEV-EXPLICIT |
| 12 | `bridge-seam.test.ts:1262` | tc2 arm | TEST/DEV-EXPLICIT |
| 13 | `faults.test.ts:358` | restart/epoch faults | TEST/DEV-EXPLICIT |
| 14 | `lifecycle.test.ts:66` (`makeService`) | kernel lifetime, process ancestry | TEST/DEV-EXPLICIT |
| 15 | `service.test.ts:63` (`makeService`) | registry/identity | TEST/DEV-EXPLICIT |
| 16 | `service.test.ts:139` | duplicate-registration refusal — asserts the CONSTRUCTOR throws | TEST/DEV-EXPLICIT |
| 17 | `v3-spec-gates.test.ts:107` | spec gates | TEST/DEV-EXPLICIT |
| 18 | `packages/dsh-daily-work/src/data-plane.test.ts:469` | data plane over a real kernel | TEST/DEV-EXPLICIT — subject is the data plane, not the ledger |
| 19 | `s5-ipy13-delivery-probe.ts:40` | IPY-13 probe | TEST/DEV-EXPLICIT |
| 20 | `v4-bridge-probe.ts:260` | bridge probe | TEST/DEV-EXPLICIT |
| 21 | `v4-bridge-drain-probe.ts:83` | drain probe | TEST/DEV-EXPLICIT |
| 22 | `v4-bridge-approval-probe.ts:138` | approval probe | TEST/DEV-EXPLICIT |
| 23 | `t7-measure.ts:165` | T7 measurement | TEST/DEV-EXPLICIT |
| 24 | `qualification/results/R5-data/ipython-substitution-probe.mjs:75` | substitution probe | TEST/DEV-EXPLICIT |
| 25 | `packages/dsh-ipython/src/r5-restart-epoch.test.ts:58` | restart/epoch, **already `durableLedger: false`** | TEST/DEV-EXPLICIT (already correct) |

### Tests that DO mount storage, and are therefore already on the durable path

| # | site | storage facility? | verdict |
|---|---|---|---|
| 26 | `r5-product-bridge.test.ts:104` | the file mounts `Storage` + `storage-json` + `storage-domain` at `:1415-1419` for its crash-reopen arm, but the SHARED `beforeEach` service passes **`durableLedger: false`** (`:108`) | **TEST-SHOULD-UPGRADE (partial)** — see note N1. |
| 27 | `packages/dsh-daily-work/src/data-plane.test.ts` | mounts `storageDomainPlugin` (6 references) but its `KernelService` at `:469` is in a helper whose context mounts only `SystemPrompt`/`ToolRuntime`/`Subprocess` | TEST/DEV-EXPLICIT as measured; re-check at edit time |

### Notes that decide the design

**N1 — `r5-product-bridge.test.ts:108` passes `durableLedger: false` for the
WHOLE FILE, including the arm that mounts a real storage domain.** Its own
comment justifies it: *"The ledger is durable by default; this test asks for the
in-memory one so the suite needs no storage facility, which is a configuration
difference and not a wiring difference."* That was true when written. It is now
the reason the file's shared service cannot be switched to the durable default
wholesale: the crash-reopen arm builds its OWN context and its OWN ledger via
`openBridgeLedger` (`:1418`), so it is unaffected, but every other arm in the
file would need a storage facility to keep working. Decision deferred to the
edit step; recorded here so it is a decision rather than an accident.

**N2 — a SECOND, DEEPER DEFECT FOUND WHILE READING, NOT YET REPRODUCED.**
`openBridgeLedger` calls `facility.open(bridgeLedgerDomainSpec)` on every
invocation, and it is invoked per Session (from `entryFor`, once per new
Session id). But `DomainFacility.open` (`@deepseek-ai/dsh-storage-domain`,
`packages/storage/storage-domain/src/index.ts:103-106`) refuses a name that is
already open:

```ts
if (this.reserved.has(spec.name)) {
  throw new DomainError('already-open', `domain '${spec.name}' is already open`)
}
```

There is no memoisation anywhere: `openBridgeLedger` has no cache, and
`KernelService` holds no `opened` handle — the ledger handle lives only on the
per-Session `Entry`. So in a process with TWO sessions that each start a kernel,
the second `entryFor` should hit `already-open`, have it swallowed by
`.catch(() => undefined)` at `:535`, and fall back to `MemoryBridgeLedger`
(`:540`) — i.e. the FIRST session is durable and the SECOND is silently not.

`facility.get(name)` exists (`storage-domain/src/index.ts:184-186`) and is the
obvious reuse seam, but it is documented as "Diagnostic surface" and returns the
untyped `DomainImpl`, so reusing it needs care.

STATUS: **HYPOTHESIS, NOT YET MEASURED.** Stated here as a hypothesis precisely
because this project's record is that plausible causal stories are the thing
most often wrong. It will be measured before it is claimed, and retracted if
false. If it holds, it is a second reason the fallback is wrong: the failure is
not hypothetical ("the facility might fail"), it is ROUTINE (the second session
in every multi-session process).

## What is NOT established by this file

- No behaviour was changed and no test was run to produce this document.
- The `already-open` path (N2) is a reading of two source files, not a
  measurement.
- The classification of sites 2–25 as TEST/DEV-EXPLICIT is a judgement about
  each test's SUBJECT made by reading its file header; it is not yet confirmed
  by running them under the new default.
