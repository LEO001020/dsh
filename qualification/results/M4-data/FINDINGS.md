# M4 — unified observations and streaming artifacts (DAT-01 … DAT-08)

**Date:** 2026-09-20
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0, CPython 3.14.3
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
**Evidence:** `tests.txt` (36 passed, exit 0), `tsc.txt` (exit 0), `source-digests.txt`,
`profile-boot.json` / `profile-boot.txt` (real composed-profile boot),
`CANONICAL-TRUNCATION-VERIFIED.md` (committed as `041bd33`).

## Verdict summary

| gate | verdict | what is genuinely proven |
|---|---|---|
| **DAT-01** long-line complete read | **PASS** | The real `buildWindow` clips a 100 KiB single line to 2034 chars and DESTROYS its interior; `offset=2` throws because `totalLines` is 1. The same line is then recovered byte-for-byte (sha256-equal, tail marker present) from a captured artifact by byte range. |
| **DAT-02** large result off-context | **PASS — one substitution named** | 512 pages / 33,554,432 bytes consumed in ONE walk, digest equal to the source, model projection **399 bytes** (≤8 KiB). Repeated with a **real CPython process** over a pipe: 512 pages, 33,554,432 bytes, digest equal, projection 429 bytes. The `python_exec` cell itself is M3's and is not on this branch — stated, not hidden. |
| **DAT-03** encoding page boundaries | **PASS** | UTF-8 (3- and 4-byte), CRLF and JSONL swept at page sizes 1…96 and 1,2,3,5,7,16,64,100,997,4096: byte-for-byte equality, no replacement char, every record exactly once, line index identical to the read tool's numbering. |
| **DAT-04** pagination advances | **PASS** | A repeated cursor, a backwards cursor, and a not-exhausted page with no continuation each raise `pagination-stalled`. A well-formed provider still completes 5/5 pages, so the guard is not tripped by legitimate progress. |
| **DAT-05** fixed snapshot | **PASS** | The source file is rewritten after page 1 (same length, different bytes); page 2 still comes from the captured hash and the joined bytes are the ORIGINAL's. A cursor bound to another artifact, and a cursor after a scope bump, are both refused. |
| **DAT-06** IO complexity | **PASS — audit inference CONFIRMED by measurement** | 8 pages of a 4 MiB artifact cost exactly 524,288 artifact bytes in 8 reads; the source is read once at capture and never during paging; the index is one linear scan (4,194,304 bytes). Repeated `read` was **measured**: 5 calls of 100 lines each scanned **944,445 bytes against an 188,889-byte file** — 5.0× the file. |
| **DAT-07** grep layering | **PASS** | Real ripgrep 15.0.0, 900 matches, 239,526 raw bytes against a 20,000,000 cap: canonical keeps all 900, the renderer shows 250 and reports the omission, and **real CPython reads all 900 distinct matches** from the captured canonical. A raw-cap hit is recorded as `partial` with a `native-acquisition` gap. |
| **DAT-08** quota failure | **PASS** | An over-quota capture returns `completeness: "partial"` with a `retention` gap and recovery `none`, publishes nothing, and its projection is 613 bytes with no content — no inline fallback. Orphan / integrity-error / checkpoint-failure windows each reach their required verdict. |

**Non-PASS: none.** Two substitutions and one unproven edge are stated below rather than
folded into a PASS.

## The truncation investigation, verified rather than assumed

The audit's §6 claim was re-derived from source AND measured:

- `truncateLine` (`read-render.ts:69-71`) does `line.substring(0, maxLineLength)` — it keeps
  the **HEAD** and appends a suffix, so the result is not even a prefix of the original.
- `buildWindow` caps its line buffer at `maxLineLength + 1` (`read-render.ts:118`) and returns
  `consumeLine`'s output, so the clip happens **before** any consumer sees `lines[].text`.
- `read.ts:148-158` assigns `window.lines` straight into the returned canonical value, so the
  loss is in the canonical output, not only in the render.
- Measured: a 102,400-byte single line comes back as 2034 chars with the tail marker gone, and
  `offset = 2` throws `offset 2 is out of range … (1 lines)`. **A larger offset moves to a
  different LINE; it can never reach the clipped interior of line 1.**

Consequence for the design: every repair in this milestone reads **bytes of a captured
object**, never `lines[].text`. `readLineBytes` has no line cap, so the 100 KiB line comes back
whole.

## What was reused, and what `spillStore.saveText` is not

Reused verbatim: `publishImmutableObjectStream` (`@deepseek-ai/dsh-attachment-local/src/store.ts`)
— staged write, hash-while-streaming, fsync, hard-link into a digest-derived path,
digest-verified EEXIST dedup, `0o400`, directory sync. That is exactly the "streaming put,
host-computed hash, atomic publish" the milestone needs, so no second publication path exists.

`spillStore.saveText` is **not** the artifact store and this milestone does not use it as one.
It persists text and returns an opaque `SpillLocator` with **no `open`, no `stat`, no range
read, no delete, no ACL, no refcount** (`packages/spill/spill/src/index.ts`). Saving
already-truncated text does not produce the original: `saveText` faithfully stores what it is
given, and what `buildWindow` gives it is a clipped line. No test here claims otherwise.

`writeFileAtomic` was also rejected: string content only, no streaming, no digest.

The narrow contract that was genuinely missing — `put` / `stat` / `openRange` / `remove` /
`pin` / `unpin`, plus quota, tombstones and grace GC — is what `LocalArtifactStore` adds.

## Production reachability (supervision finding, fixed)

The first version of this milestone was **test-only**: `artifacts.ts` had zero production
importers. A test that mounts a module directly proves the module works and says nothing about
whether the product loads it — the defect class this project has already recorded three times
(`setLaunchPort`, `takeContinuation`, a `dsh-ipython` bundle with no `dsh.bundle`).

Fixed by option (a): a host service on `ctx.dailyData`, registered by a `cordis.patch.yml` row
(`dsh-daily-work/data-host`). The importer chain is now unbroken:

```
cordis.patch.yml  ->  data-plugin.ts  ->  data-service.ts  ->  artifacts.ts  ->  observations.ts
```

**Proven through the REAL profile resolver**, not a direct mount
(`qualification/runners/verify-data-plane.mjs`):

```json
{"servicePresent":true,"grantRevision":1,"captureState":"durable","capturedBytes":162,
 "readBackMatches":true,"sessionCreated":true,"toolCountAgentKey":26,"error":null}
```

A real Session was created and its 26-tool surface reported. `dataToolPresent` is **false** and
that is the honest result: the `data.capture_file` / `data.pages` TOOL rows belong to the M3
`python_exec` worker, which is not on this branch. What this milestone proves is the **seam**
that worker binds to is live in the product.

Two measurement errors in the probe itself are recorded rather than smoothed over:

1. Gating `inject` on `storageDomain` made the probe activate on the same edge as the
   data-plane row and win the race, so it read `ctx.dailyData` before it was provided and
   reported a **false absence**. Gating on `dailyData` is the correct use of `inject`: the
   plugin then activates only once the service is live, and a missing row shows up as
   "waiting for services (missing: dailyData)". (`docs/GAPS.md` G-FIX-09 records this class.)
2. Overriding only `webserver.port` dropped `host` and failed schema validation — a patch
   replaces the whole `config` object, not a deep merge (TRAP 4 in `docs/OPERATIONS.md`).

## Mock vs real track separation

| track | where | what it is |
|---|---|---|
| **real** | DAT-01, 03, 05, 06, 07, 08, crash | Production `LocalFileSystem`, production `publishImmutableObjectStream`, the REAL `buildWindow` for every truncation claim, the REAL ripgrep 15.0.0 binary, a REAL CPython 3.14.3 process, a REAL `SIGKILL` |
| **mock** | DAT-04 only | A synthetic `PageProvider`. A correct provider cannot be made to return a backwards cursor, so a mock is the only way to test the guard at all. |
| **not real** | DAT-02's `python_exec` | Substituted by (a) an in-process JS consumer and (b) a real CPython process over a pipe. ipykernel/jupyter_client integration is M3's and is **not** claimed here. |

## Crash consistency (ARCHITECTURE §9)

The order implemented and tested: **capture+stream → atomically publish → commit the
reference → checkpoint → only then `durable: true`.**

| window | verdict reached | how it is tested |
|---|---|---|
| object published, event not committed | `orphaned` — never delivered | **REAL `SIGKILL`** in a forked child between `put` and `commit`; the surviving object verifies, `resolveReference` raises `artifact-orphaned`, grace GC spares it then collects it |
| event committed, object missing | `artifact-integrity-error` — never `''` | object removed while the reference stays committed |
| effect happened, save failed | `unknown` — never re-executed | `mayReExecuteAfterSaveFailure` is unconditionally `false`; `docs/GAPS.md` G-FIX-04 discipline applied |
| checkpoint fails after commit | `durable` state with a recorded gap | checkpoint hook throws; the gap names the failure |

The reference log is a **storage domain** (`dsh_daily_data`), not a Session event, and that
substitution is stated: `Session.append` accepts only DSH's closed `SessionEventMap`, and
`KNOWN_SESSION_EVENT_TYPES` is what the persistence read path checks. An out-of-repo plugin
could only write an `ignorable: true` event — and a reference a reader may skip cannot carry
the "event committed" half of the order.

## DAT-06: the audit's inference is CONFIRMED

The audit inferred from source (`read-render.ts:132-141`) that every `buildWindow` scans the
whole input to count `totalLines`, so repeated `read` with a growing offset may rescan the
whole file. **Measured, confirmed:**

| path | bytes read for 5 windows / 8 pages |
|---|---|
| repeated `read`, 100 lines per call, 188,889-byte file | **944,445** (5 × the whole file, once per call) |
| artifact paging, 8 × 64 KiB pages of a 4 MiB artifact | **524,288** in 8 reads (exactly the pages) |

So a P-page walk via `read` costs P full scans; via the artifact it costs the pages. The
measurement wraps `buildWindow`'s input iterable, which is the only place it touches input, so
the count is exactly what it scanned.

## Deliberate non-claims

- No `python_exec` / ipykernel / jupyter_client integration is claimed (M3's).
- No claim that the model can reach `data.capture_file` as a TOOL (M3's rows).
- No exactly-once external-effect claim; the crash tests are about what the record may SAY.
- `artifactRoot` is not set in the patch: the service derives it from the storage domain's own
  root, so artifacts live beside the records that reference them.
- DAT-07 drives the real ripgrep and the real retention functions through the library, not
  through a mounted agent turn, so the claim is about the retention layering.
