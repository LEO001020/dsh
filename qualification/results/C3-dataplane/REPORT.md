# C3 — the two data-plane defects: DATA-09 and DATA-11

Writer: **c3**, branch `wt/c3`, worktree `D:\DSH\work\wt-c3`.
Every measurement below was taken in **this** worktree against the **built**
`packages/dsh-daily-work/lib/`, which is what the profile loads
(`main: lib/host-plugin.js`). Each probe reports the `src` and `lib` digests it
measured so a reader can check that the lib was built from the src it names.

Rebuild command used before every measurement (the stale-artifact trap):

```
node D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p packages/dsh-daily-work/tsconfig.json
```

## Summary of the verdicts

| case | requirement | verdict | what changed |
|---|---|---|---|
| **DATA-09** | every observation gap is attributed to a stage | **PASS on the oracle's own clause** — a genuine unrecorded loss was found and is now recorded | `artifacts.ts`: the shortfall expectation is derived from the REQUEST, not only from `stat` |
| **DATA-11** | a page cursor is not a bearer token | **PASS** — the different-STORE arm and the different-REVISION arm both refuse and record; the paging path is no longer the weaker route to the same bytes | `artifacts.ts`: the identity memo now moves with `ctimeMs` |

## Honest framing, stated first

Two things must be said before the measurements, because they change how the
verdicts should be read.

**1. The v1 spec's six-stage stimulus is not the current contract, and I did not
"fix" DATA-09 by inventing producers for it.** The shared base already contained
commit `f363fbe` ("DATA-09 / F7"), which replaced the v1 six-name gap set with the
four acquisition stages, moved `model-projection` to a `ProjectionManifest`, moved
`transport` to an error path, and raised `OBSERVATION_SCHEMA_VERSION` to 2. The
coordinator's brief told me to find a real loss at `transport` (and `model-projection`
"if it truly has no producer") and record it — but I could not do that honestly, and
the v2 definition spec agrees:

> `model-projection` is not an acquisition gap but a projection choice, and is
> measured by DATA-13 as a ProjectionManifest; `transport` is not an acquisition gap
> because the product REJECTS an over-limit frame before any successful value exists,
> so there is no partial success to attribute. Recording a deliberate projection as a
> loss, or inventing a partial-success transport to have something to attribute, is
> NOT PASS.
> — `qualification/specs/acceptance-spec.trusted-local-v2.definition.json`, DATA-09

So adding a `transport` producer would have been the one thing the case explicitly
forbids, and would have required degrading a hard refusal into a silent drop. I did
**not** add a seventh stage, a second gap record type, or a fabricated producer.

**2. The v1 FAIL evidence is stale, but the case was still genuinely FAILing — for a
different reason than the recorded one.** The recorded FAIL says "4 of 6 stages have a
producer". Under the current contract that measurement no longer applies (there are
four stages and all four have producers). But DATA-09's oracle has a second clause,
and *that* clause was false: **"A loss that is not recorded as a gap is NOT PASS."** I
found a real unrecorded loss, measured it through the product path, and fixed it. That
is the substance of the DATA-09 work below.

---

## DATA-09 — every observation gap is attributed to a stage

### What I verified about the stage vocabulary

`qualification/results/C3-dataplane/c3-dataplane-probe.mjs`, run against the built lib:

```
closedSet                 [provider-acquisition, native-acquisition, transform, retention]
closedSetSize             4
coverageMatchesGapStages  true
recoveries                [page, refetch, none, unknown]
producers                 provider-acquisition: web-provenance.ts:355
                          native-acquisition:   artifacts.ts:2733
                          transform:            web-provenance.ts:500, :516
                          retention:            artifacts.ts:2671, :2792, :2814
                          transport:            []            <- none
                          model-projection:     []            <- none
stagesInClosedSetWithNoProducer  []
v1StagesAbsentFromClosedSet      [transport, model-projection]
allClosedSetStagesProduced       true
gapSchemaAcceptsOnlyClosedSet  { closedSetStageAccepted: true,
                                 transportRejected: true,
                                 modelProjectionRejected: true,
                                 badRecoveryRejected: true }
```

The producer detector strips block **and** line comments before matching, because a
comment that names a stage is not a producer — the module's own doc comments say
`v1 filed {stage: 'model-projection'}` as a loss, and a naive grep reports three
producers for `model-projection`, all prose. This confirms the coordinator's warning
that some `model-projection` hits are comments only: they are *all* comments, and
`transport` has no producer at all.

**Conclusion on the vocabulary: all four stages in the closed set have a real
production producer; `transport` and `model-projection` are not vocabulary members and
the schema refuses them.** I did not change the stage set.

### The genuine unrecorded loss I found

`artifacts.ts` guarded the acquired-vs-persisted shortfall like this:

```ts
const shortBy = sourceBytesAtStart !== undefined && request.requestedRange === undefined
  ? sourceBytesAtStart - published.bytes
  : 0
```

Every range request therefore forced `shortBy = 0`, on the reasoning that "a range
request legitimately captures fewer bytes than the file holds". **That reasoning is
true only while the range lies INSIDE the source.** For a range extending past EOF it
is false, and `observations.ts` defines `partial` as exactly *"bytes inside the
requested range are known to be absent"*.

Measured through the **product** path (`DataPlane.fsCapture` via `DataPlaneService`),
400-byte file, probe `c3-product-range-probe.mjs`:

| arm | requested range | requested bytes absent | completeness | gaps | deliverable |
|---|---|---|---|---|---|
| control | `{offset: 0, length: 1024}` of a 4096-byte file | 0 | `complete-within-request` | `[]` | true (correct) |
| **A** | `{offset: 0, length: 1000}` | **600** | `complete-within-request` | **`[]`** | **true** |
| **B** | `{offset: 1000, length: 512}` | **512** | `complete-within-request` | **`[]`** | **true** |

Arm B is the sharper one: the object published was **0 bytes**, every requested byte
was absent, and the record still said the request was complete and
`isDeliverableAsComplete` returned `true`. That is "an unknown reported as success",
which the module forbids in its own words.

I also checked that this is a property of the range read and not of one backend:
`readByteRange` returns the clamped window (measured directly — `{offset:0,length:1000}`
of a 400-byte file returns 400 bytes; `{offset:1000,length:512}` returns 0), so the
shortfall is real and the primitive is behaving correctly. The defect was solely in
what the capture RECORDED about it.

### The change

`packages/dsh-daily-work/src/artifacts.ts`, in `captureFile`, the shortfall block
(now ~lines 2770–2830). The expectation is derived from the **request**:

```ts
const requestedRange = request.requestedRange
const expectedBytes = requestedRange === undefined
  ? sourceBytesAtStart
  : requestedRange.length ?? (sourceBytesAtStart === undefined
    ? undefined
    : Math.max(0, sourceBytesAtStart - requestedRange.offset))
const shortBy = expectedBytes === undefined ? 0 : expectedBytes - published.bytes
```

- **whole file** → every byte the source had at capture start (unchanged behaviour);
- **range with `length`** → the length the caller NAMED, even when the source is
  shorter, because a byte inside a named range the source does not have is still
  absent from the request;
- **open-ended range** → offset to end of source, so an offset at or past EOF implies
  zero bytes and correctly records **no** loss.

`shortBy` then drives **both** the gap and `completeness`, so the two cannot disagree.

**Recovery is decided, not defaulted.** A shortfall caused by a reader stopping early
is still `refetch` (verified: the whole-file short-reader arm still reports
`refetch`). A range that overhangs the source cannot be fixed by re-reading the same
path, so it is `none` — not a promise the plane cannot keep.

Uses the **existing** gap API, the **existing** closed stage set
(`native-acquisition`), and the **existing** recovery vocabulary. No seventh stage, no
second gap record type, no fabricated gap: the control arm (range inside the file)
still records **no gap**.

### BEFORE / AFTER

Command (identical both times, `--label` differs):

```
node qualification/results/C3-dataplane/c3-product-range-probe.mjs --label before|after
```

| arm | BEFORE | AFTER |
|---|---|---|
| control, range inside file | no gap, `full-for-requested-scope` | no gap, `full-for-requested-scope` (unchanged) |
| A, overhang 600 B | `complete-within-request`, `gaps []`, deliverable **true** | `partial`, `native-acquisition`/`none`, reason names **600**, `partial-native-acquisition`, deliverable **false** |
| B, all 512 B absent | `complete-within-request`, `gaps []`, deliverable **true** | `partial`, `native-acquisition`/`none`, reason names **512**, deliverable **false** |

Raw: `product-range-before.json`, `product-range-after.json`. The same fix measured at
the `captureFile` primitive: `gap-hole-before.json`, `gap-hole-after.json`.

### Does the oracle now hold?

**Yes, on the clause that decides the case.** The oracle's rule is "a loss at one of
those four stages that is not recorded as a gap is NOT PASS"; the unrecorded loss I
measured is now recorded, under the correct stage, with a recovery from the closed set,
and the completeness flag agrees with the gap list.

Two clauses of the **v1** oracle do **not** hold and cannot: the v1 stimulus names six
stages including `transport` and `model-projection`, and both are deliberately absent
from the v2 vocabulary for the reasons the v2 spec states. If the case is graded
against the **v1** text literally, DATA-09 remains FAIL on that clause — but satisfying
it would require the fabricated producers the same case forbids, so I judge the honest
answer to be: the case is satisfied against v2, and the v1 text is superseded by the
coordinator's own definition spec. **This is the one point a reader should check
against the coordinator's intent.**

---

## DATA-11 — a page cursor is not a bearer token

### The different-STORE arm the oracle names FIRST

`qualification/results/C3-dataplane/c3-dataplane-probe.mjs`. Two stores over two real
roots, both holding the SAME bytes under the same content address, so the store
identity is the only thing separating them:

```
realmA                          realm_1d08ad8c-ae33-44d1-9a4c-394c59974795
realmB                          realm_b05ec90e-8b82-460c-b5ca-add121d02c30
realmsDiffer                    true
sameSha256InBothStores          true
```

| arm | result |
|---|---|
| **control** — cursor against its OWN store | serves 64 bytes, offset 64 (GREEN) |
| **control 2** — issued cursor replayed on its OWN store | serves 64 bytes (GREEN) |
| **different STORE** (same bytes) | **refused**, `pagination-realm-denied`, `realmRefused: true`, refusal recorded at step `realm` |
| **different REVISION** | **refused**, `pagination-scope-denied`, refusal recorded at step `reference` |
| integrity — object corrupted in its OWN store | refused, `artifact-integrity-error`, recorded at step `identity` |
| `DATA_11_ORACLE_SATISFIED` | **true** |

`differentStoreYieldedBytes` is `null` — no byte was served. The refusal is
**recorded**, not merely raised: the refusal sink fired with
`{code: pagination-realm-denied, step: realm}`.

### What this means against the recorded FAIL

The coordinator's measured FAIL for DATA-11 ("the different-STORE arm is NOT refused
and yields 64 bytes, hashing `cc7321cc…` while the descriptor names `9076e7f7…`") was
taken **before** commit `2af7ef2` ("DATA-11: bind a page cursor to its store realm, and
record the refusal"), which is an ancestor of this branch's base. On the current tree
that arm **is** refused and recorded. I verified this myself rather than quoting the
archived `R7-cursor-realm/after.json`, because those files were measured against
`D:/DSH/work/wt-r7` (their `identity` block hashes that tree).

### The harm the case names was still reachable — and I closed it

The spec's evidence note defines the harm as a **disagreement between two read paths**:

> with the object corrupted in the store the descriptor was minted from, `pages()`
> serves 64 bytes hashing `cc7321cc…` while the descriptor names `9076e7f7…`, and
> `resolveReference()` refuses the same object with `artifact-integrity-error`.

I reproduced exactly that shape, by a route the realm check cannot see. The mechanism
is the identity memo in `assertObjectIdentity`:

```ts
const stamp = `${String(info.size)}:${String(info.mtimeMs)}`
if (this.verifiedObjects.get(artifact) === stamp) return   // digest SKIPPED
```

Both stamp fields are settable by whoever can write the store root. A naive
same-length replacement fails, because this filesystem keeps sub-millisecond mtime
precision and `utimesSync` cannot reproduce the fraction (measured: `…932.5093` →
`…932.0` or `…932.5088`, never equal). **The attack that works pins the mtime to a
WHOLE SECOND first** — a whole second *is* exactly reproducible.

Probe `c3-memo-probe.mjs`, five steps, BEFORE the fix (`memo-before.json`):

```
pin the object's mtime to a whole second     mtimeMs 1789918753000 (whole second)
page once                                    isTheNamedArtifactPrefix true, cursor issued
replace, same length, different bytes        3229b5c9… vs named 1959faf5…
restore the SAME whole second                stampMatches TRUE
present the cursor again                     REFUSED: false
                                             served 16da1e97…, refusals []
resolveReference on the same object          refused (artifact-orphaned)
a COLD store over the SAME root              refused (artifact-integrity-error)
```

The last two lines are what make it a defect rather than a probe artifact: **the
replacement was detectable, and an empty memo detected it.** Only the warm memo skipped
the hash, and the paging path was the route that skipped it — "the cursor path is the
weaker route to the same bytes", which is precisely what the case forbids.

### The change

`packages/dsh-daily-work/src/artifacts.ts`:

1. The stamp is now built by one named function, `identityStampOf()`, over
   `(size, mtimeMs, ctimeMs)`:

   ```ts
   function identityStampOf(info: { size: number; mtimeMs: number; ctimeMs: number }): string {
     return `${String(info.size)}:${String(info.mtimeMs)}:${String(info.ctimeMs)}`
   }
   ```

   `ctimeMs` is load-bearing and not another guess: POSIX does not let
   `utimes`/`utimensat` set `ctime`, and the write that performs the replacement
   updates it. Measured: the same-length replacement with the mtime restored to the
   same whole second left `mtimeMs` identical and **moved** `ctimeMs`. Keeping the
   stamp in one function is the point — a second call site cannot quietly use a weaker
   one. This reuses the **existing** integrity seam rather than adding a new one.

2. **The prose that documented the hole as accepted is corrected.** The old comment
   said a replacement preserving "BOTH the length and the mtime (a hostile writer with
   filesystem access) is not caught by the stat comparison" and left it there. A
   documented hole is still a hole, and this one was reachable with ordinary file APIs
   — so it is now recorded as measured and fixed, with the narrower limit that remains
   stated honestly (an attacker who can rewrite filesystem metadata below the syscall
   layer, or rewrite the index the digest is compared against, is inside the trust
   boundary this class does not defend — the same statement the file already makes for
   the store realm).

### BEFORE / AFTER — all three arms the brief asks for

Command: `node qualification/results/C3-dataplane/c3-memo-probe.mjs --label before|after`

| arm | BEFORE | AFTER |
|---|---|---|
| **different STORE** (same bytes) | refused `pagination-realm-denied`, recorded | unchanged — refused, recorded |
| **different REVISION** | refused `pagination-scope-denied`, recorded | unchanged — refused, recorded |
| **control** — own store | serves 64 bytes | unchanged — serves 64 bytes |
| memo attack: replacement preserving length+mtime | **cursor SERVED the replaced bytes**, refusals `[]` | **refused `artifact-integrity-error`**, recorded at step `identity` |
| `PAGING_IS_THE_WEAKER_ROUTE` | **true** | **false** |

Raw: `before.json`/`after.json` (arms), `memo-before.json`/`memo-after.json` (harm).

### Does the oracle now hold?

**Yes.** "The cursor is refused and the refusal is recorded" holds for both named
stimuli — a different store and a different revision — each with a recorded refusal. "A
cursor that yields pages from a store it was not issued for is NOT PASS" no longer
occurs, and the weaker-route variant of the same harm (serving replaced bytes from the
store it *was* issued for) is closed too. The control arm stays green, so the binding
is not a refusal-everywhere.

---

## Files changed

| file | what it does |
|---|---|
| `packages/dsh-daily-work/src/artifacts.ts` | `identityStampOf()` (new) + the memo now moves with `ctimeMs`; the shortfall expectation derived from the request; the gap reason and recovery; corrected prose at both sites |
| `packages/dsh-daily-work/src/data-r6.test.ts` | NEW test pinning the past-EOF gap (3 arms + the kept adjacent control); `isDeliverableAsComplete` added to the existing import |
| `packages/dsh-daily-work/src/data11-cursor-realm.test.ts` | NEW test pinning the length+mtime replacement refusal; `utimesSync` added to the existing import |

No assertion was deleted, loosened, or made to pass by removing its subject.

## Tests run (one at a time, as instructed)

```
node packages/dsh-ipython/node_modules/vitest/vitest.mjs run packages/dsh-daily-work/src/data-plane.test.ts   -> 82 passed
node packages/dsh-ipython/node_modules/vitest/vitest.mjs run packages/dsh-daily-work/src/data-r6.test.ts      -> 48 passed (47 before; my pin is the 48th)
node packages/dsh-ipython/node_modules/vitest/vitest.mjs run packages/dsh-daily-work/src/data11-cursor-realm.test.ts -> 38 passed (37 before; my pin is the 38th)
```

**Falsification of both new pins**, so neither can be a test that merely restates the
code. Each was run against a deliberately reverted build:

```
memo stamp reverted to (size, mtimeMs)          -> 1 failed | 37 passed
DATA-09 expectation reverted to range-blind     -> 1 failed | 47 passed
```

Both fixes were then restored, rebuilt, and both files re-run green.

## What I could not establish / open items

1. **DATA-09 against the v1 spec text remains unsatisfiable without fabrication.**
   Stated above. My verdict is "PASS against the v2 definition spec, and the v1
   six-stage stimulus is superseded"; a reader who must grade against the v1 text
   literally should record it as still FAIL and treat the v2 text as the resolution.

2. **`transport` has a real loss with no producer, in the IPython plane.**
   `OutputBuffer.note_dropped_frame` (`packages/dsh-ipython/src/broker.py`) still has
   **zero call sites** (measured: one occurrence, the `def`), so `droppedFrames` is
   structurally always 0, and that count is never wired into `acquisition.gaps`. I did
   **not** wire it: it lives in another package (`dsh-ipython`), the v2 spec explicitly
   says a transport loss is an error rather than a gap, and `protocol.ts` refuses an
   over-limit frame in both directions before any value exists — so there is no partial
   success to attribute. Recording it as a gap would be the fabricated producer the
   case forbids. Reported, not changed.

3. **A shared-index-root store pair is refused for the wrong reason.** Two stores
   sharing an index root (so sharing realm *and* cursor key) but resolving bytes from
   different homes are refused only because the second home holds no object — the
   refusal is an ABSENCE (`artifact-integrity-error`), not a realm decision. It is
   still a refusal, so the oracle holds, but the realm check is not what does the work
   there. Recorded, not fixed: it is a store-layout question.

4. **Concurrency in my worktree.** A second agent was committing to branch `wt/c3` and
   writing into `qualification/results/C3-dataplane/` during my run (commits `2eb8d7f`,
   `4e85b64`, and probe files `c3-arm-probe.mjs`, `c3-shared-index-probe.mjs`,
   `c3-page-identity-probe.mjs` that I did not author). My source changes and pins are
   intact and verified byte-identical to what I wrote (`diff` against my own saved copy
   is empty; `git status` on `src/` is clean). The foreign commits touch only probes and
   the R7 runner, not `artifacts.ts`. A reader should be aware the branch is not
   single-writer.

5. **The R7 boot-level probe was not re-run by me.** It needs a full profile boot and a
   fresh `DSH_HOME`; the arms it measures are the ones I measured directly against the
   built lib, which is the artifact that probe would load. The module-level and
   product-path arms are covered; the assembled-profile boot arm is covered by the
   existing `product-boot.json` (which shows `pagination-realm-denied` recorded by the
   product).

## Evidence index

```
qualification/results/C3-dataplane/
  c3-dataplane-probe.mjs      DATA-09 vocabulary/producers + DATA-11 arms (before.json / after.json)
  c3-product-range-probe.mjs  the past-EOF loss through DataPlane.fsCapture (product-range-{before,after}.json)
  c3-gap-hole-probe.mjs       the same at the captureFile primitive (gap-hole-{before,after}.json)
  c3-memo-probe.mjs           the length+mtime replacement attack (memo-{before,after}.json)
```
