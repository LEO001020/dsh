# V9 fixture — the acceptance-runner CLI's subjects

Two tiny suites, and they exist to make two specific outcomes REAL rather than simulated.

| file | what it produces | why |
|---|---|---|
| `src/empty.test.ts` | **zero tests collected, exit 0** | run with `--passWithNoTests`. An exit-code-only verifier calls this green; the runner must not. |
| `src/skip.test.ts` | **two skipped, zero executed, exit 0** | a suite that ran and reported nothing. The runner must not call it green either. |

## Running it

`node_modules` is a **junction** into
`qualification/results/M8-verification/fixture/node_modules`, which holds the `vitest`
links. It is deliberately **not committed** — a junction is a machine-local path, and a
committed one would be a broken link in a fresh clone. Recreate it before re-running:

```sh
cmd //c "mklink /J <this-dir>\node_modules D:\DSH\work\dsh-native-daily\qualification\results\M8-verification\fixture\node_modules"
```

The definitions that drive this fixture are in `../defs/`, and they name `cwd` by
**absolute** path, so a copy of this directory elsewhere will not run without editing them.
That is deliberate: the runner's snapshot copies the declared `inputs`, and a relative `cwd`
would resolve differently depending on where the runner was invoked from.

## What is NOT here

No test that passes. The passing suite used by the freshness arms (VER-04) lives in
`../fixture-fresh/`, kept separate so that a receipt taken against one fixture can never be
mistaken for a statement about the other.
