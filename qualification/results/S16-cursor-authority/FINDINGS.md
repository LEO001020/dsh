# S16 — D-1: the page cursor's MAC key was public; it is now a minted store secret

**Verdict: the forgery is REFUSED.** A correctly-signed cursor naming a position the
host never minted was ACCEPTED before this change and is REFUSED after it, measured
through the product service. D-2 is reduced but NOT eliminated, and the residue is
measured below rather than left to be discovered.

Identity measured under: `D:/DSH/work/wt-s16`, branch `wt/s16`.

| revision | `artifacts.ts` sha256 | meaning |
|---|---|---|
| `13d46f0` (before) | `8dac7929894e0f9938c689df27704b21755e4a32efa0562275bb25fbe6fac703` | the defect |
| working tree (after) | `6941542cc3115b9830035cba4b89c26083a70859a1ee4c65bc89787165b1a00a` | the fix |

---

## 1. The defect, re-derived here rather than accepted on report

`cursorSecretOf` (`artifacts.ts:1905` at the before-revision) was:

```ts
return `${descriptor.id}:${descriptor.captured.sha256}:${descriptor.authority.ownerScope}:${descriptor.authority.grantRevision}`
```

All four components are **descriptor fields**. The descriptor is handed to the caller by
`data:fs.capture` (`data-bridge.ts:255`), stored verbatim by the Python client
(`dsh_data_client.py:82`) and sent back on every page call. So the "host secret" was a
deterministic function of data the caller already held.

**Reproduction (`s16-before.json`), three correctly-signed forgeries through the real
`pages()` entry point:**

| attack | result before the fix |
|---|---|
| `position` 64 → 500, signed with the re-derived key | **ACCEPTED**, served offset 500, bytes = payload[500:564] |
| a cursor naming store B's own realm, signed the same way | **ACCEPTED** by B, served 64 bytes |
| one `copyFileSync` of `store-realm.json` (D-2) | **ACCEPTED**, B adopted A's realm |

Controls, so the acceptances are not artifacts of a malformed token: the honest walk
continued at offset 64; R7's own cross-store arm HELD (A's honest cursor refused by B);
the host cursor's field order was read back and matches the interface order with
`schemaVersion` last.

**The trap that cost the root agent an attempt.** The canonical form is
`JSON.stringify(full)` in the INTERFACE FIELD ORDER (`artifacts.ts:1443`), not a sorted
key/value list. A sorted form is refused — and that refusal proves nothing about the
key, because it is a malformed token. The sorted-key token is kept in the suite as the
control that a malformed-token refusal is not evidence.

### A third prose inversion, found while measuring

The `sortedKeyControl` arm was **also ACCEPTED**. The class doc claimed the payload is
"RE-SERIALIZED CANONICALLY ... Signing the canonical form means the verified bytes and
the fields the pager uses are the same bytes" (`artifacts.ts:1425-1429` before).
`verify` signs the payload substring it then parses, so the property that sentence
WANTS does hold — but by a different mechanism, and a token in another key order
verifies too. The sentence described an implementation that did not exist. Corrected to
state the mechanism that does.

---

## 2. The fix, and why this shape

A key **derived** from anything the caller holds is not a key. So the key is **minted
and stored**:

- `store-cursor-key.json` in the store root: 32 CSPRNG bytes, base64url (43 chars),
  created with `wx` and never rewritten — the same protocol the realm uses, so two
  processes over one root agree on ONE key and a walk survives a restart;
- `ArtifactStore.cursorKey()` is the narrow contract addition. `pages()` receives an
  `ArtifactStore` and **no secret**, so a key it could COMPUTE is a key a caller can
  compute — which is D-1 exactly;
- `put()` resolves the key alongside the realm, so a store that can publish can issue
  cursors, and a key failure lands on a retryable capture rather than on a later page
  read that would look like a forged token;
- a key file that is malformed, empty, or **shorter than 43 chars** is REFUSED, never
  regenerated and never accepted.

### Every candidate considered, with the weakness that ruled it out

| candidate | weakness |
|---|---|
| the descriptor (**the defect**) | public by construction; it is the thing being paged |
| a compiled-in constant | in the repository; every deployment shares one key and any reader of the source can forge |
| **the realm id** | **disclosed** — carried in the cursor and named in refusals; the refusal message returned both realms verbatim (`artifacts.ts:1516-1517` → `data-bridge.ts`). A key derived from it is public. Kept as a signed FIELD instead, which is why the realm check is still a second independent line |
| an environment variable | absent by default; a deployment that did not set it would silently fall back — this defect class exactly |
| host-process memory only | correct against forgery, but per-boot: it breaks a walk spanning a restart. That is the failure the realm design already documents, and `data16` measures it (M8 reddens 4 arms) |

---

## 3. D-2: reduced, and the residue is measured

`store-realm.json` is still MACed by nothing and bound to nothing. But the fix makes
the realm **no longer the only store identity**:

| case | before | after |
|---|---|---|
| copy `store-realm.json` only | **ACCEPTED** (`s16-before.json` `realmCopyAfter`) | refused, `pagination-cursor-invalid` (`s16-after.json` `realmCopyOnlyAfter`) |
| copy BOTH files (whole-root clone) | accepted | **still accepted** (`s16-after.json` `wholeRootCloneAfter`) |

**The residue is real and is NOT closed.** A caller who can write both files has the
store. That is out of scope — the OS user account is the execution authority boundary
for this product — but it is recorded rather than left to be found. What changed is
that D-2 alone is no longer sufficient, not that the store root is tamper-proof.

---

## 4. A consequence I had to handle, because it looked like a regression

With a per-store key, a cross-store token now fails at **STEP 1 (the MAC)** and never
reaches the realm comparison at step 2. Seven existing arms asserting
`pagination-realm-denied` went red.

That refusal is *stronger*, but collapsing it into `pagination-cursor-invalid` would
lose the distinction `pagination-realm-denied` was introduced for
(`artifacts.ts:312-321`) and which the product R7 probe branches on. So a MAC failure
is classified by what the token **claims**, without believing it. The classification
decides only *which refusal the caller is told about*, never whether the request is
served — both branches refuse.

**The message names NO REALM.** A request that failed the MAC is unauthenticated, and
answering it with an identity would hand the serving store's realm to anyone who can
send a garbage token — the disclosure amplifier that made the old cross-store forgery
need no prior knowledge. Step 2 still names both realms, because there the MAC DID
verify. The rule: **no identity out of an unauthenticated request, full diagnosis out
of an authenticated one.**

Because the realm comparison would otherwise be unreachable, a **shared-key block** was
added: two stores that share a key (a whole-root clone, one key provisioned twice) still
refuse a cross-realm cursor, and the refusal is recorded through the production
provider with both realms named. Mutation M9 (realm comparison a no-op) reddens exactly
that arm, so it is not decorative.

---

## 5. Arms that would have caught it

The reason 32 green arms missed this: **every existing arm TAMPERS with the token**, so
every one trips the MAC — proving the MAC is computed, not that it protects anything.
`position` and `storeRealmId` were the two forgeable fields because the other seven are
also compared against a live value, so their refusals are not the MAC working.

Added (each with positive controls asserted OUTSIDE the refusal assertion):

- `data11-cursor-realm.test.ts` — a correctly-signed forgery of `position` (refused, and
  named as the MAC); a correctly-signed forgery of `storeRealmId` (refused, and the
  refusal must not name a realm); the key's provenance; the shared-key realm block; D-2
  re-measured. **32 → 37 arms.**
- `data16-cursor-key-authority.test.ts` — 15 arms on the key's own authority: not the
  old derivation nor a digest of it; per-store (rules out a constant); shared by two
  stores over one root; durable across two REAL OS processes; memoized; absent from the
  cursor, the refusal message, the journal ON DISK, and the realm record; a malformed,
  empty or truncated key refused; a store whose key cannot be resolved refuses the PAGE
  with a recorded refusal; and a multi-page walk reassembles byte-for-byte as the
  positive control for a file full of absence assertions.

---

## 6. Mutation arms — every new arm was watched go red

`run-mutation-arms.sh` → `MUTATION-ARMS.txt`. `artifacts.ts` is restored and
checksum-verified byte-identical after **every** mutation; the script refuses to exit 0
otherwise.

| mutation | data11 | data16 |
|---|---|---|
| **M1** the D-1 regression: key from the descriptor again | 3 red | 1 red |
| **M2** key derived from the **disclosed realm id** | 1 red | 1 red |
| **M3** `position` excluded from the MAC | 9 red | 2 red |
| **M4** minimum key length not enforced | — | 1 red |
| **M5** malformed key silently regenerated | 2 red | 4 red |
| **M6** key disclosed in a refusal message | — | 1 red |
| **M7** key not memoized | — | 1 red |
| **M8** per-boot key (a restart bug wearing a security property) | 2 red | 2 red |
| **M9** realm comparison a no-op | 1 red | — |
| **M10** minted realm is a constant | 14 red | 2 red |
| **M0** no-op control | **GREEN** | **GREEN** |

M0 is the harness's own control: a mutation that changes nothing must leave both files
green, so a harness that reddened for any input cannot masquerade as success. M2 catches
the **class** (a key derived from a disclosed value), not just the historical string.

**A mutation that proved nothing, recorded because it is the same failure mode the arms
exist to catch.** M8's first version was written as
`if (existing !== undefined && process.env['S16_PER_BOOT'] !== '1')`, so the per-boot
branch was only taken when an environment variable was set — and the test run never set
it. Everything stayed green, which read as a gap in the durability arms when it was a
gap in the **mutation**. Made unconditional, it reddens 4 arms. A mutation that cannot
fire is a mutation that proves nothing.

**One inconsistency fixed while measuring:** `RecordingPageProvider` (the walk route)
wrote a refusal WITHOUT `cursorRealmId`, while `pages()`'s sink path preserved it — so
the same refusal produced different durable evidence depending on which route refused.
Both routes now carry it.

---

## 7. Product reachability

**MEASURED** (`s16-reachability.json`): the shortest real path is
`profile boot → data-plugin.ts:49 → DataPlaneService → data-bridge fs.page →
service.page() → pages() → store.cursorKey()`. Through that service: the first page
serves the artifact's bytes; the honest continuation resumes at 64; the
correctly-signed forgery is **REFUSED** (`pagination-cursor-invalid`); and the refusal
is recorded in the service's own durable journal, read back through
`DataPlaneService.refusals()`.

**NOT MEASURED — `NOT_RUN`:** a real profile boot driving a model cell. This probe
constructs `DataPlaneService` in-process, exactly as `data-plane.test.ts` does, so it
proves the **service** reaches the fix. Model-facing reachability is inference from the
`data-bridge` route, not measurement.

---

## 8. What I did NOT do

- Did not boot a profile to drive a real cell.
- Did not close D-2's whole-root-clone residue (measured and reported instead).
- Did not touch `packages/dsh-ipython/**`, `profiles/**`, `compatibility.lock.json`, or
  `docs/GAPS.md`.
- Did not weaken any DATA-11 oracle arm: different store refused, different revision
  refused, refusals recorded for every type, a v1 `schemaVersion` refused while v2 is
  accepted, realm stable across a real OS restart, and a cursor minted before a restart
  resumes after it — all still hold.

### Adjacent finding, NOT mine to fix

`dep-gates.test.ts` regenerates `qualification/results/M-DEP-SEC-UPG/declared-vs-imported.txt`
and `typecheck-errors.txt` as a side effect of running it. The regenerated
`declared-vs-imported.txt` differs from the committed one — it now lists
`@deepseek-ai/dsh-commands` among both imported (22) and declared (11), where the
committed evidence says 21 and 10. **The committed evidence is stale relative to the
tree.** I restored both files with a narrow `git checkout --` and left them alone; it is
outside my slice and is reported rather than swept into my commit.
