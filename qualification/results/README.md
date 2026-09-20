# `qualification/results/` — how the v2 layout works, and why

Two directories in here are v2's, and they are deliberately separate. The distinction
is the whole point of V3 §E2, so it is written down rather than left to be inferred
from file names.

```
qualification/results/
  trusted-local-v2-identity/                 ← MEASUREMENT workspace (not a result)
  trusted-local-v2.<contract-id-prefix>/     ← THE RESULT, bound to one identity
    verdicts.json
    evidence-manifest.json
    GATES.md
    identity.json
```

## `trusted-local-v2-identity/` is a measurement workspace, NOT a result

It holds the instruments and their raw output: the boot probe, its transcript, the
driver verdict, the mutation-test record, the evidence-reuse record. These are inputs
to a result, not results.

**It is not named by a contract identity, on purpose.** If it were inside the
identity-named directory, then re-running the probe would rewrite a file in that
directory — and although no identity currently hashes a results path, a directory
whose contents change on every re-run is the wrong place for a result to live. Keeping
the instrument output separate means the identity-named directory contains only
things a reader should treat as filed.

## `trusted-local-v2.<contract-id-prefix>/` is THE RESULT

The directory name is derived from `QualificationContractIdentity`. A result filed
under one identity is not a result for another, which is what makes the identity
useful: a reader who finds this directory knows exactly which deployment and which
definition the verdicts in it describe.

| file | what it is |
|---|---|
| `verdicts.json` | one row per case: `case_id`, `verdict`, `evidence[]`, `reused_evidence[]`, `not_claimed_basis` |
| `evidence-manifest.json` | every evidence artifact with its sha256 and its origin (v2-measured or REUSED_EVIDENCE) |
| `GATES.md` | the human-readable gate table |
| `identity.json` | the two identities this result is bound to, and the field provenance of the runtime input set |

## Results are OUTPUTS: they appear in neither identity's input set

This is the property the split exists for, and it is **checked on every run** rather
than asserted here.

- `RuntimeDeploymentIdentity` hashes the runtime input set (upstream and
  implementation SHAs, launcher and lockfile digests, Node/pnpm/Python/Jupyter
  identities, profile and preset digests, the resolved host graph, the per-Agent tool
  catalog digest, the extension package digests, the provider route, the trust-model
  statement).
- `QualificationContractIdentity` hashes `RuntimeDeploymentIdentity`, the acceptance
  definition digest, and the qualification-runner/gate digests.

Neither input set names a path under `qualification/results/`. `file-result.py
--self-test` recomputes both identities before and after a real filing and fails if
either moved; `mutation-test-identity-split.py` arm E writes a real file into this
tree and asserts that neither moved.

## The v1 defect this layout removes

In v1 the acceptance spec was **both** an identity input and the evidence ledger. So
filing a verdict changed the digest of a pinned input — measured: the live ledger's
digest moved across **11 distinct revisions** as families filed. The v1 workaround was
a frozen snapshot of the spec as authored, which works but leaves the pin describing a
file that is not the ledger.

In v2 a result is a file under an identity-named directory, and filing one moves
nothing. `qualification/specs/frozen/` still holds v1's as-authored snapshot because
v1's pin is still in force and is still checked.

## What a reader must NOT conclude

- **Not** that a verdict in here is a PASS for the deployment in general. It is a
  verdict for the `QualificationContractIdentity` in `identity.json` and no other.
- **Not** that a `REUSED_EVIDENCE` binding is a verdict. It is a **binding** of a v1
  artifact, admitted only if all four V3 §E3 conditions hold, and the writer must
  still have read the artifact and stated that it establishes the v2 oracle.
- **Not** that `NOT_CLAIMED` is a soft FAIL. It asserts that the contract makes **no
  claim**, and it is refused unless the filing names the topology fact that makes the
  invariant inapplicable.
