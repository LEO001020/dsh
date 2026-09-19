# M9.4 — durability advanced: gates D02, D12, D14

Result: **all three gates CLOSED by measurement.** Nothing here is inferred from
a simulation; every claim below was produced by running a real second process, a
real corrupt file, or a real OS process on this machine.

| Gate | Name | Status |
|---|---|---|
| D02 | 多host冲突 / multi-host conflict | **CLOSED** — and the honest measurement is the alarming part |
| D12 | schema迁移 / schema migration | **CLOSED** |
| D14 | 后台残留 / residual OS processes | **CLOSED** — with one measured platform fact |

Evidence files in this directory:

| File | What it is |
|---|---|
| `tests.txt` | `vitest run src/durability-advanced.test.ts --maxWorkers=1 --no-file-parallelism` — 10 passed, exit 0 |
| `tsc.txt` | Both typechecks: the package build, and the test file separately |
| `source-digests.txt` | sha256 of the files this slice created/changed and of the sources the findings are read from |

---

## D02 — multi-host conflict: a second host is NOT blocked, and it loses data

### The oracle, and what it actually says

The gate's oracle is 拒绝/隔离到其他home，不把进程内KV缓存当跨进程一致数据库 —
*refuse, or isolate to another home; do not treat the in-process KV cache as a
cross-process consistent database.*

There is no upstream mechanism to lean on, and this is documented rather than
accidental (`packages/storage/storage-json/README.md`):

> **No cross-process write locking** — two processes writing the same unit can
> interleave replacements; writes to the same file use last-completion wins.

### THE MEASUREMENT: two real hosts, one live store, silent data loss

The test spawns two real Node processes. Host A opens the store, creates
`run-from-A`, and stays live. Host B — a genuinely separate OS process — then
opens the SAME directory and creates `run-from-B`.

Reproduced independently of the test harness (child pids and reports quoted from
the actual run):

```
A ready:  {"phase":"ready","hostPid":35184,"runs":["run-from-A"]}
B exit:   {"code":0,"signal":null}
B report: {"phase":"wrote","hostPid":35416,"opened":true,
           "runsOnOpen":["run-from-A"],
           "runsAfterOwnWrite":["run-from-A","run-from-B"]}
ON DISK after B closed: ["run-from-A","run-from-B"]
A exit:   {"code":0,"signal":null}
A report: {"phase":"wrote-second","hostPid":35184,
           "runs":["run-from-A","run-from-A-2"]}
ON DISK final:          ["run-from-A","run-from-A-2"]
```

Read what those four lines say, because each is a separate finding:

1. **`"opened": true`** — nothing refuses the second host. The domain layer's
   `already-open` rule and the JSON backend's *"a unit has exactly one live
   handle"* rule are both **per-process**. A second OS process is not a second
   handle as far as either can see, so both rules pass.
2. **`"runsAfterOwnWrite": ["run-from-A","run-from-B"]`** — B's write is real and
   durable *at that moment*. This is not a lost in-memory update. B read its own
   run back from its own domain and then closed cleanly.
3. **`ON DISK after B closed: [... "run-from-B"]`** — the bytes really are on the
   medium.
4. **`ON DISK final: ["run-from-A","run-from-A-2"]`** — A's next write, from an
   in-memory snapshot that predates B, republishes the WHOLE unit (`single`
   layout) and **erases B's run.** `run-from-B` is gone. No error is raised
   anywhere, in either process, at any point.

So the answer to "do they interleave?" is **yes, and worse than interleaving**:
the loser does not get a conflict, it gets a clean success followed by silent
destruction of committed work. `last-completion wins` is exactly what the
README says, and it is worth stating plainly that "last-completion wins" here
means "the second writer's committed data is deleted by the first writer's next
write".

### What was added, and its exact limit

A deployment-boundary guard was added to `packages/dsh-daily-work/src/host.ts`
(one optional config field plus the acquire/release path). It is deliberately
**not** a distributed lease and it does not make the domain a cross-process CAS:

- `homeLockPath` names an ownership file. The service **cannot derive** this
  path: the store root belongs to the storage-json backend's private config, and
  reaching into that backend for its `root` would be the private-ABI dependency
  this project forbids. So the operator names it, and its absence is reported
  rather than hidden.
- The file carries `{pid, hostname, startedAt, token}`, so a refusal can **name
  the live holder** instead of just saying no.
- The claim is published with `link()` from a fully-written staging file, so a
  host killed mid-claim cannot leave a lock with no pid to test. `open(...,'wx')`
  would create the file EMPTY and fill it afterwards — a crash in that window
  would leave a lock that reads as stale and would hand the store to a second
  host. This mirrors the no-clobber `link()+unlink()` protocol the session-log
  backend already uses.
- Reclaim of a stale lock uses `rename()`, not `rm`: two simultaneous reclaimers
  both see the file, but only the first `rename` can succeed (the loser gets
  `ENOENT`). An `rm`+claim pair has no such discriminator and would let both
  believe they had won.
- An **unreadable** lock refuses. A lock that cannot be read is not evidence
  that its owner is dead.
- A holder whose pid was recycled, or whose record comes from **another
  machine**, is never reclaimed. A pid from another host cannot be tested at
  all — pid 4242 there is not pid 4242 here — and probing it would test an
  unrelated local process. Refusing costs availability in a rare crash-and-reclaim
  case; guessing would cost correctness, which is the one direction this guard
  must never get wrong.

Verified with the guard enabled, again with a real second process:

```
A ready:  {"phase":"ready","hostPid":33260,"runs":["run-from-A"]}
lock file: { "pid": 33260, "hostname": "DESKTOP-3L9C649",
             "startedAt": "2026-09-19T11:17:59.387Z",
             "token": "acc0ab7d-18f8-4b86-8735-eddfcfa148de" }
B exit:   {"code":0,"signal":null}
B report: {"phase":"refused","opened":false,
           "failure":{"name":"Error","message":
             "dailyWork: refusing to open the work domain — the store is already
              owned by pid 33260 on DESKTOP-3L9C649 (since ...), recorded in
              ...\\owner.lock. DSH storage has no cross-process write locking,
              so two hosts over one store silently lose the loser's writes.
              Stop the other host, or delete that file once you have confirmed
              it is stale."}}
ON DISK after B refused: ["run-from-A"]
A exit:   {"code":0,"signal":null}
ON DISK final:           ["run-from-A","run-from-A-2"]
lock after A close exists: false
```

B is refused **before it touches the domain**, the store is untouched, and A
keeps working. The claim is released on clean close, so the next generation is
not locked out.

### What D02 does NOT claim

Stated explicitly, because each of these is a real remaining hole:

- **The guard is OFF by default.** No guard is installed when `homeLockPath` is
  absent, and the shipped C2 profile (`profiles/daily-candidate/cordis.patch.yml`)
  does not set it. As configured today, **the deployment boundary is the only
  protection**, exactly as the plan anticipated. Enabling it is a one-line
  addition to the profile's `daily-work-host` row, deliberately NOT made here
  because this slice was scoped to `host.ts` and the test file.
- The guard protects **this service**. A caller that writes the store root
  directly, bypassing `WorkService`, is not stopped.
- It is a same-machine exclusion file, not a lease with an expiry, and it does
  not make the domain safe for concurrent multi-process writers.

---

## D12 — schema migration: a foreign version refuses to start

The rule from the plan: *a schema that cannot be migrated safely refuses to
start rather than silently reading a backup.*

Four shapes were written **directly into the storage directory** (not through the
service) and then opened:

| What was written | Result | Code |
|---|---|---|
| `record.version = 2` + an unknown extra field | **rejected** | `DomainError` / `invalid-record` |
| `budget.spent = "not-a-number"` (malformed) | **rejected** | `DomainError` / `invalid-record` |
| `unit.version = 2` (whole-unit header) | **rejected** | `StorageError` / `version-mismatch` |
| the file is not JSON | **rejected** | `StorageError` / `malformed-medium` |

The record-level rejection carries its location, which is what makes the failure
actionable rather than merely loud:

```
DomainError  code=invalid-record
  detail={"table":"runs","key":"run-1"}
  message=domain 'dsh_daily_work': stored record 'run-1' in table 'runs' does not match its schema
  cause=ZodError
```

Two distinctions worth recording, because collapsing them would be wrong:

- The **record** version is checked by the domain's zod schema (`version:
  z.literal(1)`), so it fails as `invalid-record` during `open`. The **unit
  header** version is checked earlier by the backend's file parser, so it fails
  as `version-mismatch` before any record is validated. Different layers,
  different codes, both loud.
- This domain deliberately does **not** use `invalidRecords: 'backup-and-skip'`.
  That policy exists for disposable derived data; run records are authoritative,
  so a bad one must stop the host rather than be moved aside and the host started
  anyway with the run missing.

**Not silently reading a backup, proven rather than asserted:** the test takes a
sha256 of the unit file before the refused open and asserts it is **unchanged
afterwards**. A rejected open must not have rewritten, migrated or truncated the
file it refused. It does not.

The control case is included: after restoring `version: 1`, the same directory
opens normally and the run reads back — so the rejections above are about the
record's shape, not a directory left unusable by the failed opens.

---

## D14 — residual OS processes: they DO survive, and recovery does not guess

### The measured platform fact

A real host process starts a real long-lived OS child, the host is killed with
`SIGKILL`, and the child is then probed with `process.kill(pid, 0)`:

| How the child was spawned | After a hard kill of the parent | Measured |
|---|---|---|
| `detached: true` + `unref()` | **SURVIVES** | 3/3 runs |
| plain (`stdio: 'ignore'`, not detached) | does not survive | 3/3 runs |

So on Windows the answer depends on how the process was started, and a
`detached` child **outlives its host**. The plan's rule — *not based on PID
absence or Session status to guess cleanup succeeded* — is therefore not
theoretical here: after a host kill, a real process may still be running and the
host has no record that it ever existed.

### What the test asserts

The test kills the host hard (`expect(exit.signal).not.toBeNull()`), confirms
with a probe that the host pid is gone, and then measures whether the detached
grandchild is still alive. It then asserts the gate's actual oracle — what
recovery is allowed to conclude:

- the stored task is still in `launching` (nothing wrote a terminal state on the
  way down, so recovery starts from a truthful last-known position);
- the reservation is intact at 5 credits;
- given the only evidence a restarted host has — no Session, no live Agent —
  reconciliation returns **`unknown`** with **`releaseSlot: false`** and a reason
  stating the task is *quarantined rather than relaunched*;
- the record is **not** in `confirmed`, `cancelled` or `settling`.

That is the gate: an absent Session is **not** read as proof the process is gone,
and a surviving process can never be mistaken for a clean finish.

### Cleanup is observed, not assumed

The test kills the grandchild and then **probes until it is confirmed gone**
before being allowed to pass. It does not claim cleanup on the strength of a
signal it sent. `afterEach` kills every spawned child and every tracked pid, and
removes every temp directory with `maxRetries` (on Windows a directory holding a
just-killed process's open handle cannot be removed immediately).

### A trap found while building this, worth recording

`process.kill(0, 0)` **succeeds** — signal 0 targets the caller's whole process
group. So a missing, unparsed or zero pid reads as "alive", and a lost process
would turn into a passing assertion. This was observed for real: an early probe
of this test reported `SURVIVED` for every run because the pid files had not been
written yet and `Number('')` is `0`. The probe now refuses `pid <= 0` outright,
and there is a test for it.

---

## Files touched

| File | Change |
|---|---|
| `packages/dsh-daily-work/src/durability-advanced.test.ts` | **created** — 10 tests covering D02, D12, D14 |
| `packages/dsh-daily-work/src/host.ts` | **modified** — optional `homeLockPath` guard: the deployment-boundary claim, its release, and the pid/identity helpers |

No other file was touched. No oracle was weakened, no test skipped, and no
threshold lowered.

## Verification

```
vitest run src/durability-advanced.test.ts --maxWorkers=1 --no-file-parallelism
  -> 10 passed (1 file), exit 0. Stable across 3 consecutive runs.

tsc -p tsconfig.json --noEmit                -> exit 0
tsc -p <test-file config>                    -> exit 0
  (tsconfig.json excludes src/**/*.test.ts, so the suite is typechecked
   separately with the same options plus a vitest path mapping)
```

The 12 pre-existing suites plus this file run **158/158 green**. Four other test
files in the package were failing at the time of writing (`isolation`,
`profile-config`, `__probe*`) from other agents' in-flight work; none of them
reference `homeLockPath`, and only this slice's file uses it.

## Left open

- **The D02 guard is not enabled in the shipped profile.** This is the one
  substantive gap. Until `homeLockPath` is set on the `daily-work-host` row, the
  measured data-loss behaviour above is what a misconfigured second host gets,
  and the deployment boundary is the only thing preventing it.
- A recycled pid or a cross-machine holder blocks startup until a human deletes
  the lock file. That direction is deliberate — it costs availability, never
  correctness — but it is a real operational step and is stated in the error
  message.
- Residual processes are **detected and quarantined**, not killed. This slice
  establishes that a survivor exists and that recovery refuses to guess about
  it; actually reaping an orphaned process is a separate concern (gate T06
  covers terminal id reuse after a host kill) and is not claimed here.
