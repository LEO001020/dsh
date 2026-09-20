# V2 ORACLE RESOLUTIONS — root-owned contract decisions

**Owner:** root agent. **Consumers:** R0 (who builds the v2 structure) and every
round-2 writer (who writes v2 oracles).

**Why this file exists.** Several v1 FAILs are not "unimplemented features" but
questions about what the deployment should promise. Those are contract decisions,
and a writer who makes them alone will either invent a requirement or silently drop
one. Each decision below names the measurement it rests on, so a reader can
disagree with the reasoning rather than having to trust the conclusion.

**Standing rule, unchanged:** v1 is frozen. Nothing here edits v1. v2 may
**redefine or drop** an invariant — that is the honest alternative to fabricating a
producer for an oracle nobody believes. But a dropped invariant must be recorded as
dropped, with its v1 FAIL preserved, never retroactively turned into a PASS.

---

## D1 — F9 / `CMP-04` vs `CMP-13`: the spec contradicts itself

**The contradiction, exactly.** `CMP-04` requires `toolCountAgentKey is 28` and
`pwsh is present`. `CMP-13` requires `pwsh` ABSENT. Both are mandatory, both are
measured on the same catalog, so at most one can hold. The cause is an ordering
accident: `CMP-04` was authored at 04:59:30, and commit `35c829d` at 05:18:50 then
disabled `tool-pwsh` unconditionally so IPython became the model's only execution
surface. `CMP-04`'s oracle describes a composition the architecture decision
superseded 19 minutes after it was written.

**Decision: v2 states the CURRENT architecture, and `CMP-04`'s oracle is rewritten
to describe it. `CMP-13` is unchanged.** Concretely, the v2 oracle for the
tool-surface case requires `ipython` present, `work` present, `pwsh` ABSENT,
`error` null, and a tool count that is **measured and recorded in the evidence**
rather than pinned as a literal in the oracle.

**Why the count must not be a literal.** A pinned `28` is what created this defect:
it encoded a composition fact into an oracle, so any legitimate composition change
reads as a product failure. The property the case is actually about is "the
model-visible surface is intact and named" — which is about presence and absence of
named tools, not about an integer. **The count stays in the evidence as a measured
fact and in the diff as a change detector; it does not become a pass condition.**

**What is preserved:** v1 keeps both oracles and both verdicts. The record that the
spec and the deployment diverged stays in the history, which is the whole reason v1
is frozen rather than repaired.

**The measured before/after pair, so v2's number is not taken on trust.** The
existing evidence already contains the two arms, and they differ by exactly one
tool:

| Evidence | `toolCountAgentKey` | `pwsh` present |
|---|---|---|
| `qualification/results/T4-preset/boot-before.json` | **28** | **true** |
| `qualification/results/T4-preset/boot-after.json` | **27** | **false** |

So the composition change removed exactly one tool from the model-visible surface,
and `CMP-13` passes on the same measurement `CMP-04` fails on. **That is the whole
contradiction in one table**, and it is why the count belongs in evidence rather
than in an oracle: a future composition change should move the count without
turning a correct product into a failure.

---

## D2 — F7 / `DATA-09` and IPY-15: two different things were conflated

**The conflation.** v1's coverage taxonomy mixes:
- **did the world/provider/transport actually give us complete data** (an
  acquisition fact), and
- **we have the complete data and this is how much of it the LLM was shown** (a
  projection choice).

These are not the same epistemic thing, and the audit's phrasing is the reason it
matters: *"provider 少给了数据"* and *"我已经完整拿到 30 MB，但只给 LLM 看 2 KB"* cannot
be one enum.

**Decision: v2 splits them, and neither is a gap in the other's vocabulary.**

```
AcquisitionCoverage:  provider-acquisition | native-acquisition | transform | retention
                      transport  -- ONLY if a partial-success transport actually exists

ProjectionManifest:   sourceRef, selectedBytes/items, omittedBytes/items when knowable,
                      recoverable ref, projectionReason
```

**Intentional model projection is NOT an acquisition gap.** Recording a deliberate
projection as a loss would make an honest system look broken and a broken system
look honest.

**`transport`: v2 does NOT require a producer unless one is real.** The v1 oracle
demands a `transport` stage and a `model-projection` stage each appear as a gap.
For `transport` the measured behaviour is that an oversized frame is **rejected
before any successful value exists** — the encoder refuses, and the decoder refuses
before buffering. So there is no partial success to attribute, and inventing a
"transport gap" would require deliberately degrading a hard failure into a silent
one.

**Decision for IPY-15 specifically: keep fail-hard.** Expose a structured
`FRAME_TOO_LARGE` / `rejectedFrame` metric and a count, and **remove the dead
`droppedFrames` requirement from v2.** The v1 oracle's phrase *"reported as LOST
with a count"* describes drop-and-continue; the product rejects, so the honest
contract is a refusal that names the limit. **A failed transport is a failed
operation, not a partial successful observation.**

`model-projection` likewise: it becomes a `ProjectionManifest` fact, not an
`AcquisitionCoverage` gap.

---

## D3 — F8 / `REC-09` + `REC-10`: decide from topology, not from the oracle

**Not decided here.** Writer R9 builds the production topology graph and decides
whether stale-generation settlement is physically possible. If it is, fencing is
implemented at the authoritative reservation and compared inside the same durable
update that releases the reservation. **If it is not, the recovery machinery is
deleted and v2 does not claim the guarantee, with the v1 FAIL preserved.**

**The one thing v2 may not do is manufacture a caller.** Both outcomes are
legitimate; inventing a cross-process worker to make the case green is not.

**Related and separate:** `G-SEAM-50` records that `CMP-06`'s protection is
unreachability rather than immutability. If R9's answer is "delete", the same
distinction must be stated: a claim is being removed that was never true, not a
working mechanism being removed.

---

## D4 — `ID-05`: the escape-hatch clause is REPAIRABLE, and the sweep is mechanical

**Measured by root, not assumed.** `ID-05`'s oracle forbids `as never`. The case
failed on that clause alone, with 475 occurrences recorded and the note stating the
oracle *"names neither carve-out"*.

**A probe file compiled under `tsconfig.check.json`** — with the file's presence in
the program proven by an injected `TS2322` appearing at the probe's own line —
established that the casts are unnecessary, and that one of the two idioms was
hiding a real diagnostic:

| Idiom | Result |
|---|---|
| `ctx.plugin(plugin as never, cfg as never)` | The cast on the PLUGIN is noise: `ctx.plugin(plugin, cfg)` compiles clean. |
| `ctx.plugin(Storage, {} as never)` | **The cast MASKS an error**: `Argument of type '{}' is not assignable to parameter of type 'undefined'`. This plugin takes no config, so the argument should be OMITTED. `ctx.plugin(Storage)` compiles clean. |

**So the clause is about something real** — in config position the idiom suppresses
a true diagnostic, which is precisely "used to hide a genuinely undefined value".

**Decision: v2 keeps the clause, and the sweep is a named slice.** Counts under one
scanner: **488 total — 478 in `*.test.ts`, 10 in non-test files** (6 in
`src/durability-runner.ts:37,38,39,65`; 3 in `dsh-ipython/src/v4-bridge-probe.ts`;
1 in `dsh-daily-work/src/v4-scope-probe.ts`). The case's note says 475; the 13-count
delta is **not reconciled** and is recorded as such — the two counts may use
different scanners, and that discrepancy is itself worth knowing before v2 restates
a number.

**Two different repairs, and the distinction matters:** drop the cast on the plugin
argument; and either omit the config argument or type it correctly. **Never replace
`as never` with `as any`** — that trades a visible cast for an invisible one.

**Scheduling:** the sweep touches 478 test occurrences across many test files, and
writers R3/R4/R5/R7 are editing test files right now. **It is therefore a round-2+
slice, deliberately deferred rather than raced**, because a mechanical sweep across
files under concurrent edit is how this project produced five git accidents in one
round.

---

## D5 — `BR-07`: the disposition vocabulary is required, and the scope route proves it

The oracle requires every in-flight call to carry one disposition from `settled`,
`cancelled`, `handed-to-jobs`, `abandoned-unstarted`, with a job id when handed to
Jobs, and states: *"Nothing continues silently in the background with no record."*

**Measured:** `disposition`/`jobId`/`handoff` appear **0 times** in `bridge.ts` and
`native-call.ts`, and **21 times** in `programmatic-scope.ts`. The lease discipline
IS real — a `revoke` waited 1499 ms for an in-flight call and a post-revoke call was
refused `LEASE_REVOKED` — so **the record is what is missing, not the discipline.**

**Decision: v2 keeps the oracle unchanged, and the bridge adopts the scope route's
existing vocabulary** rather than inventing a parallel one. Writer R5 owns this.
The 1499 ms wait is exactly the case the oracle names: a call continuing in the
background with nothing written about what became of it.

---

## D6 — the artifact identity scheme v1 is missing

`ID-01` FAILs on its graph clause because one specifier —
`@deepseek-ai/dsh-attachment-local/src/store.ts`, imported by the BUILT
`packages/dsh-daily-work/lib/artifacts.js` — resolves to `src/` rather than `lib/`.
That is writer R2-F4's slice.

**Root note for v2:** `ID-01`'s oracle is sound as written and needs no redefinition.
Its failure is a product defect, not a spec defect, and it is the one FAIL in the
set whose oracle should be carried into v2 **verbatim**.
