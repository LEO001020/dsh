# The frozen trusted-local-v1 specification

**File:** `acceptance-spec.trusted-local-v1.as-authored.json`
**sha256:** `e5b6a1d2481f39c52a6012ec6b48a72e4618ff713f1927b6b0d6827a24b10ce7`
**Pinned as:** `deployment.inputs.trusted_local_acceptance_spec_sha256`

## Why the filename is not the one V3 section E1 suggests

V3 names a frozen file `acceptance-spec.trusted-local-v1.frozen.json`. **This
repository keeps the existing name and path instead, deliberately.**

The reason is ordering, and it is not a stylistic preference: this snapshot's
sha256 is already a **pinned deployment identity input**. Three independent
checks read that exact path and compare that exact digest —
`helpers/doctor.py`, `qualification/results/T1-spec/verify-identity.py`, and
`qualification/runners/verify-spec.py`. Renaming or moving the file would change
the path those checks read and break the identity pin, for a filename change that
carries no information the content does not already carry. V3's own instruction
where its text and the local source disagree is to preserve the contract, record
the contradiction, and choose the smallest change.

## What "frozen" means here, verified rather than asserted

The frozen artifact is the **as-authored** specification: the case definitions,
stimuli and oracles exactly as written, with **no verdicts and no evidence**. That
is the distinction that makes it useful as an identity input — if it carried
verdicts, then filing evidence would change the digest and invalidate the pin, which
is precisely the conflict this snapshot was created to resolve.

Verified on this tree:

| Property | Measured |
|---|---|
| case count | **109**, identical to the live ledger |
| status distribution | **109 `NOT_RUN`** — the as-authored state, not a filed one |
| cases carrying evidence | **0** |
| oracle text vs the live ledger | **identical for every case checked**, including `CMP-04` and `CMP-13` |

## The contradiction is PRESERVED, on purpose

`CMP-04` requires `pwsh` **present**; `CMP-13` requires `pwsh` **ABSENT**. Both are
mandatory, and both are measured on one catalog, so at most one can hold. Verified
in the frozen snapshot: both oracles still say what they said.

**That contradiction is evidence, not a defect to repair.** It records that the
specification and the deployment diverged 19 minutes apart on 2026-09-20: the case
was authored at 04:59:30, and commit `35c829d` at 05:18:50 disabled `tool-pwsh`
unconditionally so IPython became the model's only execution surface. Editing
`28`→`27` or `present`→`absent` would satisfy the letter of the oracle while erasing
the record that the two artifacts disagreed — which the spec forbids twice ("no PASS
by editing an oracle after the fact"; "a case may only be marked PASS when that file
establishes THIS oracle").

The resolution lives in the **v2** definition (`docs/decisions/V3-v2-oracle-resolutions.md`,
decision D1), where the tool-surface oracle describes the current architecture and the
count moves into evidence. **v1 is not edited.**

## What a reader should NOT conclude

- **Not** that the frozen file is the current ledger. It is not: it is the authored
  artifact. The live ledger is `../acceptance-spec.trusted-local-v1.json`, and it is
  the one that carries verdicts and evidence.
- **Not** that the two files should be identical. They must differ: one is as-authored,
  the other is as-filed. A frozen snapshot that tracked the ledger would be useless as
  an identity input.
- **Not** that the contradiction has been resolved. It is resolved in v2 and preserved
  in v1, and both facts are intentional.
