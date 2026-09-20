# P4 / V5 §5.3 — where the Python data client lives, and which package ships it

Decision: **option (b)** — the client stays in `dsh-daily-work`, that package ships
it via `files`, and the path is published by the package that OWNS the file
through the mounted service. `dsh-ipython` never names the sibling package.

Committed with the wiring in the same change; see the commit subject for the sha.

---

## 1. What is actually true, measured (not taken from the dispatch premise)

There are **two different mechanisms**, and conflating them changes the answer:

| client | mechanism | packaging problem? |
|---|---|---|
| `dsh_bridge_client.py` | **generated at runtime** from the TS template string `PYTHON_CLIENT_SOURCE` (`bridge.ts:1325`), written by `BridgeServer.start()` (`bridge.ts:939-946`) into `clientDirectory ?? artifactDirectory` | **NONE** — it is code, so it ships inside `lib/*.js` |
| `dsh_data_client.py` | a **real 454-line file** at `packages/dsh-daily-work/src/dsh_data_client.py` | **YES** — absent from both packages' `files` |

```
$ find . -name "dsh_data_client*" -not -path "*/node_modules/*"
./packages/dsh-daily-work/src/dsh_data_client.py

$ grep -c "dsh_data_client" packages/dsh-ipython/src/*.ts   # before this change
0            # the consumer package had NO reference of any kind
```

Is the client loaded **by path** or **by import** today? **By path, from source-tree
adjacency, and only from a test**: the only two loads are
`data-r6.test.ts:1319` and `:1390`, both `importlib.util.spec_from_file_location`
with a path derived from `import.meta.url` of the TEST file. No production code
loads it at all, which is why the gap was real in practice and not merely in
packaging — the file had no production consumer to fail.

## 2. Why (b), and not (a) or (c)

**Why not (a) — move/copy into `dsh-ipython`.**
Rejected on ownership, and the deciding fact is a measured one: the file is the
client **of the plane**, and the plane's contract lives in `dsh-daily-work`
(`data-bridge.ts` owns the router, the method table and `DATA_METHODS`). Moving it
would split the plane's contract across two packages. Worse, `data-r6.test.ts:1050`
READS that exact file to assert its method list is a subset of `DATA_METHODS`; a
move would either break that gate or require the gate to reach into the other
package — trading a packaging gap for a test-coupling gap.

**Why not (c) — generate it at bind time from a package-owned resource.**
This is a legitimate route (V5 §5.3 permits it, and the root agent correctly notes
`PYTHON_CLIENT_SOURCE` is the established precedent). **Rejected for one reason:
it creates a second copy of a 454-line client.** The generator would live in
`dsh-ipython` while the file stays in `dsh-daily-work`, and `data-r6.test.ts:1050`
would then be asserting a method list against a copy that no longer runs. That is
precisely the drift hazard the existing gate exists to prevent, and it would need
a NEW gate to bind template to file. The precedent does not transfer cleanly: the
bridge client has no other copy to drift from.

**Why (b) works despite the unresolvable import.** The consumer does not need to
import the package — it needs the FILE. The owner publishes the path:

```
DataPlaneService.dataClientPath()        data-service.ts
  -> join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dsh_data_client.py')
```

`dsh-ipython` reads it off the MOUNTED service (`ctx.get('dailyData')`), which it
already resolves for routing. So the dependency is on the *mounted service*, which
is exactly the seam `data-bridge.ts` already documents, and not on a module
specifier that measurably fails to resolve.

```
$ node -e "createRequire('D:/DSH/work/wt-p4/packages/dsh-ipython/lib/bridge.js')
             .resolve('dsh-daily-work/package.json')"
dsh-daily-work UNRESOLVABLE (MODULE_NOT_FOUND)
```
`dsh-ipython/node_modules/` holds only `@deepseek-ai`, `@types`, `koffi`, `tsx`,
`vitest`, `zod`. From the PROFILE directory it resolves, but a package must not
depend on being resolved from the profile root — that is the same class of
coincidence as the hardcoded-path defect G-SEAM-55.

**The path is `src/`, following the precedent in the sibling package.**
`dsh-ipython/package.json` already ships `src/broker.py`; Python is never compiled,
so the file stays where it is authored. `dsh-daily-work`'s `files` now names
`src/dsh_data_client.py` for the same reason. Without that entry the path would
resolve to nothing after `pnpm pack` — which is exactly what V5 §5.4 tests.

## 3. The security property, preserved

The generated bridge client carries **no token**: the token is injected per-cell by
the preamble, so the on-disk file is not itself a capability. The data client
follows the same rule — it holds no credential, no cursor secret and no bytes
(`dsh_data_client.py:5-7`), and its call channel is bound per cell by
`_bind` before `install` runs. **No token, port or lease id is written into
`dsh_data_client.py`**, so it remains a non-capability on disk. Its API version is
verified (`DATA_API_VERSION`) before the namespace is exposed.

## 4. What this decision does NOT establish

The `pnpm pack`-into-a-foreign-path test (V5 §5.4) is the test that decides whether
this worked, and **it is not yet run**. Until it is, the claim is "the file is in
`files` and the path is derived from the package's own location", which is
necessary and not sufficient. Recorded here rather than reported as verified.
