# ARCHITECTURE

## What this system is

A **DSH-native personal daily system** for coding and research. The model owns
task strategy. The runtime owns resources, lifetime and permission constraints.
The real environment and an independent acceptance decide whether work succeeded.

It is not an orchestrator bolted onto DSH. There is exactly one model loop, and it
is DSH's existing AgentLoop.

## Layering

```
┌──────────────────────────────────────────────────────────────┐
│ Trusted control (NOT writable by the model)                  │
│  compatibility.lock.json · qualification/specs · profiles     │
│  packages/ · DSH_HOME control area                           │
└──────────────────────────────────────────────────────────────┘
                            │ mounts
┌──────────────────────────────────────────────────────────────┐
│ Host profile                                                 │
│  bundles (base, web-app, …) → profile patch → home patch →    │
│  CLI patch                                                   │
│  Provides: providers, registries, storage, sandbox, terminals │
└──────────────────────────────────────────────────────────────┘
                            │ standing composition
┌──────────────────────────────────────────────────────────────┐
│ Agent preset                                                 │
│  agent-scoped tools, instructions, compaction, isolation grps │
│  C0 = shipped standard. C2 = + dsh-daily-work consumer.       │
└──────────────────────────────────────────────────────────────┘
                            │ per-Session
┌──────────────────────────────────────────────────────────────┐
│ root Agent  (keeps its own reserved inference credit)         │
│  tool `work`: submit / status / finish                        │
└──────────────────────────────────────────────────────────────┘
                            │ continuable children
┌──────────────────────────────────────────────────────────────┐
│ N in-flight child assignments, rolling top-up                 │
│  one logical task → one fresh continuable child               │
└──────────────────────────────────────────────────────────────┘
```

## The one extension package

`packages/dsh-daily-work` exports two mount points with **different lifetimes**:

- `dsh-daily-work/host` — mounted once by the host profile. Owns the single
  storage-domain handle, the run record, credit reservation, the admission state
  machine and the coalesced drain.
- `dsh-daily-work/tools` — mounted in the agent preset. Registers the `work` tool
  as an agent-scoped consumer. It holds **no** cross-session mutable state; every
  operation resolves the exact live Agent **by object identity**
  (`tool-protocol-guards.ts`). This line used to read "and run epoch": the run
  record has no `epoch` field and there is deliberately no run-epoch check here
  (`host.ts:23-25`, `record.ts:410-441`), because the topology measurement showed
  no production path can present a stale-epoch settlement
  (`qualification/results/R9-recovery-topology/`).

Different lifetimes are mounted separately. That is not the same as splitting into
multiple software products — it is one package with two entry points.

## Why a run record exists at all

DSH already has durable Sessions and a durable Inbox. We do **not** duplicate them.
What DSH does not have is *this project's* notion of a user-authorized run with a
target N, a budget reservation, and a per-task reconciliation relation.

So the record holds only:

- assignment (taskId → reserved childId → attempt)
- permission ceiling and policy digest
- credit reservation and spend
- outbox (pending notifications)
- last reconciled refs
- terminal tombstones

Large payloads live in ordinary immutable artifacts and Sessions. The record
stores refs. Every field must be justifiable by a failure window it closes; fields
with no such justification get deleted.

## What is deliberately absent

- No scheduler, DAG, role graph, event bus, SessionLease, receipt DB, or generic
  memory carried over from any earlier project.
- No second semantic coordinator that reads the LLM.
- No `maxParallel` counter pretending to be N in-flight assignments.
- No pre-built empty packages for conditional capabilities.

## Counting, precisely

DSH `Agent.status === 'running'` covers the driver lifetime and does **not** prove
tokens are being produced. The system reports these separately and never merges
them into one green number:

```
desired_target · ready_tasks · durably_admitted · launching
active_assignments · waiting_owned_tool · provider_waiting
stopping · quarantined_unknown · completed · capacity_deficit(+reason)
```

A child counts as an in-flight assignment when it has started real model/tool work
and still holds an open task. An idle Session with no task does not count.
Waiting on the child's own valid tool may be in-flight, but waiting time is
reported separately. Provider queueing is **not** dressed up as physical
concurrency. Tool parallel width, subagent count and HTTP request count are
reported as three different numbers.

`active + launching + stopping + unknown` reservations never exceed the configured
ceiling. N allows a momentary top-up delay; it does not allow a silent long-term
downgrade.
