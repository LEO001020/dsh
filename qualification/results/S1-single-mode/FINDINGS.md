# S1 — one selectable mode, without touching the pinned checkout

**Slice:** make our single mode the only selectable mode, without editing
`D:\DSH\src\dsh-src`.

**Verdict: the change is made and measured end-to-end.** The product's own roster
goes from five selectable modes to one. The pinned checkout is unmodified.

---

## 1. The authorization and the honest boundary

The user authorized: *把 dsh 的原生模式都删掉，只留下我们自己这一个模式* — delete
DSH's native modes, keep only our single mode.

**The literal reading is impossible and this is why.** "模式" is overloaded across
four unrelated mechanisms, and all four live in the read-only pinned checkout
(`docs/exec-plans/v3-round2-brief.md` §1 maps them: agent preset, shipped
profile, sandbox mode, tool presentation mode). Case **ID-06**'s oracle requires
`D:\DSH\src\dsh-src` to be unmodified, so deleting them would trade one FAIL for
a worse one and make the qualification meaningless.

**What was actually done: the EXPOSURE was removed, not the upstream code.**

> The four shipped presets still exist, byte-identical, in the pinned checkout at
> `packages/preset/agent-presets/presets/`. They are not selectable on this
> deployment because our composition no longer prepends that directory as a
> roster root.

A reader must not mistake one for the other. "We deleted the native modes" is
**false**; "our deployment no longer offers them" is **measured true**.

---

## 2. The mechanism, from the source

The roster composes its root list in the **constructor**
(`packages/preset/agent-presets/src/index.ts:182-184`):

```ts
this.resolvedRoots = [
  ...config.includeShippedRoot ? [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }] : [],
  ...config.roots,
  ...config.includeUserRoot ? [{ path: dshHomePath(USER_PRESET_DIR), trust: 'user' }] : [],
]
```

| question | answer | evidence |
|---|---|---|
| Does `false` hide the shipped presets, or break discovery? | **Hides them.** The shipped root is one ELEMENT of a list, omitted when false. The profile's own root and the user root are scanned by the same walk. | `index.ts:182-184`; `discovery.ts:324-337`; pinned test `tests/shipped-root.spec.ts:119-129` asserts `roots` equals the configured roots and nothing else |
| Is `SHIPPED_PRESET_ROOT` editable? | No. It is derived from the package's own location: `fileURLToPath(new URL('../presets/', import.meta.url))` | `discovery.ts:60` |
| What is the schema default? | `true` | `index.ts:114` |
| Must the key be restated? | **Yes.** A patch replaces the whole `config` object, so omitting it restores `true` silently. | `vendor/include/src/index.ts:120-123` |

**Consequence for `default`:** the stock default is `standard`, which carries no
`ipython`/`work` tool rows — so it was never a usable mode for this deployment.
It was an OFFER that could not reach either extension. Removing it removes a way
to compose a session that looks healthy and has neither tool.

---

## 3. BEFORE / AFTER — the same command, the same probe

Both runs boot the **real installed profile** (`--profile daily`, `DSH_HOME=D:\DSH\home\s1`)
through the shared `boot-harness.mjs`, with a probe that adds **no product rows**:

```sh
node qualification/results/S1-single-mode/s1-roster-driver.mjs before
node qualification/results/S1-single-mode/s1-roster-driver.mjs after
```

The only variable between them is `includeShippedRoot` in
`profiles/daily-candidate/cordis.patch.yml`. The driver re-installs the profile
and re-applies the provisioner's link-target rewrite before each boot, so a
stale copy cannot be measured as the new one.

| field | BEFORE (`true`) | AFTER (`false`) |
|---|---|---|
| `roots` | 3: shipped, profile, user | **2: profile, user** |
| `shippedRootPresent` | `true` | **`false`** |
| `listedIds` | `standard, ptc, minimal, cordis, daily-standard` (**5**) | **`daily-standard` (1)** |
| `listedCount` | 5 | **1** |
| `defaultId` | `daily-standard` | `daily-standard` |
| `resolve('standard')` | resolves | **THROWS** `agent-presets: preset "standard" not found (available: daily-standard)` |
| `resolve('ptc')` / `('minimal')` / `('cordis')` | resolve | **all THROW**, same shape |
| `resolve('daily-standard')` | resolves | **resolves** (positive control) |
| real Session's preset | `daily-standard` | `daily-standard` |
| `toolCountAgentKey` | 27 | **27** (unchanged) |
| `ipython` / `work` present | true / true | **true / true** |
| activation warnings | 0 | **0** |

**`list()` and `resolve()` are separate code paths, so both were measured.** A
change that emptied the roster while resolution still answered a shipped id would
pass a roster-only assertion. It does not: all four throw.

**The positive control is the point of the "after" column.** The tool face is
unchanged at 27 tools with both extension tools present, so the deployment lost
its extra modes and nothing else.

Artifacts: `roster-before.json`, `roster-after.json`, `driver-before.json`,
`driver-after.json`.

---

## 4. The pinned checkout is unmodified

```sh
$ git -C D:/DSH/src/dsh-src status --porcelain
 M packages/deliverables/workspace-changes/src/index.ts
$ git -C D:/DSH/src/dsh-src rev-parse HEAD
ddefc45fbc7f8e46dd73185e68295696d1297887
```

**The single entry is PRE-EXISTING and is not a content edit.** Verified:

- `git hash-object <worktree file>` == `git rev-parse HEAD:<path>` == `c05787d9…`
  — the blob ids are identical, so there is no content delta.
- `git diff --numstat` is empty.
- Byte-comparison after CRLF normalisation: both are md5 `789f7ffc…`.
- File mtime `2026-09-19 19:19:47`, roughly 23 hours before this session.
- `qualification/runners/check-source-plane.mjs` classifies it as
  `EOL_STAT_DIRTY` ("no content delta"), which is the pre-existing classification.
- It is already recorded in `qualification/results/ROOT-verification/pinned-checkout-state.md`
  and `qualification/results/V1-identity/ID-06-pinned-checkout-state.txt`.

HEAD is the pinned commit. Nothing in this slice wrote to the checkout.

---

## 5. `preset.yml` — decided from the schema, not guessed

**Question:** is a `preset.yml` required for our preset to be listed?

**Answer: NO, and this was measured rather than inferred from the schema.**

- `COMPOSITION_FILE = 'agent.cordis.yml'` alone makes a directory a preset
  (`discovery.ts:37`; a directory without it is reported `broken`, not skipped).
- `METADATA_FILE = 'preset.yml'` is **optional display text only**; every read
  failure degrades to `{}` and the preset still mounts (`metadata.ts:25`,
  `:14-16`, `:56-64`). `id` and `trust` are deliberately NOT writable there.
- **MEASURED:** before `preset.yml` existed, the deployment booted and the roster
  listed `daily-standard` as a healthy, selectable row with `name: null`
  (`roster-before.json`, `listed[4]`).

**So the roster worked without it.** One was added anyway, for the reason that
actually applies: with the shipped set gone, our preset is the ONLY label a
person sees in the picker, and the four presets it replaces all carried a
`name:`. Leaving ours unnamed would be a visible regression in the one surface
that remains.

- `name: 日常模式` — same language as the shipped names it replaces, because the
  picker renders them in a bilingual UI.
- `order: 1` — declared for the same reason the shipped set declares it
  (`discovery.ts:311-314`). With one row the value cannot be observed to matter;
  it is declared so a second row appearing later sorts predictably. **This is
  stated rather than dressed up as a fix.**
- `description` — one sentence, and it deliberately promises nothing the
  composition does not do.

**What it does NOT change:** it is display text. It moves no digest input
(`helpers/rederive-identity.py` derives `agent_preset_digest` from
`agent.cordis.yml`, not `preset.yml`), so it is identity-neutral.

---

## 6. The gate, and its mutation test

`packages/dsh-daily-work/src/profile-isolation.test.ts` gained a
`the deployment offers exactly one selectable mode` block (5 cases):

1. `includeShippedRoot` is **`false`** in the patch — the VALUE, not the key's
   presence, because the schema default is `true` and an omitted key would
   silently restore all four modes.
2. `includeUserRoot` is **`true`** — it is not one of the four "modes"; it is the
   writable authoring directory, and `authorable` is computed from it
   (`index.ts:520-522`). Measured: it does not exist on this deployment, so it
   contributes zero selectable modes.
3. `default` is **`daily-standard`** — otherwise the deployment would offer one
   mode and compose a different, unselectable one by default.
4. **End-to-end:** boots the real roster with the root set the profile composes
   and asserts `listedIds === ['daily-standard']`, that all four shipped ids
   fail to resolve with `agent-preset/not-found`, and that ours resolves.
5. Our preset publishes a display `name` and `order: 1`.

**The end-to-end case reads `includeShippedRoot` from the patch rather than
retyping it.** A gate that hardcoded `false` would keep passing after the patch
was reverted and would then be measuring itself. The reader also strips comments
first, because this patch documents its own history at length and the DIFFERENCE
1c comment quotes the OLD `true` value — a naive `String.includes` scan would
match the comment. (Round 1 recorded exactly that defect class: a scan that
reported a LIVE function as deleted.)

### Mutation test

`includeShippedRoot: false` → `true`, temporarily:

```
× sets includeShippedRoot: false in the profile patch, explicitly
    AssertionError: expected 'true' to be 'false' // Object.is equality
× offers exactly ONE preset when the profile's own root is scanned
  Test Files  1 failed (1)
       Tests  2 failed | 30 passed (32)
```

Restored:

```
  Test Files  1 passed (1)
       Tests  32 passed (32)
```

and the patch digest returned byte-identical to `4e3aa20c…`. **The gate goes red
when the property is broken and green when it holds.**

---

## 7. Files changed, and the digest consequence

| file | why |
|---|---|
| `profiles/daily-candidate/cordis.patch.yml` | `includeShippedRoot: true` → `false`, with the boundary and the measurement recorded in the row's comment |
| `profiles/daily-candidate/presets/daily-standard/preset.yml` | NEW — display name/description/order for the one remaining mode |
| `packages/dsh-daily-work/src/profile-isolation.test.ts` | the single-mode gate; two describes retitled/annotated so "the shipped root's contents" is not mistaken for "what the deployment offers" |
| `packages/dsh-daily-work/src/eco.test.ts` | `DAILY_PATCH_SHA256` re-derived (see below) |
| `qualification/runners/verify-cmp-composition.mjs` | the shipped-`standard` contrast fallback removed (it now throws); `contrast` made null-safe |
| `docs/DELETE-AUDIT.md` | §5's "the shipped root is still included" marked SUPERSEDED; new §5a records the decision, the boundary and the measurement |
| `qualification/results/S1-single-mode/**` | NEW — the probe, the driver and the before/after artifacts |

### The identity moves, and must be sequenced

`python helpers/rederive-identity.py` after the change:

```
recorded identity  : 0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461
recomputed identity: 709a0fcee45b45f4da218d04e690c9955d23c0d1a1c83b45e022aa9c24c45388

2 input(s) moved:
  host_profile_digest   recorded 5b8b2a8e… -> computed 4e3aa20c…   <- THIS SLICE
  agent_preset_digest   recorded 16bc20e5… -> computed 05f7a029…   <- PRE-EXISTING DRIFT
```

- **`host_profile_digest` moved because of this slice** (the profile patch).
- **`agent_preset_digest` did NOT move because of this slice.** The file
  `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` is untouched:
  `git diff` on it is empty and its sha256 (`05f7a029…`) equals the HEAD blob's.
  The lock's recorded `16bc20e5…` had already drifted before this session. The
  coordinator independently confirmed this.

`compatibility.lock.json` was **NOT** edited — S3 owns it and had just adopted
`533c8cb0…`. **The identity must be re-derived again after this slice merges.**

### `eco.test.ts` — re-derived, not absorbed

`DAILY_PATCH_SHA256` is a literal precisely so a change to that file cannot pass
unnoticed. It moved `0e8e370e…` → `4e3aa20c…`, recorded as the **fourth** move in
the same comment block, and flagged as a **different kind**: the first three were
comment-only, this one is **executable** (one row changed value). Measured after:
`36 passed (36)`.

---

## 8. Product reachability — the shortest real path from a boot

```
dsh --profile daily                                  (installed profile, DSH_HOME=D:\DSH\home\s1)
  └─ profile bundle chain → web-app bundle patch inserts the `agent-presets` row
       └─ our patch OVERRIDES its config: includeShippedRoot: false, default: daily-standard
            └─ AgentPresets constructor composes resolvedRoots = [profile root, user root]
                 └─ ctx.agentPresets.list()  →  roster = ["daily-standard"]           ← the product's own call
                      ├─ UI picker: readRoster → presetOptions(presets)               (ui-agent-preset/src/client/settings-store.ts:83,131-140)
                      └─ ctx.agentPresets.resolve("standard") → THROWS agent-preset/not-found
                           while resolve("daily-standard") → mounts, 27 tools, ipython + work present
```

**Every arrow was measured on a real boot**, not read from the config:
`list()` returned one id; `resolve()` of each shipped id threw; a real Session was
created on the surviving preset and its agent-keyed catalog contained 27 tools
including `ipython` and `work`; zero activation warnings. Artifacts:
`roster-after.json` / `driver-after.json`.

**Where a human sees it:** the Web UI's mode picker renders exactly one row. The
probe reads the same `@Remote('list')` projection the browser reads
(`remoteExportList`), so the roster the picker draws is the roster measured here.

---

## 9. What this does NOT establish

- **It does not delete any upstream code.** The four shipped presets are intact in
  the pinned checkout. Any claim that DSH's native modes were removed is false.
- **It does not cover the other three "mode" mechanisms.** Shipped profiles
  (`PROFILE_TEMPLATES`), `SandboxMode`, and `ToolPresentationMode` are untouched.
  The authorization was read as being about the selectable agent modes, which is
  the only one of the four this deployment exposes as a user choice.
- **It does not establish that `standard` is unreachable by other means.** A
  caller that constructs its own roster with `includeShippedRoot: true` — as the
  pinned package's own tests do — still gets the shipped presets. What is
  established is that THIS deployment's composition does not.
- **It does not prove the UI renders correctly.** The roster projection the picker
  consumes was measured; the browser was not driven.
- **`docs/DELIVERY.md` still quotes the five-preset roster** at `:221` and the
  error text `(available: standard, ptc, minimal, cordis)` at `:796`. Those are
  historical records of a measured state and are outside this slice's ownership;
  they are reported rather than edited.
