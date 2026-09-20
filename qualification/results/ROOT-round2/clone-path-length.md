# The published tree is conditionally unclonable on Windows: it depends on the clone's PREFIX length

Found by push agent P4 as a usability defect of the published artifact; measured and
narrowed here, because P4's statement of it was correct but not complete.

## What P4 observed

```
$ git clone https://github.com/LEO001020/dsh /tmp/lp-test
warning: unable to access '.../.gitattributes': Filename too long
error: unable to create file .../session.v3.jsonl: Filename too long
$ cd lp-test && git ls-files | wc -l
0
```

A plain clone FAILS, exits 128, and leaves the index unwritten — so `git ls-files`
returns 0 and the checkout looks empty.

## The measurement, which narrows it

The longest **relative** path in the tree is 222 characters:

```
qualification/results/T17-identity/runs/built-launcher/sessions/--D-DSH-work-dsh-native-daily-qualification-results-T17-identity-runs-built-launcher-workspace--/session-e9ce79ec-.../session.v3.jsonl
```

**Zero** tracked paths exceed 259 characters, so the repo is inside Windows'
`MAX_PATH` on its own. The failure is therefore NOT a property of the repository
alone — it is `PREFIX + 222` crossing 260:

| clone destination | absolute longest | result |
|---|---|---|
| `C:\Users\hzq00\AppData\Local\Temp\lp-test\` (~44 chars) | ~266 | **FAILS**, `git ls-files` = 0 |
| `D:\v\` (5 chars) | 227 | **succeeds**, `git ls-files` = 1619 |

So the same commit clones cleanly or fails depending only on where the cloner puts
it. That is the fact a cloner needs, and it is why "the tree is unclonable" would be
an over-statement while "a plain clone can fail" is exactly right.

## Why it matters more than a path nit

The paths that break are the **session-log evidence** directories that P2 classified
as keepers. They are deep because they encode the full workspace path in the
directory name:

```
sessions/--D-DSH-work-dsh-native-daily-qualification-results-T17-identity-runs-built-launcher-workspace--/
```

That encoding is deliberate (it is how the Session store scopes a workspace), so the
depth is not sloppiness — it is a consequence of publishing the evidence at all.

## The honest disposition

1. **Not a defect in the product.** Nothing in `packages/` or `profiles/` is affected;
   the published SOURCE is complete and correct at any prefix length.
2. **A real usability defect of the PUBLISHED ARTIFACT**, and it must be documented
   for a cloner: either clone to a short path, or set `core.longpaths=true`.
3. **13 tracked paths exceed 200 characters.** That is the set to watch — a future
   evidence directory one level deeper would push the count up, and the failure mode
   is silent (an empty-looking checkout rather than an error a reader notices).

## Not fixed here

Rewriting the evidence directory names would change recorded paths and break the
digests that reference them. The right fix is documentation plus a check, not a
rename — and it is a decision for the repository's owner, so it is recorded as a
finding with both remedies named rather than applied.
