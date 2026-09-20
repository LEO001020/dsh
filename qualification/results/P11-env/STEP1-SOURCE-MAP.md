# P11 / P1.4 — STEP 1 source map and the BEFORE reproduction

Slice: P1.4 — the Python environment identity is too weak to distinguish
environments that differ. V5 §11.2 (environment identity) and §18 (`ENV-DIGEST`).

All line numbers are this worktree at the moment of writing, i.e. **before** my
edit. Identity of the tree measured:

```
worktree  D:\DSH\work\wt-p11
branch    wt/p11
HEAD      2e1b2c2d3657407ce7ac621b07b3307d3edd8df4
```

## 1. The defect, at its exact source location

`packages/dsh-ipython/src/kernel-plugin.ts:437-446` (pre-edit numbering):

```ts
  /**
   * A digest of the interpreter identity, so a kernel built against a different
   * Python is not reused as if it were the same environment.
   */
  private defaultEnvironmentDigest(): string {
    return createHash('sha256')
      .update(`${this.config.pythonExecutable}\u0000${process.platform}\u0000${process.arch}`)
      .digest('hex')
      .slice(0, 16)
  }
```

`SOURCE_FACT`. The digest is a function of exactly three inputs: the configured
interpreter **path string**, `process.platform`, and `process.arch`. Truncated to
16 hex characters (64 bits) of a sha256.

Consequences, each of which is decidable from the expression alone:

| change | does the current digest move? |
|---|---|
| Python 3.14.0 -> 3.14.1 at the same path | **NO** |
| IPython 9.x -> 10.x at the same path | **NO** |
| `ipykernel` / `jupyter_client` / `pyzmq` upgraded | **NO** |
| `broker.py` edited (e.g. a changed start path) | **NO** |
| the bridge Python client (`PYTHON_CLIENT_SOURCE`) edited | **NO** |
| the data client (`dsh_data_client.py`) edited | **NO** |
| the interpreter MOVED to a new path, same build | YES |
| platform or arch differs | YES |

## 2. Every reader of `environmentDigest` (so the blast radius is known)

`PROJECT_FACT`, by grep over this tree.

| reader | file:line (pre-edit) | what it does |
|---|---|---|
| producer | `packages/dsh-ipython/src/kernel-plugin.ts:396` | `identityFor` — `this.config.environmentDigest ?? this.defaultEnvironmentDigest()` |
| the ONLY default-digest caller | `packages/dsh-ipython/src/kernel-plugin.ts:441` | the method above |
| identity equality check | `packages/dsh-ipython/src/kernel-plugin.ts:467-473` | `entryFor`: refuses a live kernel whose recorded digest differs, message `the kernel must be evicted` |
| identity carrier | `packages/dsh-ipython/src/kernel.ts:53` | `KernelIdentity.environmentDigest` |
| second equality check | `packages/dsh-ipython/src/kernel.ts:522-527` | `assertIdentity`, per-request |
| type mirror | `packages/dsh-daily-work/src/kernel-lifecycle.ts:74, 637` | a SEPARATE plane, not the live one (see below) |

**The `dsh-daily-work` plane is a type mirror with no runtime.** `kernel-lifecycle.ts`
declares its own `environmentDigest` fields and a `changeReadPermissionDomain` that
consumes one, and `packages/dsh-daily-work/src/sec-gates.test.ts:1827-1845` already
records that no production module imports it. **Not my slice**; recorded so a reader
does not mistake the two planes for one.

**An important negative, `SOURCE_FACT`:** `environmentDigest` is used ONLY for
equality. Grep for `environmentDigest` co-occurring with `join`/`path`/`dir`/
`sanitize` returns nothing outside `kernel-lifecycle.ts:87` (which builds a
comparison key, not a path). So the digest does not name a directory and no
filesystem path depends on its length.

## 3. Where a bounded probe could run at host activation

This is the coordinator's question, and the answer is **there is no existing
probe to extend** — the kernel start path already runs one Python process, and it
is the one that must NOT be reused.

`SOURCE_FACT`:

1. `KernelService.entryFor` (`kernel-plugin.ts:459-558`) is the creation
   transaction. It resolves the identity at `:460` — **before** any process is
   started — and the broker is spawned at `:513-527`.
2. `KernelHost.startInternal` (`kernel.ts:224-258`) spawns `pythonExecutable
   broker.py` through `ctx.subprocess.spawn`, then `:527` awaits the handshake.
3. `broker.py`'s `start()` (`broker.py:628-737`) does start the kernel and return
   `self.status()`, and `status()` (`broker.py:746-781`) already issues ONE
   `kernel_info_request` and reads `language_info.version` (`broker.py:759-760`).

So the tempting shortcut is "read the manifest out of the broker handshake".
**It is the wrong instrument for this job, and measurably so:**

- the broker's own interpreter is the SAME interpreter, so `sys.executable`
  realpath and the four package versions could be read there — but the identity
  is consumed at `kernel-plugin.ts:460`, *before* the broker exists. A digest
  that is only knowable after a process starts cannot gate that process.
- `broker.py` needs `jupyter_client` + `ipykernel` to be importable **just to
  start**. A probe that runs *inside* the broker therefore cannot report "the
  environment is missing ipykernel" — the failure it exists to detect has
  already taken the probe down with it.
- `broker.py` is itself one of the files that must be hashed. A digest computed
  by the code under measurement is not a measurement of that code.

**Decision:** a separate, bounded, one-shot `python -c` probe spawned through the
same `ctx.subprocess` seam, run at the point of identity resolution, with its own
timeout. Cost measured: **0.136 s** wall for the metadata-only probe
(`ipython`, `ipykernel`, `jupyter_client`, `pyzmq` via `importlib.metadata`;
`sys.executable` realpath; `platform`). That is cheap enough to sit on the
activation path, and it does not need `import ipykernel`.

## 4. The broker's current status field names (the naming trap, named precisely)

`SOURCE_FACT`, `broker.py:746-781`:

```python
    def status(self):
        ...
        version = None
        if alive:
            try:
                reply = self._shell_request("kernel_info_request", timeout=10)
                version = reply.get("content", {}).get("language_info", {}).get("version")
            except Exception:  # noqa: BLE001
                version = None
        return {
            ...
            "ipythonVersion": version,
            ...
        }
```

The field is **named** `ipythonVersion` and **carries** `language_info.version`.
Those are different things and the name is the lie:

- `language_info.version` is built by `IPythonKernel.language_info`
  (`ipykernel/ipkernel.py`, `"name": "python", "version": sys.version.split()[0]`),
  i.e. it is the **Python language** version.
- the **IPython** version is `implementation_version`
  (`ipykernel/kernelbase.py` `kernel_info` property: `"implementation":
  self.implementation, "implementation_version": self.implementation_version`,
  with `IPythonKernel.implementation = "ipython"`).

Measured on this host, all three values distinct:

```
kernel_info_reply.implementation          = "ipython"
kernel_info_reply.implementation_version  = "9.16.1"    <- the IPython version
kernel_info_reply.language_info.version   = "3.14.3"    <- the Python version
kernel_info_reply.protocol_version        = "5.3"
```

`PROJECT_FACT`: this mislabelling is **already recorded** in this repo, not newly
discovered by me — `qualification/results/V3-ipython/GATES.md:141` says
"`status.ipythonVersion` reports **3.14.3**, which is the *Python* version, not
the IPython version", and the live transcript is
`qualification/results/V3-ipython/run-v3-spec-gates.txt:5`
(`"ipythonVersion":"3.14.3"`). It is consumed at
`packages/dsh-ipython/src/v3-spec-gates.test.ts:158`.

V5 §11.2 names the correct fields: `kernelImplementation`,
`kernelImplementationVersion`, `languageName`, `languageVersion`,
`protocolVersion`.

## 5. The local files the manifest must hash

`SOURCE_FACT`:

| manifest field | file | how the host reaches it |
|---|---|---|
| `broker_sha256` | `packages/dsh-ipython/src/broker.py` | `DEFAULT_BROKER_SCRIPT` = `join(PACKAGE_ROOT,'src','broker.py')`, `kernel-plugin.ts:118-121` |
| `bridge_python_client_sha256` | `packages/dsh-ipython/src/bridge.ts` `PYTHON_CLIENT_SOURCE` (`:1325`), written to disk at `:945` | `bridgeClientDigest()` already exists at `:1667-1669` |
| `data_client_sha256` | `packages/dsh-daily-work/src/dsh_data_client.py` | **not reachable from this package** — see the UNKNOWN in the report |

`broker.py` is the file that is actually *executed* by the configured
interpreter (`argv = [pythonExecutable, brokerScript]`, `kernel.ts:226`), so
hashing it is what binds the identity to the code rather than to the path.

## 6. The BEFORE reproduction (the oracle the fix must flip)

`qualification/results/P11-env/before-weak-digest.json`, produced by
`qualification/results/P11-env/before-weak-digest.mjs`.

The reproduction computes the PRE-EDIT digest expression verbatim and then asks
the four questions that matter. Expected and measured: the digest is **identical**
across a changed `broker.py`, a changed bridge client, a changed Python patch
version and a changed IPython version, and differs only when the interpreter path
changes.

Run it with:

```
node qualification/results/P11-env/before-weak-digest.mjs
```
