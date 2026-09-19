# M9.14 — gates A04, A05, A08, A09, A10, A12

Slice result. What was closed, what the real launcher and config resolver
actually do, and what is still open. Every claim below is backed by a file in
this directory; `tests.txt` is the authoritative run.

## Status

| Gate | Status | What closes it |
|---|---|---|
| A04 profile patch replaces, not merges | **PASS** | `tests.txt` (4 cases) + `dumps/a04-*.yml` |
| A05 home overlay pollution | **PASS** | `tests.txt` (3 cases) + `dumps/a05-*.yml` |
| A08 stock baseline attribution | **PASS** | `tests.txt` (4 cases) + `dumps/a08-*.yml` |
| A09 model routing vs search key | **PASS** | `tests.txt` (5 cases) + `runs/a12-*` |
| A10 headless boundary | **PASS** | `tests.txt` (4 cases) + `runs/a10-*/` |
| A12 real daily host | **PARTIAL — booted to the credential boundary** | `runs/a12-web-host.txt` |

25 tests pass, `tsc` exits 0 for the package and for the new test file, and 5
deliberate falsification mutations each fail in the intended assertion
(`runs/falsification.txt`).

A12 is **PARTIAL and must not be recorded as PASS**. The real Web host was
booted, bound, fenced, and driven through a real Session lifecycle, but **no
model turn was run**, because no credential source on this machine supplies
`DEEPSEEK_API_KEY`. See "A12" below for exactly what was and was not proven.

### Recommendation for `qualification/gates.json`

That file is owned by the gate-report generator, so it is **not edited here**.
For the record, the entries as of this slice are weaker than the evidence now
available, and one is stale:

| Gate | Recorded | Should be | Why |
|---|---|---|---|
| A04 | PASS, evidence = `M3.1` dump | PASS, add `M9.14` | `M3.1` shows the row is complete; it never shows the merge hypothesis is WRONG. `M9.14` asserts both, plus the invalid-row consequence. |
| A05 | PASS, note reasons about `--dump-default-config` | PASS, add `M9.14` | The recorded note argues the baseline is clean; `M9.14` injects a real home patch and shows it in the graph with attribution. |
| A08 | PASS, evidence = `M0.5` + `M3.1` | PASS, add `M9.14` | `M9.14` diffs the two graphs row-by-row and reports zero unattributed differences, including the Goal/fork/compaction families the gate names. |
| A09 | PASS, evidence = `M7.1` | PASS, add `M9.14` | `M7.1` covers this repo's ported provider. The daily profile mounts the SHIPPED one; `M9.14` drives that, and separates `available()` (presence of a resolver) from the request-time `WEB_PROVIDER_CREDENTIAL_MISSING`. |
| A10 | PASS, evidence = `M0.4` | PASS, add `M9.14` | `M0.4` is a keyless smoke. `M9.14` measures the three boundary cases the gate names (truncation, large output, business failure in a completed turn). |
| A12 | **NOT_RUN** | **NOT_RUN**, note updated | Still not closable, but the blocker is now precisely known: the host boots, serves, fences, and creates Sessions; only the model turn is missing, and it is missing because `DEEPSEEK_API_KEY` is unconfigured. The current note ("No long-lived Web host has been driven end to end") understates what is now proven and overstates what is unknown. |

## What the real launcher and config resolver actually do

### 1. A patch replaces the target row's WHOLE `config`. It is not a merge.

The mechanism, quoted from `vendor/include/src/index.ts:120-123`:

```ts
for (const [key, value] of Object.entries(overrides)) {
  if (key === 'id') continue
  target[key] = value
}
```

A whole-value assignment onto `target[key]`, with no recursion into the previous
value. Measured consequence: a patch naming only `openAt` on the shipped
`session-query-sqlite` row (`{path, openAt}`) produces a row with **`path` gone
entirely** — and because `path` is `.required()` in that row's own Schemastery
schema, the row does not activate:

```
dsh: warning: 1 entry did not activate
session-query-sqlite (@deepseek-ai/dsh-session-query-sqlite): ValidationError: invalid config:
  - $.path missing required value (at path)
```

So the wrong mental model does not produce a subtly different graph; it produces
a tree that will not mount. That is the loud failure A04 asks for, and it is
asserted, not narrated.

### 2. The patch layer order is: bundles → profile → HOME → `--patch`.

From `packages/boot/app-boot/src/profile-context.ts` (`readProfilePatches`):

```
...profile.layers (one per bundle), profile patch, $DSH_HOME/cordis.patch.yml, --patch overlays
```

A home-level replacement therefore outranks the profile's own layer, and the
home layer is applied as one more patch list with the same whole-value
semantics. `--dump-default-config` **omits the home layer and the profile
layer by construction** (`apps/cli/src/dump-config.ts`: `homePatches` is read
only when `defaultOnly` is false), which is why that flag is the correct stock
baseline — and the launcher refuses to combine it with `--patch`
(`error: --dump-default-config prints the bundle layers and takes no --patch`).

### 3. Every C0→C2 difference is exactly two rows.

Measured over the real graphs (`dumps/a08-c0.yml` vs `dumps/a08-c2.yml`):

- `subagent`: no `config` block in C0 → `{maxActiveSubagents: 10, maxDepth: 1}` in C2.
- `daily-work-host`: inserted by C2.
- **Nothing else changes.** No row is removed. The Goal, fork and compaction
  families are byte-identical between C0 and C2, including the rows the web-app
  bundle *disables* rather than deletes (`goal`, `goal-round-driver`,
  `subagent-fork-in-process`, `compaction-basic`, `tool-result-pruner`).

The measured C0 gap is real: the stock `subagent` row has **no config block at
all**, so `maxActiveSubagents` falls back to the Schemastery default `8` declared
in `packages/subagent/subagent/src/index.ts:199-202`. N=10 is not satisfiable by
any stock profile.

### 4. Two different things both look like "web search is unavailable".

This is the sharpest finding in the A09 work, and it is easy to get wrong:

- `ctx.web` selection (`packages/web/web/src/index.ts`, `resolveProvider`) turns
  a **registered-but-unavailable** provider into the error
  `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, and "no usable provider" into
  `WEB_PROVIDER_UNAVAILABLE`. Both are **throws**; neither is `{sources: []}`.
- The shipped `DeepSeekSearchProvider.available()` is **presence-of-a-resolver**,
  not presence-of-a-key (`packages/web/web-search-deepseek/src/provider.ts:191-197`).
  The plugin always supplies `resolveApiKey`, so with **no key stored**,
  `available()` returns **`true`** and the failure only appears at the request,
  as `WEB_PROVIDER_CREDENTIAL_MISSING` with nothing dispatched to the wire.
- The daily profile mounts the **shipped** DeepSeek provider, not this repo's
  ported one: `profiles/daily-candidate/cordis.patch.yml` changes only `subagent`
  and inserts `daily-work-host`, so no search provider is overridden.

The project rule is preserved on the one path that can fabricate evidence:
`formatSearchOutput` produces `No results found.` from exactly one branch, and
that branch is reachable **only** from a resolved `WebSearchResult`. A provider
failure throws before the tool renders, so a failure can never be presented as a
zero-hit answer. The tests drive both directions.

### 5. The headless CLI stream is bounded; the Session is not.

`--json` bounds every projected payload
(`packages/bundle/headless/src/json-stream.ts`):

- `MAX_STRING_BYTES = 8 * 1024` — per string and per key, flagged `truncated: true`
- `MAX_EVENT_BYTES = 32 * 1024` — per serialized line
- the terminal `final` is **deliberately not bounded** ("the answer is the
  lossless terminal contract, so it is not truncated")

Measured on a ~1 MiB tool result: the CLI `tool_result` line carried exactly
**8192** characters with `truncated: true`, while the persisted Session record
carried **50000** (the `spill-policy` `maxInlineBytes` budget). A reader who
treats the CLI stream as evidence under-counts the payload by an order of
magnitude unless they read the flag.

### 6. `exit 0` is a statement about the TURN, not the work.

`packages/bundle/headless/src/index.ts`:

```ts
io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
```

Measured: a run whose shell command **exits 3** and whose model then reports the
failure in prose ends `turn/end: completed`, records the tool result with
`isError: false`, and the process **exits 0**. The only carrier of the business
failure is the `[exit code: 3]` text. The complement is asserted too: a real
turn-level error (unregistered provider) exits **1** with `turn/end: error` — so
the two failure kinds are distinguishable and the gate is not vacuous.

## A12 — exactly what was proven, and what was not

**PROVEN** (real built launcher, real `daily-candidate` composition, real HTTP
server; transcript `runs/a12-web-host.txt`):

- The launcher booted and bound a real port, printing the authenticated URL line.
- The browser-trust fence is live: an unauthenticated `POST /api/session/list`
  returned **401**; the printed `?token=` URL exchanged for a session cookie
  (303 + `set-cookie`) and then served the app shell (**200**).
- The real `session/*` RPC surface works: `session/create` returned a session id
  and `session/list` read it back with its projections
  (`agentPreset: standard`, `permissions: workspace-write`).
- `session/modelCatalog` reports the real route
  (`deepseek-official` / `deepseek-flash`).
- The profile the host ran resolves **both** C2 differences
  (`dumps/a12-daily-profile.yml`), so the boot was the daily composition and not
  a bare web profile, and not a headless run (`webserver`/`connection` present,
  `headless-runner` absent).

**NOT PROVEN, and not claimed:**

- **No model turn ran on this host.** No credential source on this machine
  supplies `DEEPSEEK_API_KEY`: not the process environment, not
  `$DSH_HOME/.credentials.yaml` (which holds only a `client-connection/browser-session`
  grant record and no `refs:` section), and no `.env` exists in either the cwd or
  the home. A prompt submitted now fails at the route, so asserting a completed
  turn would be asserting something that did not happen.
- The boundary is confirmed as a **credential** boundary rather than a
  composition failure, from the real SDK profile which mounts the same
  `llm-deepseek` row (`runs/a12-sdk-boundary.txt`): the composition booted
  (`deepseek-harness-sdk-runtime` handshake), a real Session started
  (`turn/start`), a real tool catalog was assembled (`request/header`), and the
  turn ended `error` with `MISSING_CREDENTIAL: llm-deepseek: no API key for
  provider route "deepseek-official"`.
- **No clean-shutdown claim.** On win32 `child.kill('SIGTERM')` terminates the
  process instead of delivering a catchable signal, so the launcher's own
  `process.on('SIGTERM', …)` handler never ran and no exit code was observed
  (measured: `exit_code: null`, `exit_signal: SIGTERM`). A clean-shutdown claim
  would need a different driver and is not made.
- **No long-running soak.** The host was up for seconds, not hours.

**To close A12 fully**: configure a `DEEPSEEK_API_KEY` in the daily home, submit
one prompt through `session/prompt`, and assert a persisted `turn/end:
completed` with a real assistant message.

## Things this slice found that were not the gate

1. **`name:` in an inserted row is an ENTRY OPTION, not row config.** A `!!js`
   expression there is never interpolated. Measured failure:
   `cli-mock-llm ([object Object]): failed to import`. A path relative to the
   patch file is the form `anchorInsertedPluginNames` rewrites to a file URL —
   the same form the shipped keyless fixture uses. Recorded because the natural
   mistake is to reach for `!!js process.env.…` here.
2. **A launcher subprocess importing a relative TypeScript plugin needs that
   file to sit under a package that resolves `@deepseek-ai/*`.** A patch
   directory under the OS temp root — or under `qualification/results/` — has no
   such ancestor and the import fails with
   `Cannot find package '@deepseek-ai/dsh-llm'`. Both the test suite and
   `make-a10-runs.mjs` therefore read the adapter from
   `packages/dsh-daily-work/m914-mock-llm.ts`.
3. **`--help` does not report non-activating entries.** The app's help prints
   before the tree's activation audit, so `dsh --profile X --help` exits 0 with
   empty stderr even when a row is invalid. The A04 invalid-config case needed a
   real boot to observe it.
4. **The A08 row diff needed a parser that ignores trailing blank lines.** The
   last row of a dump is followed by the document's final newline while every
   other row is followed by a `# ==` separator; keeping that blank line made an
   identical row read as "changed". Caught by the test failing on
   `agent-presets`, which no documented difference touches.
5. **The Web host's process token is a live credential.** `run-a12.mjs` redacts
   it before writing the transcript, because the transcript is a repository
   artifact and a working token does not belong in version control. The evidence
   only needs to show that the URL line's shape was produced.

## Reproducing

```sh
# The tests (25 cases; spawns 4 real launcher subprocesses, serialized).
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run --pool=forks --maxWorkers=1 src/profile-config.test.ts

# Type checks.
tsc -p tsconfig.json --noEmit
tsc --ignoreConfig --noEmit --target ES2024 --lib ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess \
  --noImplicitOverride --verbatimModuleSyntax --erasableSyntaxOnly \
  --allowImportingTsExtensions --skipLibCheck --types node \
  --moduleDetection force src/profile-config.test.ts

# The recorded artifacts.
cd /d/DSH/src/dsh-src
node D:/DSH/work/dsh-native-daily/qualification/results/M9.14-profile-config/make-dumps.mjs
node D:/DSH/work/dsh-native-daily/qualification/results/M9.14-profile-config/make-a10-runs.mjs
node D:/DSH/work/dsh-native-daily/qualification/results/M9.14-profile-config/run-a12.mjs \
     D:/DSH/work/dsh-native-daily/qualification/results/M9.14-profile-config/runs/a12-web-host.txt
```

All scripts use `$DSH_HOME=D:\DSH\home\m914`, created by these scripts. Nothing
here reads or writes `D:\DSH\home\canary*`.

## Files

| Path | What it is |
|---|---|
| `tests.txt` | The vitest run, 25 passed, exit 0 |
| `tsc.txt` | Package and test-file type checks, both exit 0 |
| `source-digests.txt` | sha256 of every artifact and every pinned DSH file asserted |
| `runs/falsification.txt` | 5 mutations, each failing in the intended assertion |
| `runs/a12-web-host.txt` | The real Web host transcript (token redacted) |
| `runs/a12-sdk-boundary.txt` | The credential-boundary transcript |
| `runs/a10-*/` | Per-script CLI stream, stderr, exit code, and persisted Session |
| `dumps/` | Regenerated resolved graphs, `make-dumps.mjs` |
| `patches/` | Hand-runnable copies of the A04 patch and the A10 keyless overlay |
| `run-a12.mjs`, `make-dumps.mjs`, `make-a10-runs.mjs` | The drivers |

## Note for whoever commits this

`packages/dsh-daily-work/m914-mock-llm.ts` is the scripted A10 adapter, and it
sits at the package root on purpose: it is TypeScript importing
`@deepseek-ai/dsh-llm`, and Node resolves bare specifiers by walking up from the
FILE's directory. Both the vitest suite and `make-a10-runs.mjs` read it there.

An earlier revision of this slice kept a junction farm under this evidence
directory to make the same import resolve, and that farm was committed by a
concurrent `git add -A`. It has been removed and
`qualification/results/**/node_modules/` is now in `.gitignore`. Nothing in this
directory needs it any more: the test suite was verified to pass 25/25 with the
farm gone, and the standalone overlay was re-pointed at the package.

