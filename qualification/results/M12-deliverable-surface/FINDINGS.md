# M12 — the deliverable profile's own tool surface

## Verdict: PASS (re-measured 2026-09-20, fresh install)

Booted `--profile daily` from a **foreign cwd** (`C:/Windows/Temp`) against a
**fresh install** into `D:/DSH/home/root-m12-fresh`. Evidence:
`surface-fresh-install.json` (+ `.boot.json`).

| What | Measured |
|---|---|
| Preset roots resolved | `D:/DSH/home/root-m12-fresh/profiles/daily/presets/` present |
| `presetDefaultId` | `daily-standard` |
| Presets found | `standard, ptc, minimal, cordis, daily-standard` |
| Tool count (AGENT-object key) | 27 |
| `ipython` present | true |
| `work` present | true |
| `ipython` parameter names | `["code"]`, and it is the ONLY parameter |
| Host services | kernel, work, data, history, programmatic-scope all present |
| Forbidden lifecycle tools | `[]` |
| Probe error | `null` |
| Port | 6815, released after kill |

Two things this run deliberately does NOT assume:

1. **The cwd is foreign.** The preset root was cwd-dependent (G-FIX-13): the
   same installed profile booted from its own directory resolved the root, and
   booted from anywhere else produced
   `preset "daily-standard" not found (available: standard, ptc, minimal, cordis)`
   with `toolCount: 0`. Booting from `C:/Windows/Temp` is what tests the fix.
2. **The output path is this caller's own.** `readResult()` in
   `qualification/runners/boot-harness.mjs` asserts the result names the home
   that was booted, because a probe writing to a fixed path is a shared mutable
   resource — an earlier run in this project reported another agent's home as
   its own (G-FIX-13).

## Why `surface.json` in this directory says the opposite

`surface.json` is **stale evidence, kept deliberately.** It records the run that
FAILED, and the reason is worth keeping:

```
"error": "RemoteError: agent-presets: preset \"daily-standard\" not found
          (available: standard, ptc, minimal, cordis)",
"presetRoots": [ ..., "D:\DSH\home\canary8/profiles/daily-candidate/presets", ... ],
"toolCountAgentKey": 0
```

The installed patch in that home hardcoded
`process.env.DSH_HOME + '/profiles/daily-candidate/presets'`, while the install
directory is **named by the operator** and was `daily`. The path did not exist.

That was a **stale install, not a product defect**: the repository's patch had
already been fixed to derive the root from `ctx.baseUrl` (commit `084bb23`,
Trap 6/6b in `docs/DELIVERY.md`), but the home under test had been installed
before that fix and never reinstalled. The lesson is the one this project keeps
re-learning in a new place each time: **a passing check against an installed
artifact says nothing about the repository until you prove the artifact was
built from it.**

`surface.json` is left in place as the record of the failure. The PASS above is
from a home installed after the fix.
