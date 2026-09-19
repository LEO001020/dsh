# OPERATIONS — install, run, stop, recover, upgrade, roll back

> **Status: NOT YET VERIFIED ON THIS MACHINE.**
> Every command below is a *plan* until it appears in `qualification/results/`
> with a real exit code. Do not treat this file as evidence.

## Paths (frozen)

| Role | Path |
|---|---|
| DSH source checkout (pinned, disposable) | `D:\DSH\src\dsh-src` |
| This implementation repo | `D:\DSH\work\dsh-native-daily` |
| Canary `DSH_HOME` (C0/C1/C2 experiments) | `D:\DSH\home\canary` |
| Daily `DSH_HOME` (production) | `D:\DSH\home\daily` |
| Task workspaces (writable by model) | `D:\DSH\work\<task>` |
| Control files (NOT writable by model) | `D:\DSH\work\dsh-native-daily\{qualification,profiles,packages,compatibility.lock.json}` |

Canary and daily use **different** `DSH_HOME`, and separate writable workspaces,
outputs and model state. A second host must not open a live home.

## Pinned identity

```
upstream  deepseek-ai/deepseek-harness
commit    ddefc45fbc7f8e46dd73185e68295696d1297887
tag       dsh-v0.1.6-alpha.2
version   0.1.6-alpha.2
pnpm      11.7.0   (via corepack, NOT the global pnpm)
node      ^22.19.0 || >=24.0.0
```

Two launchers, two identities — they are not interchangeable:

- built artifact: `apps/cli/lib/bin.js` (built by `pnpm build`)
- source launcher: root script `dsh` = `node --import tsx/esm apps/cli/src/bin.ts`

The built artifact is the one qualified for daily use. The source launcher, if
used for development, is qualified separately.

## Install (canary)

```sh
cd /d/DSH/src/dsh-src
corepack prepare pnpm@11.7.0 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Read the pinned `postinstall` and package scripts before running. Node must
really satisfy `engines`; 22.16 and 23.x do not.

## Start

```sh
# canary, isolated home
DSH_HOME=D:\DSH\home\canary <launcher> ...
```

Exact flags must be read from the pinned CLI's own `--help`. Do not invent
`--preset`, `--config` or `--resume`.

## Stop

Stop is a first-class operation. A user Stop outranks top-up (INV-G4). Stopping
means: refuse new admissions, abort current admission, wait for owned resources,
then close storage and unregister. It does **not** mean calling the permanent
family drain — see `docs/RECOVERY.md`.

## Diagnose

```sh
python helpers/doctor.py --source D:\DSH\src\dsh-src   # read-only, non-DSH
```

The doctor does not start DSH, does not run package scripts, does not read
credentials, does not go online. Exit 0 proves only that a limited metadata check
succeeded.

## Upgrade

1. Diff API / exports / tests between the pinned commit and the candidate.
2. Test in an **independent canary home** using a state copy.
3. Cold backup, or the official consistency export. Never copy a live DB and
   call it a consistent snapshot.
4. Immutable version directory, new process. HMR/metadata-watch is not a restart
   qualification.

Any change to API URL / model alias / provider protocol / Node or native binary /
plugin graph / preset / sandbox **re-triggers the corresponding gates**. "Source
tests passed" does not mean "another launcher passed".

## Roll back

Restore the old artifact **and** the old state snapshot that the new version has
not migrated. Reconcile external effects the new version already produced —
rolling back software does not withdraw a remote action. A schema that cannot be
migrated safely refuses to start rather than silently reading a backup.

## Evidence layout

```
qualification/results/<case-id>/
  case.json          frozen deployment identity + case parameters
  command.txt        exact command line
  stdout.txt         bounded stdout
  stderr.txt         bounded stderr
  exit.txt           exit code / signal / timeout
  timeline.jsonl     event timeline where relevant
  assertions.json    oracle and observed result
  cleanup.json       what was torn down
```

Sensitive full logs stay in a protected location; redacted summaries are what
gets shared.
