# T2 — filesystem provider swap: findings

**Subject:** DIFFERENCE 3 of `profiles/daily-candidate/cordis.patch.yml` — mount
`fs-local` in place of `fs-sandbox`.
**Method:** a real composed-profile boot with a probe inside the host
(`qualification/runners/verify-t2-fs.mjs`), plus a CONTROL boot of the same probe
against the pre-swap composition (`verify-t2-fs-control.mjs`).

The three supporting probes live in `qualification/runners/t2-probes/` and are
re-runnable; each carries its own "why this exists" note, and its measured output
is quoted below. Every claim in this file came from running one of them.

**Commit provenance, recorded because it is misleading otherwise.** These changes
were committed in `cfdff75` ("G-SEAM-36: the kernel restart defect…"), which is
another agent's commit about unrelated work: a concurrent agent ran `git add -A`
in the shared worktree and swept this file, `VERDICT.json`, the two test-file
edits and `qualification/runners/t2-probes/` into it. The commit message does not
describe any of it. That is an instance of the defect class already recorded as
G-SEAM-35 (parallel agents in one worktree damaging each other's git state), and
it is noted here so a reader who greps the log for T2's evidence is not misled by
the message it is filed under. The content itself is the measured content; only
the attribution is wrong.

## Result

`VERDICT.json`: **23/23 checks pass**, on the current composition
(`installed == repo == 5b8b2a8e…`, `composition.isCurrent: true`).

## What the swap changed behaviourally — measured, both directions

The control run is the same probe binary against the composition with the swap
reverted. The only variable is the two provider rows.

| observation | swapped (`fs-local`) | control (`fs-sandbox`) |
|---|---|---|
| `providerClassName` | `LocalFileSystem` | `SandboxedFileSystem` |
| `SandboxedFileSystem` in prototype chain | `false` | `true` |
| write OUTSIDE the workspace | **succeeds** | **denied** |
| `escalationFieldsAdvertised` on `write`/`edit` | `[]` / `[]` | `["sandbox_permissions","justification"]` / same |
| `toolCount` | 27 | 27 |
| inactive entries | none | none |

So the swap is REAL and its behavioural delta is exactly two things: mutations
outside the workspace stop being fenced, and the two escalation parameters
disappear from the `write`/`edit` schemas. The second follows from the first —
`tool-fs` advertises them only when `ctx.fs.sandboxMode` is defined
(`packages/fs/tool-fs/src/sandbox.ts:44-45`), and the local backend has no
`sandboxMode`.

`sandboxPolicyDefaultMode` is `workspace-write` in the swapped run, so the fence
WAS live and this is a real behavioural change rather than a no-op under an
already-permissive mode. That is the fact that makes the table above meaningful.

**The swap is narrower than it looks.** `SandboxedFileSystem extends
LocalFileSystem` and both overridden operations delegate upward
(`packages/fs/fs-sandbox/src/index.ts:55,87,108`), so the only thing the sandbox
layer adds is `checkedTarget(...)` — the containment check — around inherited
behaviour. Read, write, edit, diff, versioning and line-ending semantics are
`fs-local`'s in BOTH compositions and cannot have changed.

## The two probe checks that were failing

Both were **probe defects, not product defects**. Neither is a product finding,
and saying so is the honest result.

1. **`fs/edit-intent is still answered by a listener`** — the listener was there
   and answering correctly all along. `attempt()` serialized only
   `error.name`/`error.message`, and the driver then searched the MESSAGE for the
   string `FS_NOT_OBSERVED`. `FsError` carries the class on `.code`
   (`packages/fs/fs/src/types.ts:196-202`), and this project's own rule is to
   route on the code rather than parse the message. Fixed by capturing `.code`
   and asserting it: measured value is `code: "FS_NOT_OBSERVED"`, and the
   `fs-observation-policy` row registers BOTH waterfalls
   (`packages/fs/fs-observation-policy/src/index.ts:118,122`). So the answer to
   the original question is **(a) neither — the local backend emits and the policy
   row is wired for both**; the check was reading the wrong field.

2. **`no entry failed to activate`** — reported `hmr` stuck in `FiberState.LOADING`.
   The probe built its entry table ONCE and then looped `while (!settled())` over
   that **frozen array**, so the loop could never observe a change: it spun for its
   full deadline and reported the initial state as the settled one. Fixed by
   re-reading the live table each sample. `hmr` reaches ACTIVE within **252 ms**,
   and `inactiveEntryIds` is `[]` in BOTH the swapped and the control run. The
   first version of this check also counted the probe's OWN row — `apply()` is the
   loading callback, so its fiber is necessarily LOADING while it reports — which
   is a self-referential artifact and is now excluded by id and recorded as such.

## The CRLF family — the answer

**Question:** does the local backend normalize a CRLF file to LF on write?

**Answer: NO for `edit`, and it is not supposed to be. `write` writes the bytes it
is given.** The two paths have DIFFERENT contracts, and conflating them is what
the failing assertions did.

Measured directly against the built backend (`../../runners/t2-probes/crlf-probe.mjs`):

| operation | content given | bytes on disk |
|---|---|---|
| `editText` on a CRLF file | LF-normalized internally | **CRLF preserved** |
| `writeText` LF content onto a CRLF file | `x\ny\nz\n` | `x\ny\nz\n` |
| `writeText` CRLF content onto a CRLF file | `x\r\ny\r\nz\r\n` | `x\r\ny\r\nz\r\n` |
| `writeText` CRLF content onto a NEW file | `p\r\nq\r\n` | `p\r\nq\r\n` |

- `editText` preserves the target's style because it makes a PARTIAL change: it
  captures `original.lineEndings` and calls
  `restoreLineEndings(edited.content, original.lineEndings)` before the atomic
  write (`packages/fs/fs-local/src/index.ts:253-255`).
- `writeText` does NOT restore, and must not: it is a FULL replacement in which
  the caller stated the complete content, so restoring a style the caller did not
  ask for would make it impossible to write an LF file over a CRLF one at all.
  `normalizeLineEndings` is applied only to the returned `after` DIFF BASIS
  (`:224-227`), which is why `after` is LF while the bytes are CRLF.

**Is this a real difference from the sandbox backend? No.** Measured with the
same probe against BOTH classes (`../../runners/t2-probes/sandbox-crlf-probe.mjs`):
`writeTextOnDiskIdentical: true`, `editOnDiskIdentical: true`. The sandbox
backend has no line-ending code of its own — it inherits `fs-local`'s. So the
FS-05 failure was **pre-existing and not caused by the swap**, and it was a wrong
EXPECTATION rather than a backend bug.

**Which behaviour is correct for this deliverable:** style-preserving `edit` +
content-faithful `write`. Both are correct and both are now pinned.

### Tests changed, and why

- `durability-advanced.test.ts > T9-C > FS-05` — the final assertion claimed
  `writeText` "normalizes content to the file's own style". That is FALSE and is
  the `edit` contract, not the `write` one. The assertion is replaced by the
  measured contract in BOTH directions (LF in → LF out, CRLF in → CRLF out), plus
  the two-paths-on-one-file control. The gate's real property — a CRLF file stays
  CRLF through an EDIT — is unchanged and still asserted. **Not weakened: the
  coverage of `write` went from one assertion to four.**
- `durability-advanced.test.ts > T9-C > FS-06` — the raw-Python fixture omitted
  `newline=''`, so CPython's text mode translated `\n` to `\r\n` on this host.
  MEASURED: `write_text('x\n')` yields `b'x\r\n'` by default and `b'x\n'` with
  `newline=''`. The case was therefore measuring the HOST's line separator, not
  whether the mutation is visible. `newline=''` was added to the fixture. The
  visibility assertions are untouched: the mutation still bypasses DSH entirely,
  still produces no fs receipt, and is still asserted visible from the world.

## A third failure, same shape as the two above

`verification-gates.test.ts > FS-06 > the raw-Python write is caught by the
candidate/HEAD comparison` failed with `expected 'refuse' to be
'accept_for_publication'`. It was NOT the raw-Python edit and NOT the swap.

MEASURED by reproducing the scenario and printing the assessment's own `reasons`
(`../../runners/t2-probes/fs06b-probe.mts`):

```
"there is no acceptance receipt, so there is no evidence that any test ran"
"no acceptance receipt was supplied, so nothing about the candidate has been verified"
```

The fixture called `assessIntegration` with **no receipt at all**, so the refusal
came from the missing receipt. A case that fails for an unrelated reason cannot
measure the property it names — and one that PASSED on a missing receipt would
have been worse. The fixture now produces a REAL receipt from a REAL vitest run,
and the case measures BOTH halves: the residual gap (with no `definition`, the
tree digest is the recorded one, so the uncommitted raw edit is not caught:
`accept_for_publication`) and its closure (with the `definition`, `observedBasis`
recomputes the digest FROM DISK, the binding fails on `candidateTreeDigest`, and
the candidate is `refuse`d). The gap is now closable and the closing is measured.

The neighbouring `VER-09b` case ("the publication path takes the ref as an
INPUT", `verification-gates.test.ts:2597`) fails with the same
`expected 'refuse' to be 'accept_for_publication'` (MEASURED, run before any of
my edits to that file). Reading its source, it also passes no `receipt` and no
`recordedBinding`, so the missing-receipt branch is the likely cause — but that
is a READING, not a measurement: I did not dump its `reasons` array. It is
outside my block and is **reported, not fixed** — see "Open" below.

## Build staleness — stated, not assumed

The provider readings come from the BUILT `fs-local`/`fs-sandbox` `lib/`, not
from `src/`. Their mtimes (`2026-09-19 11:13`) PREDATE both runs, so no rebuild
can have invalidated them, and the source and build agree on the line-ending code
(`restoreLineEndings` is present in `lib/index.js`).

The COMPOSITION was stale and was corrected: my home held patch `3755f904…` while
the repo had `5b8b2a8e…`, and the difference was real rows, not comments — the
installed copy was missing DIFFERENCES 4, 5 and 6 (`pwsh-local`, the permission
plane off, `approval: never`). The home was reinstalled from the current patch
before the final measurement, and the verdict now carries both digests plus
`composition.isCurrent`, so a reader can tell which composition any number
describes without re-deriving it. The earlier run is preserved as
`VERDICT-2026-09-20T05-20-stale-install.json`.

## Open / not closed

- **`verification-gates.test.ts > VER-09b > the publication path takes the ref as
  an INPUT`** fails with `expected 'refuse' to be 'accept_for_publication'`
  (measured; its source also supplies no receipt — read, not measured). It is
  outside my file ownership, so it is reported rather than edited. If the cause is
  the missing receipt, the fix has the same shape as FS-06b's: supply a real
  receipt and a recorded binding.
- **`hmr` takes ~250 ms to activate after `sessionController` publishes.** This is
  a timing observation, not a defect: it reaches ACTIVE with no error, and the
  check that flagged it was my own race. Recorded because a future probe that
  samples too early will see `LOADING` again.
- The probe measures the SWAP, not the deployment. It does not establish that the
  removed fence is an acceptable loss — that is a security judgement recorded in
  `qualification/results/T3-shell/FINDINGS.md` and `docs/SECURITY.md`, not here.
