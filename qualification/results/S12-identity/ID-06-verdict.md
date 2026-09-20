# ID-06 verdict — the pinned checkout is unmodified

Writer S12, wave 2. Measured 2026-09-20. Checkout `D:\DSH\src\dsh-src`.

## The oracle, verbatim from `acceptance-spec.trusted-local-v2.definition.json`

> **stimulus**: Run `git status --porcelain` and `git rev-parse HEAD` inside
> `D:\DSH\src\dsh-src`.
>
> **oracle**: The working tree is clean and HEAD equals
> `ddefc45fbc7f8e46dd73185e68295696d1297887`. Any tracked modification, any
> staged change, or a moved HEAD is NOT PASS.

## VERDICT: FAIL

On the literal oracle this is a FAIL, and I agree with that reading. The oracle
is a conjunction of two clauses and it names its own failure cases exhaustively:

| clause | measured | result |
|---|---|---|
| HEAD equals `ddefc45fbc7f8e46dd73185e68295696d1297887` | exactly that value | **satisfied** |
| "the working tree is clean" | `git status --porcelain` prints one line | **not satisfied** |

`git status --porcelain` prints:

```
 M packages/deliverables/workspace-changes/src/index.ts
```

The ` M` code is git's own report of a **tracked modification** in the working
tree. The oracle says "any tracked modification ... is NOT PASS". The reported
entry is a tracked modification *by git's own accounting*, so the clause fails.
I do not think there is a defensible reading that returns PASS: the oracle does
not admit a line-ending carve-out, and reading one in would be exactly the
"obtain a PASS by reinterpreting the oracle" move the brief forbids.

**I considered and rejected the PASS reading.** An argument for PASS exists — "no
byte of content differs, so the tree is not *really* modified" — and it is
supported by real measurements (below). But it requires the oracle to mean
"content-identical" where it says "clean", and "clean" is a term git already
defines and has already answered. A verdict of PASS here would be an over-read.
The honest form is FAIL **plus** the characterisation, which is what this file
records. A bare FAIL would understate the finding; a PASS would overstate it.

## What the FAIL is, exactly — and what it is not

The single entry is an **EOL/stat artifact, not a content edit.** Four
independent measurements, all on the same file:

1. **Blob ids are identical.**
   - `git rev-parse HEAD:packages/.../index.ts` → `c05787d931870defacfdfcb4feca85f4ae733d8e`
   - `git hash-object packages/.../index.ts` → `c05787d931870defacfdfcb4feca85f4ae733d8e`
   Git's clean filter maps the worktree CRLF back to LF, and the result is
   byte-identical to the committed blob. In git's own accounting there is no
   content delta.
2. **`git diff --exit-code` → exit 0** and **`git diff --quiet HEAD` → exit 0**.
   `git diff --numstat` prints nothing but a CRLF warning.
3. **The size delta is exactly the CR count.** Index entry records
   `size: 7086` (LF form). Worktree file is `7251` bytes with `165` CR and `165`
   LF. `7251 − 7086 = 165`. Every extra byte is a carriage return.
4. **`git status --porcelain=v2` shows both hash columns equal:**
   ```
   1 .M N... 100644 100644 100644 c05787d931870defacfdfcb4feca85f4ae733d8e c05787d931870defacfdfcb4feca85f4ae733d8e packages/deliverables/workspace-changes/src/index.ts
   ```
   The `.M` (worktree-modified) flag with head-hash == index-hash is the
   signature of a stat/line-ending mismatch, not an edit.

The mechanism: the checkout's own `.gitattributes` declares `* text=auto eol=lf`,
while the ambient `core.autocrlf` is `true`. The file on disk carries CRLF, so
git's stat cache cannot match and it re-checks the content every time — the
content matches, so `git diff` is empty, but the stat mismatch keeps the entry
flagged. **Reproduced from scratch** in a throwaway repo (`/tmp/s12-crlf`): an LF
file under `* text=auto eol=lf` with `core.autocrlf=true`, rewritten to CRLF,
produces exactly ` M f.txt`, `git diff --exit-code` exit 0, identical blob ids,
and `update-index --refresh` → `needs update`, exit 1. The mechanism is general,
not a property of this checkout.

## Pre-existing: it predates this wave, and no writer introduced it

| evidence | value |
|---|---|
| mtime of the flagged file | `2026-09-19 19:19:47 +0800` |
| mtime of every sibling in its directory | `2026-09-19 10:41:57` (checkout time) |
| wave-2 provisioning of the 15 writers | `2026-09-20 18:26`–`18:33` |
| round-1 writer provisioning | `2026-09-20 09:12`–`09:44` |
| worktree files modified on/after `2026-09-20 00:00` | **0** |

`find` over the whole checkout (excluding `.git` and `node_modules`) for files
newer than `2026-09-19 12:00` returns **exactly one** file: the flagged one, at
19:19:47. Nothing else has been written since the checkout was created. So
**no writer in either wave wrote into the working tree**, and the flagged entry
was already there 8.6 hours before round 1 began. It is a pre-existing property
of this environment, most likely introduced when the install was moved/restored.

## Strictly cleaner than its own recorded baseline

The earlier record (`qualification/results/V1-identity/ID-06-pinned-checkout-state.txt`,
`ROOT-verification/pinned-checkout-state.md`) captured **three** entries:

```
 M packages/deliverables/workspace-changes/src/index.ts
?? DSHhomem914/
?? data-artifacts/
```

Both untracked directories are **gone now**:

- `ls -d DSHhomem914` and `ls -d data-artifacts` → "No such file or directory"
- `git ls-files -o --exclude-standard` → empty (count 0)
- `git status --porcelain --untracked-files=all` → only the one ` M` line

They were **moved, not deleted**, by writer R2-F11 (recorded in
`qualification/results/R2-F10F11/FINDINGS.md`): copied to
`D:\DSH\relocated\2026-09-20-checkout-state\`, per-file sha256 verified against
`moved-state-manifest.json`, and only then removed from the checkout. That was a
deliberate, recorded, hash-verified action that reduced the deviation. So the
current state is **strictly cleaner than the baseline this wave inherited**, and
the remaining deviation is the single pre-existing CRLF entry.

## Can the flag be cleared without writing? — measured, and NO

Every option was tested. No read-only option clears it.

| option | writes? | clears the flag? | measured |
|---|---|---|---|
| `git status --porcelain` | no | — | still ` M` |
| `git status --porcelain=v2` | no | — | still `1 .M` |
| `git -c core.autocrlf=false status --porcelain` | no | **no** | still ` M` |
| `git -c core.autocrlf=input status --porcelain` | no | **no** | still ` M` |
| `git update-index --refresh` | **yes** (`.git/index`) | **no** | `needs update`, exit 1 |
| `git add --renormalize <path>` | **yes** (worktree file **and** index) | yes | not run — mutates the checkout |

Method for the two risky rows: a **copy** of `.git/index` at `/tmp/s12-idx/idx-copy`
addressed via `GIT_INDEX_FILE`, so any write landed on the copy. The real index
sha256 was recorded before and after and is **identical**
(`cfb2958b0bec566de42648d54b440da7aa7b49b247972184daa79a2abff18dda`), with mtime
unchanged at `2026-09-19 10:42:49`. No `.git/index.lock` was created.

Note that `update-index --refresh` does not merely "fail to help" — it **refuses**:
`packages/.../index.ts: needs update`, exit 1. The stat cache cannot be made to
match because the on-disk size genuinely differs from the cached size. So even the
write-requiring refresh does not silently clear this.

`git add --renormalize` would clear it by rewriting the worktree file to LF, i.e.
**changing the bytes on disk**. That is a mutation of a read-only tree, and it
would make the gate green by changing the thing measured — forbidden. **Not run.**

## Recommendation — for the root agent to decide, not this writer

The tree is read-only to me and I made no attempt to clean it. Options, in the
order I would rank them:

1. **File ID-06 as FAIL with this characterisation and do not touch the
   checkout.** This is what the measurements support. The FAIL is real, honest,
   and describes a pre-existing environment property that no writer caused.
2. If the spec's owner decides the oracle should admit an EOL carve-out, that is
   a **v2 definition change** and must be made explicitly, with this file cited as
   the reason. It is not something the agent that ran the stimulus may decide.
3. `git add --renormalize` on the one path would make the literal oracle PASS, but
   it writes to a tree the brief declares read-only, and it changes the measured
   artifact to satisfy the measurement. I recommend against it.

## UNRESOLVED UNKNOWNs

1. **What wrote `pack-c0fc169b…pack` at 2026-09-20 18:37:22.** The pack body
   changed while its `.idx` stayed at `2026-09-19 10:41:54` — not the shape of a
   lazy fetch (which creates a *new* pack, as the 18:41:31 case shows). It falls
   inside my session window and 15 writers were live. Not attributable to me and
   not explained. Recorded rather than theorised.
2. **Whether a fresh `core.autocrlf=false` checkout of the pin would be clean.**
   Not tested: creating a second checkout is outside this slice and would itself
   change the qualification environment.
3. **What introduced the CRLF at 19:19:47 on 2026-09-19.** The mechanism is known
   (EOL conversion of an LF blob); the agent or tool that caused it is not.
4. **Whether `.git` writes count against ID-06's oracle.** The oracle names the
   working tree and HEAD; it does not mention `.git`. A lazy-fetch pack write
   leaves both oracle fields identical, so on the oracle's own text it does not
   register — but I am not claiming a `.git` write is therefore harmless, because
   the oracle does not address the question.

## CLAIMS I AM NOT MAKING

- **Not claiming ID-06 PASSES.** It is a FAIL on the literal oracle.
- **Not claiming the pinned checkout is "unmodified"** in the unqualified sense.
  HEAD matches and no tracked *content* differs; `git status` is not empty. Only
  the first is true.
- **Not claiming the CRLF entry is harmless.** I claim its blob id equals HEAD's,
  which is measured. Whether a CRLF working tree is acceptable for a qualification
  run is an environment judgement I have not made.
- **Not claiming no one touched the checkout.** I claim no *working-tree* file was
  written on/after 2026-09-20 00:00 (measured: 0 files), and that a `.git`-internal
  pack write did occur at 18:37:22 for an unknown cause.
- **Not claiming the two untracked dirs were deleted.** They were moved with a
  hash-verified manifest; I re-read that record, I did not re-verify the copies.
- **Not claiming git cleanliness is part of the deployment identity.** It is an
  environment precondition; `compatibility.lock.json` was not edited.
- **Not claiming `git status` is reproducible across git versions.** Measured with
  `git 2.55.0.windows.3` only.
