# M9-eco — attempt accounting, cache economics and performance instrumentation (ECO-01..ECO-08)

**Date:** 2026-09-20
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0, Python 3.14.3, ipykernel 7.3.0
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`)

## Verdict summary

| gate | requirement | status | what is genuinely proven |
|---|---|---|---|
| **ECO-01** | attempt accounting | **PASS** (offline) | A step that retried twice issued **three real requests** through the production `agent/request-error` waterfall and the production `@deepseek-ai/dsh-llm-retry` executor. The three usages SUM (450/75/1200) and the projection's own fold reports that sum; the last usage alone (200/30/500) differs from it, so a "last usage wins" regression cannot pass. |
| **ECO-02** | missing usage | **PASS** (offline) | An attempt whose usage never arrived is `known: false` and is **never** priced as zero. The conservative reservation is **HELD** and the admission is **REFUSED** on it, with a control proving the refusal is caused by the unknown and not by the ceiling. Comparing an incomplete total is refused in **both** directions. |
| **ECO-03** | real total cost | **PASS** (offline) | One total over `root+child+retry+compaction+summary+search` with all six categories present, the five-term formula each its own number, and cache storage included (removing the row measurably lowers the total). Cross-provider pricing **throws**; a cache-write field under a protocol that has no such line **throws**. |
| **ECO-04** | prefix stability | **PASS** (offline) | Across two cells with different budget/kernel-epoch/variable values, the **rendered** fixed prefix is byte-identical (sha256), the section order is unchanged, and the dynamic parts sit strictly later in the registry's own order. A third cell that changes a variable feeding the prefix **moves** the digest — the positive control. |
| **ECO-05** | the token counterexample | **PASS** (offline) | Constructed and asserted: prompt tokens fall 20,000 → 12,000 (−40%) while the priced bill **RISES**. `reportCostDelta` reports both and sets `cheaper: false`. A control case where the bill really falls sets `cheaper: true`, so the flag is not stuck. |
| **ECO-06** | shadow has no side effects | **PASS** (offline) | With the shadow enabled, the request count read from inside the real `LlmAdapter.stream` and the effect count read from inside the real tool's `execute` are **unchanged** (2 and 1). `shadow.sideEffects().total === 0`, and `agent.session.seq` is unchanged. |
| **ECO-07** | strict C0 | **PASS (offline half) — live half BLOCKED_EXTERNAL** | The stock arm is verified unmodified: its patch file's active content is the literal `[]`, its bundles are exactly the two shipped ones, and the composed stock graph **re-derives to the digest M0.5 recorded** (`b64151b3…`). The daily-candidate patch still hashes to M0.5's `2a0aff17…`. The controlled variables are read from `compatibility.lock.json`. **The stock-vs-IPython live comparison is BLOCKED_EXTERNAL: `live_provider_budget_authorized: false`.** |
| **ECO-08** | repeated paired runs | **PASS (offline half) — live half BLOCKED_EXTERNAL** | The estimator and its honest behaviour at the sample sizes a paired run uses: Wilson intervals that do **not** collapse to certainty at n=6 (6/6 gives lower bound 0.610, not 1), sample variance undefined at n=1 rather than 0, and three axes reported separately with overlapping intervals so **no winner is declared**. **The live paired coding+research runs are BLOCKED_EXTERNAL: `live_provider_budget_authorized: false`.** |

**The headline honest statement:** six gates close offline on controlled inputs and
real local measurement. **ECO-07 and ECO-08 each have a live half that does not
close**, and they are recorded as `BLOCKED_EXTERNAL` rather than approximated with
a mock. The perf numbers below are real measurements of local processes, not of a
model.

Evidence in this directory:

| file | what it is |
| --- | --- |
| `tests.txt` | real `vitest run src/eco.test.ts` output, **36 passed / 0 failed**, exit 0 |
| `tsc.txt` | three typechecks, all exit 0: the isolated one over this case's two files, the production build config, and the whole-tree `tsconfig.check.json` |
| `sabotage.txt` | **seven** mutations, each shown to apply to a copy and to break the tests it claims to break, with a restored control |
| `sabotage.sh` | the runnable falsification harness |
| `perf_probe.py` | the real-measurement probe (real ipykernel, real subprocesses, real RSS/CPU) |
| `perf.json` | its raw output |
| `source-digests.txt` | sha256 of every file this case touches, including the upstream sources it cites |
| `FINDINGS.md` | this file |

Reproduce:

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
npx vitest run src/eco.test.ts --maxWorkers=1 --no-file-parallelism
tsc -p tsconfig.eco.json                       # isolated: this case's two files only
bash /d/DSH/work/dsh-native-daily/qualification/results/M9-eco/sabotage.sh sabotage.txt
```

---

## What is proven, and what is not

**Proven, with controlled inputs over the real machinery:**

- three attempts of one step are accounted separately, and the retries are durable
  `llm/retry` / `llm/retry-started` edges in the real Session log, not an in-memory
  counter;
- a missing usage stays unknown, is never priced as zero, keeps a conservative
  reservation, and the admission is refused **because of it**;
- the total covers every category the plan names, applies no vendor's field set to
  another vendor, and refuses rather than omits when a provider is unpriced;
- the fixed prefix is byte-stable across cells while the dynamic parts stay later
  and bounded;
- fewer tokens can be a **more expensive** bill, and the report says so;
- a shadow observes and spends nothing, with the counts read from the live adapter
  and the live tool;
- the stock control arm is unmodified and its composed graph still matches M0.5's
  digest;
- the statistics a paired report must use do not over-claim at small n.

**NOT proven, and not claimed:**

- **that a real provider bills what any reservation predicted.** No provider is
  authorized, so no invoice was observed. Every currency figure in this case is a
  controlled input under a table whose *field set* is grounded in the pinned
  source and whose *rates* are invented.
- **that a cache hit occurs.** A byte-identical prefix is a *precondition* for a
  hit, not a hit. DeepSeek's caching is documented as best-effort, and eviction
  between two identical requests is allowed. Nothing here observes a hit.
- **that the C2 arm is faster, cheaper or better than stock.** ECO-07/ECO-08's live
  halves are BLOCKED_EXTERNAL. The offline halves close the *rig* and the
  *estimator*, not the comparison.
- **that the price ordering used here is current.** `cacheRead < freshInput` is the
  premise that makes ECO-05's counterexample possible and is asserted as an
  ordering, not as a vendor fact.

---

## ECO-01 — one step, two retries, three attempts

The stimulus is "the same step retries twice and produces usage". The retry
mechanism is the production one: the adapter throws a real `LlmError('…','RATE_LIMIT',
{status:429})` after emitting its usage chunk, the error travels the production
`agent/request-error` waterfall, `@deepseek-ai/dsh-llm-retry` decides and appends
`llm/retry` + `llm/retry-started` to the durable log, and the loop calls back in.

Measured: `adapter.requests.length === 3`, `adapter.failures === 2`, two `llm/retry`
edges and two `llm/retry-started` edges. The provider's own `tokenUsage` projection
reports `{uncachedInputTokens: 450, outputTokens: 75, cacheReadTokens: 1200}` — the
sum of all three attempts, produced by DSH's shipped fold, read rather than
re-implemented.

### A measurement that changed the fixture, and why it matters

The first version of the adapter threw **before** yielding any usage. The
projection then reported only the final attempt (200/30/500), and the test failed.
That is not a bug in DSH: a failed attempt that reports nothing genuinely is
unknown, and treating it as zero is the ECO-02 failure. Both orderings are real
provider behaviours, but only "usage then failure" lets the test distinguish
*summing* from *overwriting*, so the fixture emits usage before the throw. The
finding is recorded because a reader seeing the fixture would otherwise not know
the ordering was chosen by measurement.

## ECO-02 — the conservative reservation is held, and admission refuses on it

Three separate properties, each with its own assertion:

1. **Unknown is not zero.** `priceAttempt` returns `known: false` with every line
   zero *because nothing was priced*, and a note saying so. `totalCost` counts the
   attempt as an unknown attempt and reports `complete: false`. The summed figure is
   a **lower bound** and the code says so.
2. **The reservation is HELD.** With ceiling 100 / reserve 20 → child ceiling 80: an
   auxiliary unknown of 50 raises `childCommitted` to 50, and a child asking for 31
   would commit 81 > 80 and is refused — while `childCommitted(base) + 31 = 31 ≤ 80`
   shows the refusal is caused by the unknown and not by the ceiling. Separately,
   `retainAsUnknown` **moves** an amount from `reserved` to `unknownReserved`
   (commitment total unchanged) and clamps to the task's own reservation, so one
   task's unknown cannot eat a sibling's.
3. **No silent pass.** Comparing an incomplete total is refused in **both**
   directions: a lower bound cannot establish that anything got cheaper *or* more
   expensive. Refusing only one direction would let the other claim be made on the
   same evidence.

### Structural hardening (requested after a false alarm)

The unknown-usage path is now its **own function** (`priceUnknownAttempt`) and the
priced path (`priceKnownAttempt`) takes a **non-optional** `usage: UsageBuckets`.
The rule "an absent usage is unknown, not zero" is therefore enforced by the type
signature rather than by remembering to keep an early `return` in the right branch,
and there is no place left for `usage!` to be tempting. A test asserts the source
properties directly (with comments stripped first, because the file's own prose
discusses the assertion it refuses to use): no `usage!`, no cast, no `?? ` on the
usage path, and the guard genuinely dominates the priced call.

## ECO-03 — one total, no omission, no cross-provider formula

The total is `fresh + cached + output + cache-write + cache-storage`, each term its
own number, summed and checked against `knownTotal` by hand. All six `USAGE_SOURCES`
appear as lines even when empty, so a dropped category shows up as a zero line
rather than as an absent entry — and the source list is read from the ledger's own
declaration, not re-sorted, so an omission cannot hide behind a reordering.

The no-omission claim has a **positive control**: removing the provider-B row lowers
the total and zeroes the cache-write and storage lines, proving those lines were
genuinely contributing.

**The field-set contract, grounded in the pinned source rather than assumed:**

- `@deepseek-ai/dsh-llm-deepseek`'s chat-completions translator builds `TokenUsage`
  from `prompt_tokens`/`completion_tokens`/`prompt_cache_hit_tokens` and **never**
  emits `cacheWriteTokens`
  (`packages/llm/llm-deepseek/src/protocols/chat-completions/translate.ts:64-71`).
  So for that protocol `cacheWritePerMillion` must be **absent** — a cache-write
  charge is not zero there, it does not exist.
- the messages protocol translates **both** `cache_read_input_tokens` and
  `cache_creation_input_tokens`
  (`packages/llm/llm-deepseek/src/protocols/messages/translate.ts:36`), and pi-ai
  forwards `usage.cacheRead`/`usage.cacheWrite`
  (`packages/llm/llm-pi-ai/src/stream.ts:29-30`). Those routes have both fields.

Two refusals make the mixing impossible rather than merely discouraged:

- an attempt naming provider B priced with provider A's table **throws**, naming
  both providers. No arithmetic afterwards could detect this;
- an attempt reporting cache-write tokens under a table whose protocol has no such
  line **throws**. The *same row* under the provider that does have the line prices
  fine, which shows the refusal is about the protocol and not about the row.

`PriceBook.require` has **no fallback**: an unregistered provider throws, and
`totalCost` refuses the whole total rather than pricing the rows it can. A total
that quietly omitted one provider would understate the bill by that provider's
entire contribution.

### The three-valued line status, which is not two-valued

- `inapplicable` — the provider's protocol has no such charge. Not a zero charge: no
  charge.
- `unpriced` — the provider **does** bill it, but an input was missing (a storage
  duration). The line is not zeroed and the total is reported incomplete.
- priced — computed.

Collapsing the first two would either claim incompleteness everywhere or hide it
where it matters.

## ECO-04 — prefix stability, and the non-claim about cache hits

Two cells with the same tools/SDK, a different budget (900 vs 17), a different
kernel epoch (1 vs 2) and the same task variable. The fixed sections are read **from
the assembly** and the digest is taken over the **rendered** prefix — the bytes the
model receives, with variables interpolated.

Two deliberate choices, each of which a weaker version of this test would get wrong:

- **not the raw section text.** A section containing `{{variable}}` is stable raw
  while the bytes sent are not, so a raw-text digest would pass on a prefix that
  actually changed. The positive control pins this: changing the variable that feeds
  the fixed section **does not change** `fixedTexts` but **does change**
  `fixedRendered`, and the test asserts both.
- **not a positional split of the rendered prompt.** `renderPrompt` drops empty
  sections and `deployment:persona-prefix` renders empty by default, so a positional
  split misaligns — this was a real failure in the first version of this test.

The dynamic parts are asserted **later** (every fixed order < every dynamic order,
against the registry's own numbers) and **bounded** (the dynamic byte size does not
grow with the number of variables).

**The non-claim, asserted rather than only commented:** a byte-identical prefix is a
precondition for a provider cache hit, **not a hit**. DeepSeek's caching is
documented as best-effort; eviction between two identical requests is allowed. No
cache hit is claimed or measured without a provider that reports `cacheReadTokens`.
`perf.json`'s `not_measured.provider_cache_hit_rate` carries the same sentence, so
the two places a reader could over-read agree.

## ECO-05 — fewer tokens, a bigger bill

| | before | after |
|---|---|---|
| prompt tokens | 20,000 | **12,000** (−40%) |
| of which fresh input | 1,000 | **10,000** |
| of which cache read | 19,000 | 2,000 |
| **priced bill (USD)** | 0.000854 | **0.002898** (+239%) |

The token count falls and the bill rises, because the projection that shrank the
context also broke the prefix, converting cheap cached tokens into expensive fresh
ones. `reportCostDelta` reports both numbers, its `statement` names both in one
sentence, and `cheaper` is **false**. A control case where the bill really falls
sets `cheaper: true`, so the flag is not stuck at false.

### A real bug this case found in its own module

`reportCostDelta`'s first version computed the token delta from
`byLine.freshInput + byLine.cachedInput` — which are **money** — and reported a
"token" delta of 0.002. The token series is now a separate `byTokens` field, and an
assertion pins the distinction (`moneyFromLines < 1` while `moneyFromTokens >
10_000`) so the regression cannot return unnoticed. This is why the module states
that `byLine` is money and `byTokens` is tokens and never derives one from the
other.

## ECO-06 — the shadow observes and spends nothing

The shadow is constructed from a **pure** function of already-materialized bytes and
a pure digest. It holds no `Context`, no `LlmRuntime` and no `ToolRuntime`, so it
has no reachable path to a request or an effect.

The counts are read from the live objects, not from the shadow's bookkeeping:

- `adapterCalls` is incremented **inside** the real `LlmAdapter.stream` that the real
  AgentLoop calls;
- `toolRuns` is incremented **inside** the real tool's `execute`, registered on the
  real `ctx.tools`.

Asserted: both unchanged after the shadow observes (2 requests, 1 effect);
`shadow.sideEffects().total === 0`; `agent.session.seq` unchanged, so a shadow that
appended an event would fail; and the observation really happened
(`differs === true`, digests differ, and the live projection is byte-identical
afterwards, so the shadow did not mutate what it observed).

A structural test also pins the public surface (`observe`, `observations`,
`sideEffects`), so a future refactor that added a method taking a session, context
or prompt would change that list and fail.

## ECO-07 — the stock control arm is unmodified (live half BLOCKED_EXTERNAL)

Three checks, all offline:

1. the stock patch file's **active content** (comments stripped) is the literal
   `[]`, and the stock profile's bundles are exactly
   `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`. A `dsh-daily-work` entry
   here would make C0 a modified control;
2. the **composed stock graph is re-derived now** from the pinned checkout
   (`--profile web --dump-default-config`) and its sha256 matches M0.5's recorded
   `b64151b3…`. The dump is also asserted to name both shipped bundles, so the
   digest is a digest of the stock graph and not of an error page that hashed
   consistently;
3. the daily-candidate patch still hashes to M0.5's `2a0aff17…`, so the C2 side of
   the comparison is the one the plan names.

The controlled variables are read from `compatibility.lock.json` rather than
restated: commit `ddefc45fbc…`, tag `dsh-v0.1.6-alpha.2`, the request-accounting
policy, the authority policy, and the literal
`model_and_provider_capabilities_digest: no-live-provider-authorized`.

**BLOCKED_EXTERNAL — the live comparison.** Running stock against the IPython/data
plane with a real model needs an authorized provider budget. `compatibility.lock.json`
records `live_provider_budget_authorized: false`, so the live half is not attempted,
not approximated with a scripted adapter, and not reported. What is closed is the
part whose being wrong would silently invalidate the live half.

## ECO-08 — variance and intervals, not one pretty trajectory (live half BLOCKED_EXTERNAL)

The estimator's honest behaviour at the sizes a paired run actually uses:

- **Wilson, not the normal approximation.** 6/6 gives `[0.610, 1]`, so six successes
  do **not** establish certainty; 0/6 gives `[0, 0.390]`, so six failures do not
  establish a 0% rate. The interval narrows as n grows (8/10 is wider than 80/100),
  so it is an interval and not a constant. n=0 is flagged `degenerate` rather than
  reported as a point estimate.
- **Variance undefined at n=1**, not 0 — a 0 would read as a perfectly stable
  result.
- **Three axes separately**, each with its own n. The fixture's arms are 5/6, 6/6,
  6/6 with intervals `[0.436, 0.970]`, `[0.610, 1]`, `[0.610, 1]`. They **overlap**,
  and the test asserts the overlap explicitly: the highest lower bound is below the
  lowest upper bound, so the ranking is inside the noise and **no winner is
  declared**.

**BLOCKED_EXTERNAL — the live paired runs.** Representative coding and research
tasks run repeatedly against a real model need an authorized provider budget
(`live_provider_budget_authorized: false`). The per-arm numbers above are controlled
inputs standing in for a live paired run; they are not a benchmark and are not
presented as one. What is closed is that the reporting apparatus cannot declare a
winner it cannot support.

---

## Real performance measurements

All figures are real measurements of local processes on this host, from
`perf_probe.py` → `perf.json`, **measured at 2026-09-20T02:23:11+0800 on Python
3.14.3** (the probe stamps its own run time and interpreter, so the artifact is
self-describing rather than dated only by an mtime a copy would not preserve).
**None is a model or provider latency.** Percentiles are nearest-rank over the
observed samples, so every reported value is an observation and never an
interpolation.

**`perf.json` is FROZEN, and the tables below match it exactly.** The test runs the
probe only when the file is absent or when `ECO_PERF_REFRESH=1` is set. Without that
freeze the file would be rewritten by every `vitest` invocation and the numbers below
would stop matching it the next time anyone ran the suite — which reads exactly like
a defect. The consequence, stated rather than hidden: on an ordinary run the perf
tests verify the **recorded** measurement's internal consistency and plausibility,
not a fresh one. `ECO_PERF_REFRESH=1 npx vitest run src/eco.test.ts` takes a new
measurement.

**These numbers move between runs.** Across the runs performed while writing this,
kernel cold-start p50 ranged 906–1392 ms, warm cell RTT 5.1–5.7 ms p50, and helper
RTT 27.5–33.3 ms p50 (Python) / 65.8–100.6 ms p50 (Node). A single number quoted from
one run is a point estimate, not a constant, and the cold-start spread below
(1139 min ↔ 1886 max) is that variance rather than a tail.

| metric | n | min | p50 | p95 | max | note |
|---|---|---|---|---|---|---|
| kernel cold start (ms) | 5 | 1139.1 | **1335.9** | 1885.8 | 1885.8 | KernelManager construction → `wait_for_ready`, CurveZMQ required. **p95 IS the max at n=5** (`p95IsMax: true`); it is a five-sample figure and is labelled as such. |
| warm cell RTT (ms) | 100 | 4.7 | **5.5** | 7.2 | 9.6 | `execute_request` → matching shell reply for a trivial assignment, measured from outside the kernel, so it includes the client's own ZMQ+JSON work. |
| process helper RTT — `python -c pass` (ms) | 7 | 27.1 | **32.6** | 44.3 | 44.3 | A cold process start per call. |
| process helper RTT — `node -e 0` (ms) | 7 | 65.9 | **91.6** | 100.9 | 100.9 | Node's start is ~2.8× Python's here. |
| refill readiness, kernel side (ms) | 20 | 4.8 | **5.7** | 6.3 | 6.8 | How long a **warm** kernel takes to accept the next cell. This is only the kernel-side half of a scheduler refill; the scheduler's own refill latency is measured against the real host service in `scheduling.test.ts`. |

Local Python in-process rates (no kernel, no ZMQ):

| loop | ops/sec |
|---|---|
| interpreted `for` loop with arithmetic | **13,246,516** |
| generator expression | 25,367,962 |
| builtin `sum` over a list | **33,500,838** |

The 2.5× spread is the point: **"local Python ops/sec" has no single value** without
naming the loop.

RSS and CPU, five real kernels sampled after 20 warm cells each (from `psutil`):

| boot | RSS | CPU (cumulative, ms; table rounds to whole ms) |
|---|---|---|
| 1 | 76.0 MB | 1203 ms |
| 2 | 76.2 MB | 1297 ms |
| 3 | 76.2 MB | 906 ms |
| 4 | 76.0 MB | 1047 ms |
| 5 | 76.1 MB | 953 ms |

RSS is **flat across boots** (growth +0.1 MB from first to last, peak 76.2 MB) —
reported as a growth figure rather than smoothed away, so a leak would be visible as
a rising series. The exact values in `perf.json` are 1203.1 / 1296.9 / 906.2 /
1046.9 / 953.1 ms; the table rounds them, which is the only difference a reader
diffing the two will find. CPU is cumulative per kernel and is *not* comparable
across rows: each kernel ran a different amount of work and the figure includes its
boot.

Child boot-storm, concurrent kernel starts, with a one-kernel control:

| requested | started | errors | wall | per-kernel | total RSS |
|---|---|---|---|---|---|
| 1 (control) | 1 | 0 | 1331.6 ms | 1331.6 ms | 75.8 MB |
| 5 | 5 | 0 | 1462.1 ms | **292.4 ms** | **379.1 MB** |

Two facts, both stated so neither is over-read: five concurrent boots cost **less
than five serial boots** (1462 ms vs ~6658 ms, so ~4.6× faster), so concurrency is
real; and five kernels hold **5.0× one kernel's RSS**, so the RSS budget is a real
constraint at the plan's N — roughly 379 MB for 5 kernels extrapolates to about
**2.2 GB for 30**.

### What could NOT be measured, stated as `null` with a reason

`perf.json`'s `not_measured` block carries each of these as `value: null` plus a
reason. **A zero would have read as "measured as instant" or "measured as free", so
zero is not used.**

| metric | why not measured |
|---|---|
| `model_blocked_time_ms` | needs a live provider; `live_provider_budget_authorized=false`. What *is* measured locally is the loop's time inside the adapter call (asserted `≥ 4 ms` against a known 5 ms in-process delay), which is the harness's own path and **not** a provider's first-token latency. |
| `provider_cache_hit_rate` | needs a provider that reports `cacheReadTokens` on a real request. A byte-identical prefix is a precondition, not a hit; DeepSeek's caching is best-effort. |
| `history_query_latency_ms` | measured in the TypeScript suite instead, against the real `SessionQueryEngine` over a real `JsonlSessionPersistence` store (200 steps, 10 rounds, both `readSession` and `listSessions` timed). Not in the Python probe because it is a JS-service measurement. |
| `captured_vs_projected_bytes` | measured in the TypeScript suite against the real `boundJsonLine`: a 32 MiB payload (33,554,464 bytes captured) is bounded to **8,241 bytes** (≤ `MAX_EVENT_BYTES` 32,768) with `truncated: true` recorded in the payload, so a bounded projection is distinguishable from a short one. |

Also measured in the suite against real services: **history query latency** over a
real 401-event JSONL store (10 rounds each of `readSession` and `listSessions`, both
with p50 > 0 and max < 30 s — a stub would return in microseconds and a broken path
would throw), and **scheduler refill latency** via a real `SpanMeter` that pairs
open/close spans and **counts** the ones that did not pair (an unmatched close is
counted, not invented).

---

## Falsification: the tests can fail

`tsc` passing and `vitest` passing prove the tests RUN, not that they TEST anything.
Seven mutations were applied — each to a **copy** of the package — and the suite was
run there. Raw output, including the failing test names, in `sabotage.txt`.

| mutation | tests broken |
|---|---|
| **S1** the unknown-usage guard removed (an unknown is priced as measured) | 2 of 36 — both ECO-02 |
| **S2** the cross-provider guard removed, and a foreign cache-write field accepted | 1 of 36 — ECO-03 |
| **S3** the token delta read from the money lines again, and the shadow spends | 2 of 36 — ECO-05 and ECO-06 |
| **S4** the cache-storage line dropped from the total, and an unknown marked known | 3 of 36 — ECO-02 (×2) and ECO-03 |
| **S5** completeness ignores unknown attempts, and the price book falls back | 3 of 36 — ECO-02 (×2) and ECO-03 |
| **S6** percentiles interpolate, and `p95IsMax` hardcoded false | 3 of 36 — perf instrumentation (×2) and the kernel-cold-start case |
| **S7** the conservative reservation released instead of held | 1 of 36 — ECO-02's admission-refusal case |
| **control — restored copy** | **36 of 36 pass** |

### The harness itself was wrong first, and that is recorded

The first version mutated the **live** `src/perf-metrics.ts` and restored it
afterwards. The shared `tsconfig.check.json` is a resource other gates read, and the
coordinating agent sampled the tree **inside a mutation window**, correctly seeing
the five `possibly undefined` errors a removed narrowing produces. The errors were
real; the state lasted seconds. The harness now works on a copy under
`packages/.eco-sabotage-copy` (a sibling, because the package's `node_modules` is a
tree of Windows junctions that cannot be `cp`'d across volumes), removes it in a
`trap`, and restores the copy's sources **by reading the live file** — so the copy
cannot drift and the live tree is never mutated. `source-digests.txt` records the
live digests so this is checkable.

The second version reported **`36 passed` for all seven mutations** — a
false-green, because the mutation scripts ran with the wrong working directory and
every patch was a silent no-op. That is precisely the failure this file exists to
catch, so the harness now prints an `APPLIED to <path>` line per mutation (naming
the **copy's** path, which also proves the write did not land on the live tree) and
`run_suite` reports the **names** of the failing tests, not only the count. A
mutation that does not apply is now visible as an absent `APPLIED` line next to a
clean run.

---

## Files

**Created by this case (nothing else was touched):**

- `packages/dsh-daily-work/src/perf-metrics.ts` — provider-normalized pricing with
  the three-valued line status, the cost/token series kept apart, latency/percentile
  meters, the byte ledger, the shadow projection, and the paired-run statistics.
  It is **not** a second ledger: attempt rows come from `UsageLedger` in
  `record.ts`, which already owns the six sources and the unknown counts.
- `packages/dsh-daily-work/src/eco.test.ts` — 36 tests.
- `packages/dsh-daily-work/tsconfig.eco.json` — an isolated typecheck over this
  case's two files. It exists because the shared `tsconfig.check.json` type-checks
  the whole tree, and other cases edit other files concurrently, so its exit code
  is not a statement about this case. It `extends` `tsconfig.json`, so the strict
  flags cannot drift.
- `qualification/results/M9-eco/{FINDINGS.md,tests.txt,tsc.txt,source-digests.txt,sabotage.txt,sabotage.sh,perf.json,perf_probe.py}`

**Modified by this case: NONE.** `src/record.ts` is **read** for
`holdUnknown`/`retainAsUnknown`/`UsageLedger`/`USAGE_SOURCES` and was never edited;
it is hashed in `source-digests.txt` because the sabotage harness mutates a copy of
it, so the digest is what proves the live file is intact. `src/host.ts`,
`src/counting.ts`, `src/homelock.ts`, `src/effects.ts` and everything in
`packages/dsh-ipython/` were not touched.

## Open items and honest limits

1. **ECO-07 and ECO-08 live halves are BLOCKED_EXTERNAL**
   (`live_provider_budget_authorized: false`). No stock-vs-IPython comparison and no
   live paired coding/research run has been performed. Neither is approximated with
   a mock.
2. **Every currency figure is a controlled input.** The price *field sets* are
   grounded in the pinned source; the *rates* are invented and no invoice was
   observed. `priceVersion: 'eco-test-v1'` is carried into every priced attempt so a
   total can be read against the table that produced it.
3. **No cache hit is observed.** ECO-04 proves prefix stability, which is a
   precondition. A real hit rate needs a provider that reports `cacheReadTokens`.
4. **The 30-child RSS extrapolation is an extrapolation.** Measured: ~76 MB per
   kernel, ~379 MB for 5 concurrent (4.99× one kernel). The ~2.2 GB figure for 30 is
   arithmetic on the measured per-kernel figure, not a measurement of 30 kernels,
   and RES-05 is the gate that must actually measure it.
5. **`p95` at n=5 is the maximum.** The `p95IsMax` flag exists so this cannot be
   quoted as a real tail; the cold-start p95 above is labelled accordingly.
6. **The perf figures are single-run and vary.** The probe re-runs and overwrites
   `perf.json` on every `vitest` invocation, so the tables above are one run. Ranges
   across the runs performed are stated at the head of that section. No confidence
   interval is claimed for them: with n=5 cold starts a variance estimate would
   itself be unreliable, which is why the raw samples are in `perf.json` for a
   reader who wants to compute one.
6. **`model_blocked_time_ms` is local only.** The measured figure is the loop's time
   inside a scripted adapter call. It is not, and must not be read as, a provider's
   first-token latency.
7. **The perf probe needs a local Python with `jupyter_client`, `ipykernel` and
   `psutil`.** Where `psutil` is missing the probe reports an `error` string per
   sample rather than a zero, and the RSS test fails rather than passing on zeros.
