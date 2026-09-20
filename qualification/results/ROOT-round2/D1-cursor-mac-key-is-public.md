# D-1 CONFIRMED by the root agent: the cursor MAC key is derived from data the caller holds

Writer S8 found this while trying to FALSIFY DATA-11. It is the most consequential
finding of round 2, so it was re-verified here from scratch rather than accepted on
S8's report. **It reproduces.**

## The claim

`cursorSecretOf(descriptor)` (`artifacts.ts:1905`) is:

```ts
return `${descriptor.id}:${descriptor.captured.sha256}:${descriptor.authority.ownerScope}:${descriptor.authority.grantRevision}`
```

All four components are **descriptor fields**. The descriptor is handed to the
caller by `data:fs.capture` (`data-bridge.ts:255`), stored verbatim by the Python
client (`dsh_data_client.py:82`, "Kept verbatim: re-deriving it..."), and sent back
on every page call (`:134`, `:148`, `:185`). So the "host secret" is not secret:
it is a deterministic function of data the caller already has.

## The reproduction

A fresh probe re-derived the key from the PUBLIC descriptor and forged a cursor of
the host's own shape with one field changed — `position` — then presented it to the
real `pages()` entry point:

```
field order in the HOST cursor: storeRealmId, artifactSha256, observationId,
  revision, representation, query, position, ownerScope, watermark, schemaVersion
host position: 64

FORGED: same shape, position 500, signed with the re-derived key
RESULT: *** ACCEPTED *** -- served offset 500 ( 64 bytes )
        the caller chose offset 500; the host never issued that cursor
```

Note what made this decisive: the first attempt used a **sorted key/value**
canonical form and was refused (`pagination-cursor-invalid`), which was no evidence
either way — a refusal from a malformed token proves nothing about the key. The
host's actual canonical form is `JSON.stringify(full)` in the interface's field
order (`artifacts.ts:1443`). Once the shape matched, the forgery was accepted. A
test that stops at the first refusal would have concluded the opposite.

## The prose is the opposite of the code

`artifacts.ts:1578-1581`:

> "HMAC-SHA256 keyed by the host secret, not a bare hash of `secret + payload` ...
> and **the secret is the only thing standing between a caller and a self-minted
> cursor naming any position in any artifact**."

The HMAC construction is genuinely correct — but the key it uses is public, so the
sentence describes a protection that does not exist. This is the same defect class
the project keeps finding, at its most damaging: a claim of enforcement written in
the grammar of enforcement, in a comment that a reader would trust.

## Why the existing 32 green arms did not catch it

S8's mutation testing identified the reason precisely: **nothing in R7's suite tests
a CORRECTLY-SIGNED forgery.** The arms tamper with the token (edit bytes, re-sign
naively, corrupt fields), so they all trip the MAC — which proves the MAC is
computed, not that it protects anything. Seven of the bound fields DO refuse a
signed forgery, but each is also compared against a live value, so those refusals
are not the MAC working. `position` and `storeRealmId` are compared only against
the caller's own input, which is why they pass.

A gate whose arms all fail for the wrong reason is the exact failure mode this
project's brief warns about.

## A second, smaller defect (S8's D-2)

`store-realm.json` is MACed by nothing and bound to nothing: one `copyFileSync`
makes store B accept store A's cursors. The design doc argues at length for a file
over a path hash and never states that a file is therefore copyable.

## Reachability, stated honestly

- Measured through `DataPlaneService` / `pages()`, which the `daily-data-plane` row
  constructs. **A real boot driving a cell was NOT performed**, so model-facing
  reachability is inference, not measurement.
- This is **not a sandbox escape**: the OS user account remains the execution
  authority boundary. It is a false claim about a mechanism, reachable by a caller
  who already holds a descriptor.
- The refusal message itself leaks the target realm (`artifacts.ts:1516-1517`,
  returned verbatim by `data-bridge.ts`), so a cross-store forgery needs no prior
  knowledge of the other store's realm.

## What this does NOT change

DATA-11's own oracle arms all HELD under S8's attack: different store → refused;
different revision → refused; refusals recorded for every type; 16 in-process and 8
real OS processes racing one root produced ONE realm; a realm replaced between mint
and replay → refused both ways; a v1 `schemaVersion` refused while v2 is accepted
(so that check is a version check, not a MAC accident). The case is not vacuous —
it is incomplete. It tests the wrong attacker.

## Not fixed here

`artifacts.ts` is not owned by this note. S8 correctly reported rather than fixed,
so the authority-model change can be reviewed on its own. The fix needs a key that
is NOT derivable from the descriptor — which is a design change to how a cursor is
bound, not a one-line patch.
