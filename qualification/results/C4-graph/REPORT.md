# C4 — ID-01's graph clause: reconciliation, origin, and the AFTER measurement

Writer c4, `D:\DSH\work\wt-c4` (branch `wt/c4`), DSH_HOME `D:\DSH\home\c4`.
Measured 2026-09-20. Instrument: `qualification/results/C4-graph/id01-measure.mjs`.

## VERDICT

**ID-01's graph clause HOLDS on this tree: 0 offenders.** The earlier FAIL this
writer produced was a **harness defect in my own driver**, not a product defect —
it booted the MAIN checkout while reporting itself as a measurement of `wt-c4`.
G-SEAM-74's CLOSED is correct and **is not superseded**.

| run | verdict | graph lines | distinct | fromBuilt | fromSource | offenders | parents under `wt-c4` | parents under main |
|---|---|---|---|---|---|---|---|---|
| **id01 (AFTER, tree-bound)** | **PASS 17/17** | 708 | 218 | 217 | **0** | **0** | 23 | 0 |
| id01-wrong-tree (my first run) | FAIL 10/14 | 694 | 218 | 216 | 1 | 1 | **0** | 1 |
| id01-negative-control | FAIL 16/17 | 713 | 219 | 217 | 1 | 1 | 23 | 0 |

## 1. THE RECONCILIATION — G-SEAM-74 vs the FAIL

**G-SEAM-74 is correct. The FAIL was mine.** These were never in conflict; they are
two measurements of two different trees, and my first run measured the wrong one.

The decisive evidence is the **parent URL** of the offender, which my first run
recorded itself:

```
offenders[0].parents = ["file:///D:/DSH/work/dsh-native-daily/packages/dsh-daily-work/lib/artifacts.js"]
                                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^ the MAIN checkout
```

My driver copied `profiles/daily-candidate` into `D:\DSH\home\c4\profiles\daily`
and ran `dsh plugin install` **without rewriting the absolute `link:` targets**.
`profiles/daily-candidate/package.json` names the main checkout on purpose — that
literal is the search needle `helpers/new-writer.ps1:99` rewrites when it provisions
a writer's home. So the installed profile linked `D:/DSH/work/dsh-native-daily`, and
the boot executed the **main checkout's** `lib/`. That is G-SEAM-29 / G-SEAM-36 /
G-SEAM-61 firing on my own instrument, and it fails **silently**.

`helpers/new-writer.ps1` had already rewritten `D:\DSH\home\c4` correctly at
provisioning time — but my driver then **deleted and re-copied** the profile
directory (`rmSync` + `cpSync`) to guarantee a fresh install, which restored the
main-tree targets. The provisioning was right; my driver destroyed it.

**What each instrument reports**, which was the question I was sent to settle:

| instrument | what it sees | what it cannot see |
|---|---|---|
| `no-src-imports.test.ts` (the F4 gate, 5/5) | parse-based: `ts.preProcessFile` over emitted `lib/**/*.js` and non-test `src/**/*.ts` | a specifier held in a **variable** (G-SEAM-76) |
| `id01-graph-recorder.mjs` (loader hook, `registerHooks`) | **every resolution the host actually performs**, including computed specifiers | nothing relevant here — it is the stronger instrument |
| my driver's classifier | the resolved URL **plus its parent** | nothing, once the tree is bound |

I verified the loader hook's superiority over the gate **directly** rather than
reasoning about it. A file with homelock.ts's exact shape — a specifier in a
`const`, then `await import(specifier)` — was run under the hook:

```
HOOK SAW: @deepseek-ai/node-addon-system/flock
HOOK SAW: koffi
```

So the loader hook **does** see both of G-SEAM-76's computed specifiers. G-SEAM-76
is accurate that the *gate* cannot see them, and it is also accurate that this is a
coverage gap **in the gate**. It is not a gap in the runtime instrument, and this
boot resolved `@deepseek-ai/node-addon-system/flock` to
`native/system/packages/entry/lib/flock.js` — **built**. `homelock.js` itself
resolved no `@deepseek-ai/*` specifier in this boot (`koffi` is bare, not scoped, so
the recorder's `@deepseek-ai/` filter does not log it).

**The two claims are complementary, not conflicting.** G-SEAM-74 speaks about the
RESOLVED graph and is right; G-SEAM-76 speaks about the gate's parse-based
blind spot and is right. Neither supersedes the other.

## 2. THE TRUE ORIGIN

The deep specifier was **never in this tree's `src/` or `lib/`**. On the current
tree it exists in exactly two places, and both are inert:

| location | form | live? |
|---|---|---|
| `packages/dsh-daily-work/src/artifacts.ts:33` | a **documentation comment** | no |
| `packages/dsh-daily-work/lib/artifacts.js:33` | the same comment, emitted | no |
| `packages/dsh-daily-work/lib/data-plane.js:327` | a comment citing `file-store.ts` | no |

The **real import** lived at `packages/dsh-daily-work/src/artifacts.ts:74` and was
removed by **`bcc036e`** ("fix(F4): store artifact bytes through ctx.attachments,
and gate against src/* imports"), which is an **ancestor of HEAD** in this branch:

```
-import { publishImmutableObjectStream } from '@deepseek-ai/dsh-attachment-local/src/store.ts'
+import { AttachmentId, type AttachmentStore, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
```

The fix used the **public capability seam** — the store is now constructed from
`ctx.attachments` (the composition's mounted provider) instead of deep-importing the
provider's source. No new upstream export, no vendoring, no `as any`, and the pinned
checkout is untouched. The remaining "offender" in the main checkout is at
`D:\DSH\work\dsh-native-daily\packages\dsh-daily-work\lib\artifacts.js:73` — a
**stale tree** whose HEAD (`d35d251`) does not contain `bcc036e`.

**So there was nothing to fix on this tree.** The origin of the defect is the main
checkout's stale build, and the origin of my FAIL was my driver's unrewritten links.

## 3. THE FIX (to my instrument, not the product)

Two changes, both in `qualification/results/C4-graph/id01-measure.mjs`:

1. **The `link:` rewrite, with a two-way assertion** (commit `7cbb1d1`). The
   installed profile's `package.json` is rewritten `D:/DSH/work/dsh-native-daily` →
   `D:/DSH/work/wt-c4`, and the driver **throws** unless the installed profile names
   this worktree and does **not** name the main checkout.

2. **Tree binding as a CHECK, not a note** (commit `918e481`). The offender's parent
   URL is now asserted in three ways: no parent under the main checkout, no parent
   under any other worktree of this project, and the project's own built `lib/` was
   loaded from *here*. A graph measurement that does not name the tree it resolved
   is not a measurement of that tree — it can report a defect the tree does not have
   (which is exactly what happened), and it could equally hide one it does have.

The wrong-tree run is preserved under `runs/id01-wrong-tree/` **because it is the
only proof the binding is load-bearing**.

## 4. THE AFTER MEASUREMENT

```
graph: 708 resolution lines, 218 distinct @deepseek-ai specifiers
fromBuilt=217 fromSource=0 fromOther=1
underPackagesLib=209 underVendorLib=7 underNodeModules=1
OFFENDERS (specifiers resolving to a .ts file): 0
checks: 17/17  VERDICT: PASS

TREE BINDING: 23 distinct parent(s) under D:/DSH/work/wt-c4
  parents under the MAIN checkout: 0
  parents under any OTHER worktree: 0
```

**Offending count: 0.** The one `fromOther` row is
`@deepseek-ai/dsh-web-frontend/package.json` → `apps/web/package.json`, named by
`packages/bundle/web-app/lib/index.js`. That is a **manifest read**, not a module
import, and it is reported rather than folded into a pass — the same row S12 and
R2-F4 recorded.

**THE ZERO IS NOT VACUOUS — negative control.** The offender was injected into
`packages/dsh-daily-work/src/artifacts.ts`, rebuilt with the pinned `tsc` (exit 0;
the emitted `lib/artifacts.js` carried it at line 2739), and the **same driver**
reported:

```
OFFENDERS: 1
  @deepseek-ai/dsh-attachment-local/src/store.ts
      named by: file:///D:/DSH/work/wt-c4/packages/dsh-daily-work/lib/artifacts.js
verdict: FAIL 16/17
```

The parent is **this worktree's own** built artifact, so the detector works with the
tree correctly bound. Restored byte-exact afterwards: sha256
`3e781b38b8e31dd4769e32ea1fd9f2858375139984896f038c3abc918f8e789a` and blob
`60266698ad8780412017ae3e483f40ff03631077`, both re-verified against their
pre-injection values; `git status --porcelain packages/` empty.

**The gate, re-run (not quoted):** `no-src-imports.test.ts` **5/5 passed**. No test
was weakened, and no assertion was deleted or loosened — I changed nothing in
`qualification/specs/` or in any test.

## 5. `daily-work-command` — same cause, not independent

The wrong-tree run recorded `daily-work-command (dsh-daily-work/command): never
started`, and its probe wrote **no** `firstToolCall` at all. **It was caused by the
same wrong-tree resolution and is not independent.** In the corrected run the error
list is **empty**, the preset mounts, `toolCountAgentKey: 24`, and the first call
succeeds (`read`, `toolResultIsError: false`, result carries the file's own text).
The main checkout's stale `lib/` is not what the installed preset's rows expect, so
one row failed to activate — a composition failure produced by the wrong-tree boot,
not a product defect.

## 6. WHAT I AM NOT CLAIMING

- **Not claiming the main checkout is broken product.** It is a **stale tree** whose
  HEAD predates `bcc036e`. Its built `lib/artifacts.js` carries the F4 defect
  because it was built before the fix, and its HEAD does not contain the fix.
- **Not claiming the gate covers every way to name a `src/` path.** G-SEAM-76 is
  correct that it cannot see a computed specifier. The loader hook can, and did —
  but the hook is a qualification instrument, not a build-time gate.
- **Not claiming a live model route works.** Every run is a CONTROLLED LOCAL ROUTE
  through a keyless mock adapter (`live_provider_budget_authorized: false`). It
  proves the module graph and the tool chain, not a provider integration.
- **Not claiming `218` is a permanent count.** It is a measurement of this tree at
  this commit; R5/R4/S1/P13 have moved the plugin graph before, which is why it was
  re-measured rather than inherited. The V1 run had 223 distinct specifiers; the
  delta is the removed private subpath plus four plugin-graph changes since.
- **Not claiming the two `vendor\*\lib\`-vs-`packages\*\lib\` rows are resolved.**
  Seven rows resolve under `vendor\*\lib\` and one under `node_modules/`; all are
  built `lib/*.js`. The oracle's literal wording says `packages\*\lib\`. S12 flagged
  this and I reproduce the flag rather than deciding it — no `.ts` is involved.
- **Not claiming I verified reachability of the sandbox-windows-acl `src/runner.ts`
  fallback.** I found it while scanning the pinned checkout and confirmed it is
  **unreachable** in this boot: the built `lib/runner.js` exists, so the
  `import.meta.resolve` fallback never runs, and only the built specifier appears in
  the graph. It is a latent path in the pinned checkout, outside this repository.

## 7. ARTIFACTS

| path | what it is |
|---|---|
| `qualification/results/C4-graph/id01-measure.mjs` | the driver (tree-bound, three assertions) |
| `qualification/results/C4-graph/id01-overlay-c4.yml` | the composition: keyless mock route, no tool row inserted |
| `runs/id01/` | **the AFTER measurement** — PASS 17/17, 0 offenders |
| `runs/id01-wrong-tree/` | my first run — FAIL, offender parent = main checkout |
| `runs/id01-negative-control/` | injected offender, rebuilt — FAIL 16/17, parent = `wt-c4` |
| `gate-5of5.txt` | `no-src-imports.test.ts` 5/5, re-run not quoted |

## 8. HONEST VERDICT

**ID-01's graph clause HOLDS on `wt-c4`: 0 offenders, 17/17 checks, every parent URL
under this worktree.** G-SEAM-74's CLOSED stands and is not superseded; G-SEAM-76's
gate blind spot is real and complementary, and the runtime loader hook does not share
it.

The defect I reported was **mine, in my instrument**: I deleted and re-copied a
correctly-provisioned profile and thereby restored the main-tree `link:` targets,
then reported the main checkout's stale build as this tree's. I found it by reading
the parent URL my own driver had recorded, fixed it, preserved the wrong-tree run as
evidence, and added the assertion that makes the class of error impossible to report
silently again. **There was nothing to fix in the product.**
