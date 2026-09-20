# Measured structural facts for the `dsh.data` slice (P4) and the artifact-unification slice (P13)

Measured by the root agent on `2e1b2c2` while verifying V5 §5.3 and §12, because
V5 describes the required end state but does not name the concrete blocker. Two
writers depend on these, and neither should have to re-derive them.

## 1. The Python data client is CROSS-PACKAGE, and neither package ships it

```
$ find . -name "dsh_data_client*" -not -path "*/node_modules/*"
./packages/dsh-daily-work/src/dsh_data_client.py

$ packages/dsh-ipython/package.json    "files": ['lib/**/*.js', 'lib/**/*.d.ts', 'src/broker.py', 'cordis.patch.yml']
$ packages/dsh-daily-work/package.json "files": ['lib/**/*.js', 'lib/**/*.d.ts', 'cordis.patch.yml']
```

The client lives in **`dsh-daily-work`**. That package does **not** ship it (`files`
omits `src/*.py` entirely). The package that must **install** it at cell-bind time
is **`dsh-ipython`** — and `dsh-ipython` has **no cross-package reference** to it;
the only mentions of `dsh-daily-work/src/...` in that package are prose comments
citing where a vocabulary was copied from.

**So a packed install of `dsh-ipython` cannot install `dsh.data` today**, because
the client it must load is neither in its own `files` nor reachable from it. This is
the concrete meaning of V5's warning: *"Do not rely on source-tree adjacency."*

There IS a working precedent in the same manifest: `dsh-ipython` already ships
`src/broker.py`, so the mechanism for shipping a `.py` from `src/` exists and should
be followed rather than reinvented.

**The test that decides whether a fix worked** is V5 §5.4: a `pnpm pack`-equivalent
install into a disposable foreign path with no source tree on the module path, then
start a kernel, `import dsh`, assert `dsh.data` exists. A packaging claim without
that test is not evidence.

## 2. The frame limit is 4 MiB, enforced on BOTH sides

```
bridge.ts:1346   _MAX_FRAME_BYTES = 4 * 1024 * 1024
bridge.ts:1517   if len(payload) > _MAX_FRAME_BYTES:   -> BridgeError("ARGUMENTS_TOO_LARGE")
bridge.ts:1457   if length > _MAX_FRAME_BYTES:          -> BridgeError("FRAME_TOO_LARGE")
```

`1517` is the SEND side (arguments too large to send); `1457` is the RECEIVE side
(the host declared a frame larger than the limit). Both refuse rather than truncate,
which is the correct shape — V5 §12's concern is that a large result must not be
*forced through* this frame at all, not that the limit is wrong.

## 3. The `Artifact` class makes a raw host path the authority

```
bridge.ts:1359   class Artifact:
bridge.ts:1367     def __init__(self, path, size, sha256):
bridge.ts:1373     def load(self):  with open(self.path, "rb") as handle: return handle.read()
bridge.ts:1376     def text(self, encoding="utf-8"): return self.load().decode(encoding)
bridge.ts:1379     def json(self): return _json.loads(self.text())
bridge.ts:1382     def verify(self): ...
```

**What a caller can do with this that it cannot do with a typed ref** — which is the
security-relevant difference, not the tidiness:

- `load()` **opens an arbitrary filesystem path**. The path came from the host, but
  nothing in the object binds it to the observation, the grant, the scope, or the
  digest — so the object's only integrity property is whatever `verify()` recomputes,
  and `path` itself is unchecked.
- `path` is a **plain attribute**. A caller can read it, print it, log it, or write
  it elsewhere. A typed ref would be an identifier the host resolves, so a leaked
  identifier is not itself a filesystem capability.
- The object carries **no expiry, no scope and no revocation**. Once a caller holds
  it, it works for as long as the file exists — unlike a cursor, which the project
  already binds to a store realm, a revision, a scope and an owner.

The unified plane's whole point (V5 §12) is that a ref carries identity: quota,
retention, integrity, paging, provenance, cursor and authorization live in ONE place
rather than two. This class is the second, ad-hoc place.

## 4. What this note does NOT claim

- It does not claim the raw path is exploitable by itself. The path is host-supplied
  and the caller is the same OS user — the OS account is the execution authority
  boundary, so a same-UID caller can read the file anyway. The finding is that the
  object **claims an integrity property it does not carry**, which is this project's
  most-recorded defect shape, not a new escape.
- It does not decide where the data client should live. That is a design choice with
  three defensible answers (V5 §5.3 permits moving it, shipping it from its current
  package, or generating it from a package-owned resource), and P4 owns it.

## 5. CORRECTION to §1 above: there are TWO client mechanisms, and I conflated them

Section 1 says the Python data client is cross-package and neither package ships
it. That is true of `dsh_data_client.py`. **It is NOT true of the bridge client**,
and the difference changes the design space. Found by writer P13's probe, whose
artifact directory contained `dsh_bridge_client.py`, then traced to source.

`packages/dsh-ipython/src/bridge.ts:944-946`, inside `BridgeServer.start()`:

```ts
this.clientPath = join(clientDirectory, BRIDGE_CLIENT_FILENAME)   // 'dsh_bridge_client.py'
writeFileSync(this.clientPath, PYTHON_CLIENT_SOURCE, 'utf8')
```

So the **bridge** client is **materialised to disk at runtime from a TS template
string** (`PYTHON_CLIENT_SOURCE`) into `clientDirectory ?? artifactDirectory`. It is
not imported from a package at all, so it has no packaging problem — it ships as
code. Its own comment states the deliberate security property:

> *"the token is minted here and nowhere else. It is written into the client's
> module namespace by the per-cell preamble rather than into the client source, so
> the on-disk client is not itself a capability and can be rewritten without
> invalidating a live kernel."*

**The two mechanisms, stated separately so they are not conflated again:**

| client | mechanism | packaging |
|---|---|---|
| `dsh_bridge_client.py` | generated at runtime from `PYTHON_CLIENT_SOURCE` in `dsh-ipython` | **no problem** — it is code, not a shipped file |
| `dsh_data_client.py` | a real file in `dsh-daily-work/src/`, absent from both packages' `files` | **the actual gap** |

**Consequence for the fix:** V5 §5.3 permits three routes (move / ship / generate),
and the **generate** route is not merely permitted — it is the pattern this codebase
already trusts for exactly this problem. A fix taking that route must preserve the
property the bridge client has: **the generated file must not carry the token**, or
it would turn an on-disk file into a capability, which is strictly worse than the
cross-package import it replaces.
