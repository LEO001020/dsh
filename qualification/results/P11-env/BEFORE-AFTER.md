# P11 / P1.4 — BEFORE / AFTER

The oracle is V5 §18 `ENV-DIGEST`: *changing Python/IPython/ipykernel/bridge code
changes the environment digest and forces a new epoch.*

The single sharpest pair is below. Both values are real measurements on this host,
taken through the PRODUCT's own service in a real `daily` boot.

## The pair

A real content change to `broker.py` — the file the configured interpreter
actually executes — with everything else byte-identical.

| | BEFORE | AFTER |
|---|---|---|
| digest value | `0526e28116906fcc` | `dc82c4e8…fd14` → `4e5611f5…00d9` |
| digest length | **16** hex chars (64 bits) | **64** hex chars (256 bits) |
| inputs | `pythonExecutable` path string, `process.platform`, `process.arch` | the 10-field V5 §11.2 manifest |
| moves when `broker.py` content changes? | **NO** | **YES** |
| sees a Python patch bump at the same path? | NO | YES (`python_version`) |
| sees an IPython 9→10 upgrade at the same path? | NO | YES (`ipython`) |
| sees a changed `ipykernel`/`jupyter_client`/`pyzmq`? | NO | YES |
| sees a changed bridge Python client? | NO | YES (`bridge_python_client_sha256`) |
| measured through | the frozen expression, `before-weak-digest.mjs` | a real `daily` boot's own `ctx.ipython` |

The BEFORE value `0526e28116906fcc` is not asserted — it is the output of running
the pre-edit expression, and it is the value the mutation test printed when I put
the old expression back (see `MUTATION-TESTING.md`).

## Artifacts, and which question each answers

| file | what it measures | how it was produced |
|---|---|---|
| `before-weak-digest.mjs` / `.json` | the OLD digest, frozen; includes a REAL on-disk `broker.py` mutation whose own sha256 moves while the old digest does not | `node qualification/results/P11-env/before-weak-digest.mjs` |
| `composition-tier.json` | the AFTER value through a real product boot: 64 chars, the full manifest, and the digest moving across the same real mutation | `DSH_HOME=D:/DSH/home/p11 node qualification/runners/p11-env-digest-driver.mjs` |
| `composition-tier.probe.json` | the probe's raw result, before the driver wrapped it | written by the probe inside the boot |
| `MUTATION-TESTING.md` | that the new gate goes RED against both the old digest and a removed file read | two mutations applied, run, reverted |

## The AFTER manifest, verbatim from the boot

```
sys_executable_realpath        C:\Users\hzq00\AppData\Local\Programs\Python\Python314\python.exe
python_implementation          CPython
python_version                 3.14.3
ipython                        9.16.1
ipykernel                      7.3.0
jupyter_client                 8.10.0
pyzmq                          27.2.0
broker_sha256                  3393c3de8f522ecd8852e5d96714bb9b8de9e5df40e02ae5894a40cb17e86a60
bridge_python_client_sha256    b78cc5e3bb7df19e3f0c418fae2044f843ccfa661ed624cdd56808195efbf573
data_client_sha256             null
```

`data_client_sha256` is `null` and that is the honest value, not a failure: the
`dsh.data` client lives in `dsh-daily-work`, which this package does not depend on
and must not import in order to compute its own identity. The path is
host-supplied (`KernelServiceConfig.dataClientScript`) and no host in this
deployment supplies one. A guessed path would put a fabricated fact into an
identity; `null` says "asked, and no host answered".

Note the two version fields are genuinely different values — `ipython 9.16.1`
versus `python_version 3.14.3`. That is exactly why the old `ipythonVersion`
status field was wrong by construction and could not simply be renamed.

## The epoch half

`composition-tier.json` does NOT measure eviction: `environmentStatus()`
deliberately does not start a kernel, so a composition-tier probe cannot show a
kernel being refused. That half is measured against a REAL kernel in
`packages/dsh-ipython/src/p11-env-digest.test.ts`, whose first test:

1. starts a real kernel under the unmutated environment;
2. mutates `broker.py` on disk and re-resolves through `reconfigure`;
3. shows the digest moved and exactly ONE manifest input moved;
4. shows the next cell is refused with `KernelTransportError` naming both digests
   and containing `the kernel must be evicted`;
5. shows the kernel is STILL PRESENT and its epoch DID NOT ADVANCE — a silent
   evict-and-restart would satisfy "a new epoch" while destroying the evidence
   that the environment changed under a live namespace;
6. restores the file and shows the SAME service and SAME session work again, which
   is what makes the refusal attributable to the mutation.

## Reproducing

```
# the BEFORE value, from the frozen expression
node qualification/results/P11-env/before-weak-digest.mjs

# the AFTER value, through a real product boot (rebuild lib/ first -- see below)
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p packages/dsh-ipython/tsconfig.json
DSH_HOME=D:/DSH/home/p11 node qualification/runners/p11-env-digest-driver.mjs

# the epoch half, against a real kernel
cd packages/dsh-ipython && node node_modules/vitest/vitest.mjs run src/p11-env-digest.test.ts
```

**REBUILD `lib/` BEFORE BELIEVING A COMPOSITION-TIER RESULT.** The first run of
the composition-tier probe reported a FALSE NEGATIVE — "the boot's ipython service
has no `environmentStatus()`" — because the boot loaded a `lib/` compiled before
the change. That is the stale-artifact trap this project has already filed twice
(G-SEAM-29, G-SEAM-36). The probe now reports which surface it found rather than
inferring one, but the rebuild is the caller's responsibility.
