# P15 STEP 2 — the credential-pattern check, with both controls

V5 §22 / the post-publication credential scan
(`docs/decisions/AUDIT-REQUEST-2026-09-20-v3-status.md` section 8.6) recorded that
`.gitignore` had **no credential patterns**, found **no active leak**, and named
the prospective risk: the project's real credential store is
`$DSH_HOME/.credentials.yaml` per `docs/GAPS.md`, and it "simply does not exist on
this machine today".

Measured in `D:\DSH\work\wt-p15` at `2e1b2c2`, after the edit to `.gitignore`.

---

## The requirement, and the trap inside it

The task is one line of `.gitignore`. The trap is that a `.gitignore` line which
silently excludes a file the repository NEEDS is a worse defect than the missing
pattern, because the tree still looks complete. That is the same failure shape as
the Windows clone bug (`qualification/results/ROOT-round2/clone-path-length.md`:
a failed clone leaves `git ls-files` at 0 and the checkout looks merely empty), and
as the omission this `.gitignore` already documents at its top, where
`packages/dsh-ipython/` stayed wholly untracked — sources included — for an entire
build.

So the pattern set was built by checking each candidate against the tracked set
FIRST, and then verified in both directions.

## A. Every pattern checked against the tracked set

`git ls-files -- <pattern>` — all return **0 tracked matches**:

```
.env  .env.*  *.pem  *.key  .credentials*  .credentials.yaml
*.p12  *.pfx  *.jks  *.ppk  *.keystore
.npmrc  .pypirc  .netrc  .git-credentials
/data-artifacts/  store-cursor-key.json
```

And the decisive whole-tree check, after the edit:

```
$ git ls-files --cached | git check-ignore --no-index --stdin
(no output)
```

**Zero tracked files are ignored.** That is the check the slice asked for.

## B. The one candidate that was REJECTED, and why — `*.env`

`*.env` matches a **tracked** file:

```
qualification/fixtures/canary/outside/canary-credential-shaped.env
```

It is the fabricated canary that `packages/dsh-daily-work/src/security-denial.test.ts:746`
and `sec-gates.test.ts` read to prove that a secret-shaped file OUTSIDE the
workspace root is handled correctly. Its own first line says
`# FABRICATED. No byte of this file came from a real credential store.` and every
value is self-evidently inert (`CANARY-FAKE-API-KEY-VALUE-0000-not-real`).

Demonstrated in a scratch repository, not argued:

```
$ printf '*.env\n' > .gitignore
$ git check-ignore --no-index -v canary-credential-shaped.env
.gitignore:1:*.env	canary-credential-shaped.env        <- exit 0, WOULD be ignored
```

The file is already tracked, so nothing breaks today. But the next canary a writer
adds would vanish from `git status` silently. `.env` and `.env.*` are used instead:
they match the fixture not at all and still catch the real thing.

## C. The project-specific pattern, and why it is ROOT-ANCHORED

`STORE_CURSOR_KEY_FILE_NAME = 'store-cursor-key.json'`
(`packages/dsh-daily-work/src/artifacts.ts:235`) is 32 CSPRNG bytes that sign every
page cursor this deployment issues — a real secret, minted and written into the
store root. Normally that root is `$DSH_HOME`, outside the tree. But
`defaultArtifactRoot` has a documented relative fallback:

> "If neither is available … the fallback is the relative `data-artifacts`, and it
> is LOUD … the service records it as a warning naming the cwd dependence at
> construction time rather than leaving the location an accident."
> — `packages/dsh-daily-work/src/data-service.ts:553-600`

A relative root resolves against the process cwd, so there IS a code path by which
a live key file lands inside the working tree.

`/data-artifacts/` is anchored because the UNANCHORED form would match a tracked
evidence file:

```
qualification/results/V7-fs/workspace/data-artifacts/objects/07d894c4eb826e...   (real FS-family artifact)
```

Verified both directions in a scratch repo: the root-level
`data-artifacts/objects/...` is IGNORED, the tracked V7-fs path is NOT.

## D. POSITIVE control — the patterns must FIRE

Real credential shapes, created in the tree and tested:

| file | result |
|---|---|
| `.env`, `.env.local`, `deep/nested/.env` | IGNORED |
| `.credentials.yaml`, `.credentials` | IGNORED |
| `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` | IGNORED |
| `id.pem`, `private.key` | IGNORED |
| `cert.p12`, `bundle.pfx`, `trust.jks`, `host.ppk`, `app.keystore` | IGNORED |
| `store-cursor-key.json`, `deep/nested/store-cursor-key.json` | IGNORED |
| `data-artifacts/objects/ab/cdef` | IGNORED |

19 of 19 fired. A guard that never fires and a guard that is absent produce
identical evidence, so this arm is the one that makes section A mean something.

## E. NEGATIVE control — real files must stay VISIBLE

| file | result |
|---|---|
| `qualification/fixtures/canary/outside/canary-credential-shaped.env` | visible |
| `qualification/fixtures/canary/outside/canary-secret.txt` | visible |
| `qualification/results/V7-fs/workspace/data-artifacts/objects/07d894c4...` | visible |
| `qualification/results/ROOT-verification/kernel-cwd.json` | visible |
| `qualification/results/M0.4-first-toolcall/keyless-smoke.txt` | visible |
| `packages/dsh-daily-work/src/artifacts.ts` | visible |
| `README.md`, `package.json` | visible |

8 of 8 visible. The probe files were removed afterwards; `git status` shows only
` M .gitignore` and the writer's own untracked `.writer-provision.json`.

## F. A second candidate REJECTED — `kernel-*.json`

`jupyter_client` writes its connection file as `kernel-<uuid>.json`, and that file
carries a live HMAC signing key. The obvious pattern is unsafe here:

```
$ git ls-files -- 'kernel-*.json'
qualification/results/ROOT-verification/kernel-cwd.json
qualification/results/ROOT-verification/kernel-cwd-chain.json
qualification/results/ROOT-verification/kernel-cwd-rerun.json
```

Three tracked evidence files begin with `kernel-`. A glob cannot distinguish them
from a connection file, so the pattern would silently exclude real evidence to
guard a file `jupyter_client` writes to its runtime directory, not to the
repository. Rejected on that evidence. If a connection file is ever found inside
the tree, the correct fix is to anchor the pattern to the directory it actually
appears in rather than widen this glob.

---

## What this check does and does not establish

**Establishes:** at `2e1b2c2` + this edit, no tracked file is ignored by any new
pattern; the new patterns fire on 19 real credential shapes; 8 real project files
(including the canary fixtures and the tracked `data-artifacts` evidence) remain
visible; and the two candidate patterns that would have caused silent loss
(`*.env`, `kernel-*.json`) are rejected with the reason recorded in the file
itself.

**Does not establish:** that any credential has ever been committed or that any
rotation is or is not needed. The post-publication scan's finding of **no active
leak** is not re-derived here — this artifact is about a `.gitignore` edit, and a
`.gitignore` prevents nothing retroactively. It also does not make the repository
secret-free going forward: an ignore pattern is a default, and `git add -f`
overrides it, which is why the scan is a CI step (V5 §17 item 16) rather than
something a file can guarantee.
