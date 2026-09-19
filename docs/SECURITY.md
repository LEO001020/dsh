# SECURITY — trust boundaries and what is enforced where

## The four permission planes are modelled separately

| Plane | Owner | Enforced by | NOT enforced by |
|---|---|---|---|
| Model tool permission | agent preset tool catalog, `toolFilter`, deployment ceiling | ToolRuntime pipeline + final sync `guard` | prose in the prompt |
| OS permission | process identity, filesystem ACLs, sandbox roots | the OS and the sandbox policy | tool allowlists |
| Web/API control plane | loopback server, human terminal, plugin manager | separate service identity | binding to localhost |
| Provider credentials | credential store, per-route keys | process/env boundary | tool name checks |

A trusted plugin has host execution ability. A tool allowlist **cannot** constrain
the plugin itself. Therefore: the model never installs an unreviewed plugin, and
never executes configuration or `!!js` found in retrieved documents.

## Absolute rule: two terminals, two powers

- **`ctx.terminals`** — agent-owned registry (`spawn` / `startSend` / `read` /
  `signal` / `kill`). Sandbox, permission mode and owner lifetime are part of its
  contract. This is what model Python uses.
- **`ctx.terminalController`** — the human Web terminal. It runs with
  **system-user privilege** and is explicitly not subject to the agent sandbox or
  approval flow.

Wrapping the second as a model tool is **privilege escalation**, not convenience.
This is invariant INV-S1 and is covered by gates E02 and T02.

## Default capability grant

Task sandboxes get only the file and network ability the task needs. Not
readable, not writable:

- the user home directory and credentials
- plugin code and the trusted control files
- the state DB / `DSH_HOME` control area
- the acceptance definitions under `qualification/specs/`
- other Sessions

## Control files the model must not be able to modify

- `compatibility.lock.json`
- `qualification/specs/**` (acceptance definitions)
- `profiles/**`
- `packages/**` of this repo (during daily use)
- the running `DSH_HOME` control area

Development (this agent, with explicit authorization) and daily use (the model
under the daily profile) are **different trust levels**. The daily profile does
not inherit this agent's write access.

## External side effects

A native checkpoint can persist a dispatch intent. It is **not** an exactly-once
external effect. In particular, a nested PTC call cannot rely on the top-level
`run_code` checkpoint alone. Arbitrary shell effects cannot be fully classified
from command text.

First version: no unadapted irreversible remote operation runs automatically.
Necessary sends/deploys go through an explicitly authorized, task-specific
adapter that has:

- a stable `operationId` plus a parameter digest
- recorded intent
- a remote idempotency key or a queryable result
- `lost reply` → `unknown`, never a retry with a changed tool `callId`

Without a real query or idempotency support the honest answer is `unknown`. We do
not build a universal effect WAL and claim the world is solved.

Automatic replay is forbidden for: an entire PTC program, an unknown Python
cell, or all failed shell commands. Transport retry and semantic replay are
decided separately. Even read-only retries get a budget and rate limit.

## Verification runs untrusted code

The verifier is launched by the trusted host, but the repo tests and builds it
executes may be **model-modified, untrusted code**. They run in an isolated
environment and do not inherit host credentials, control-plane access or extra
network permission by virtue of being "verification".

## Test data

Security tests use canary fake secrets and harmless markers inside a dedicated
test directory. They prove the **denial path**. They never read real private data.
