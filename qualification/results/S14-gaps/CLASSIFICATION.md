| id | line | subject | verdict |
|---|---|---|---|
| `G-ENV-01` | 61 | DSH was not installed on this machine. `D:\DSH` existed but was empty. | **RESOLVED** |
| `G-ENV-02` | 62 | Delivery package recorded Node v22.16.0 which does not satisfy `^22.19.0 \\|\\| >=24.0.0`. | **RESOLVED** |
| `G-ENV-03` | 63 | Delivery package recorded the clone blocked by DNS. | **RESOLVED** |
| `G-ENV-04` | 64 | `pnpm install --frozen-lockfile` failed on the first attempt with a network `fetch failed` after 1285/1319 packages. | **RESOLVED** |
| `G-ENV-05` | 65 | Global `pnpm` is 11.24.0 but the repo pins `pnpm@11.7.0`. | **RESOLVED** |
| `G-ENV-06` | 66 | The built launcher and the source launcher are different distribution identities. | **OPEN** |
| `G-SEAM-01` | 72 | Delivery plan text names `SubagentStartSpec` and `ContinuableSpec`. | **RESOLVED** |
| `G-SEAM-02` | 73 | `ctx.codeRuntime` / `code-runtime` in the attachment. | **RESOLVED** |
| `G-SEAM-03` | 74 | No `status()`/`query()` on `ctx.subagents`. | **OPEN** |
| `G-SEAM-04` | 75 | `subagent/end` carries no `error` or `diagnostic` field. | **OPEN** |
| `G-SEAM-05` | 76 | No subagent mock provider exists in `packages/test-support/`. | **OPEN** |
| `G-SEAM-06` | 77 | `AgentOptions` has no `cwd`. | **OPEN** |
| `G-SEAM-07` | 78 | `maxActiveSubagents` default is 8 and rejects `0`. | **OPEN** |
| `G-SEAM-08` | 79 | `agent/idle` does not exist; `agent.dispose()` does not exist. | **RESOLVED** |
| `G-SEAM-09` | 80 | `storageDomain` has no `spec` member; `get`/`put`/`update` are `KvTable` methods. | **RESOLVED** |
| `G-SEAM-10` | 81 | No host lease and no cross-process write locking anywhere in storage. | **OPEN** |
| `G-SEAM-11` | 82 | `dsh-tool-terminal` (the `terminal_*` tools) is mounted by NO shipped preset or bundle. | **DUPLICATE** |
| `G-SEAM-12` | 83 | Windows sandbox is real but write-only and `enforcement: 'partial'`. | **OPEN** |
| `G-SEAM-13` | 84 | `ctx.terminals.spawn()` does not resolve under `read-only` sandbox mode on Windows. | **OPEN** |
| `G-SEAM-14` | 85 | The terminal service rejects a forged owner object. | **RESOLVED** |
| `G-SEAM-15` | 86 | The `tool-plugin-manager` row is `disabled: true` in the shipped standard preset. | **RESOLVED** |
| `G-SEAM-16` | 87 | The **standard** preset mounts no PTY at all; the **minimal** preset does. | **OPEN** |
| `G-SEAM-21` | 88 | The run record's `epoch` guard is UNREACHABLE, so the field is inert in the product. | **OPEN** |
| `G-SEAM-20` | 89 | The shipped profile installs NO launch port, so a model `submit` records a task, marks it `unknown`, and launches NOTHING. | **RESOLVED** |
| `G-SEAM-19` | 90 | One-shot `ctx.subagents.start()` performs NO capacity check at all, and the capacity pool is PER-ROOT. | **OPEN** |
| `G-SEAM-18` | 91 | A caller-supplied `maxDepth` LIFTS the deployment depth cap, and an OMITTED one is NOT a refusal. | **OPEN** |
| `G-SEAM-17` | 92 | `dsh-tool-terminal` (the six `terminal_*` tools) is mounted by NO shipped preset. | **OPEN** |
| `G-SEAM-22` | 93 | Upstream undeclared dependency at the pinned commit: `dsh-tool-fs-search` imports `dsh-util-values` but declares it nowhere. | **OPEN** |
| `G-SEAM-23` | 94 | `SessionObservationReader`'s prepared-observation cache can never hit, because its key compares a service identity that `ctx.ge... | **OPEN** |
| `G-VER-01` | 95 | M8's recorded evidence was taken against a DIFFERENT revision of the test file, and the recorded count was therefore wrong. | **RESOLVED** |
| `G-VER-02` | 96 | A W02 assertion was broken rather than weak, and it masked the three assertions behind it. | **RESOLVED** |
| `G-VER-03` | 97 | VER-04 has no fix expressible through the public sandbox seam, so the gate stays an honest FAIL. | **BLOCKED_EXTERNAL** |
| `G-VER-04` | 98 | The M8 suite contained a LOAD-DEPENDENT ORACLE: VER-06's in-place arm stopped testing anything when the machine was busy. | **RESOLVED** |
| `G-VER-05` | 99 | A prior pass reported three stale evidence hashes in `qualification/gates.json`; this does NOT reproduce. | **REFUTED** |
| `G-FIX-01` | 105 | Counting computed occupancy with a second formula that could disagree with the state machine. | **RESOLVED** |
| `G-FIX-02` | 106 | `mayAdmit` and the reported `budget_blocked` reason used different budget predicates. | **RESOLVED** |
| `G-FIX-03` | 107 | The host plugin used a synchronous `apply` that started the domain open inside `ctx.effect`, so `await ctx.plugin(...)` returne... | **RESOLVED** |
| `G-FIX-04` | 108 | Gates B02 and B03 were reported PASS on evidence weaker than their scenario.** The evidence proved `ctx.plugin()` direct mounti... | **RESOLVED** |
| `G-FIX-05` | 109 | The `work` tool was never wired into any preset, so the extension could load and still be invisible to the model. | **RESOLVED** |
| `G-FIX-06` | 110 | The first end-to-end tool probe reported `toolCount: 0`, a false negative. | **RESOLVED** |
| `G-FIX-07` | 111 | G-SEAM-13 over-generalized a mode-specific hang into a platform limitation. | **RESOLVED** |
| `G-FIX-08` | 112 | The B03 replacement probe reported "9 orphan handles" that did not exist. | **RESOLVED** |
| `G-SEAM-24` | 113 | The sandbox seam has no network vocabulary, and the pinned checkout says so as a deliberate deferral. | **OPEN** |
| `G-SEAM-25` | 114 | `kernel-lifecycle.ts` claims the kernel process has "its own OS identity"; it does not. | **OPEN** |
| `G-SEAM-26` | 115 | A hard link inside the workspace writes THROUGH to the outside name, so the write boundary has a second escape beside the symlink. | **OPEN** |
| `G-SEAM-27` | 116 | `SEC-01`/`SEC-03` are seam facts, not Windows facts** — established on Linux too, closing the "move the deployment" escape. | **OPEN** |
| `G-SEAM-28` | 117 | The plan requires a sandboxed Linux execution world and makes it a promotion blocker; DSH ships the providers; this machine has... | **OPEN** |
| `G-SEAM-29` | 118 | RETRACTED. The kernel's working directory is CORRECT. My earlier claim that it was the scratch dir was a STALE-BUILD artifact,... | **RETRACTED** |
| `G-SEAM-30` | 119 | The repository did not contain `packages/dsh-ipython/` at all — the whole package, sources included, was untracked for the enti... | **RESOLVED** |
| `G-SEAM-31` | 120 | Nothing in the product creates a run, so the model cannot start any child work at all — the `work` tool throws before it can ad... | **RESOLVED** |
| `G-SEAM-32` | 121 | `SandboxedFileSystem` EXTENDS `LocalFileSystem`, so the fs swap removes exactly ONE thing — the containment check — and T2's co... | **RESOLVED** |
| `G-SEAM-33` | 122 | The composed profile's `sandboxPolicy.defaultMode` is `workspace-write`, not `danger-full-access` — so the model is told a fals... | **RESOLVED** |
| `G-SEAM-34` | 123 | The IPython native-tool bridge (`bridge.ts`, `native-call.ts`) is outside the transitive closure of every package entry point —... | **RESOLVED** |
| `G-SEAM-35` | 124 | Parallel agents sharing one working tree damaged each other's git state four times: a `git reset --hard` orphaned a commit, a `... | **RESOLVED** |
| `G-SEAM-36` | 125 | RETRACTED. `KernelService.restart()` works correctly when the Session cwd differs from the kernel root. | **RETRACTED** |
| `G-SEAM-37` | 126 | Three of ten broadcast messages were mis-addressed to the wrong agent, and every one was caught by the receiving agent rather t... | **RESOLVED** |
| `G-SEAM-38` | 127 | T6's IPY gate labels COLLIDE with the spec's IPY case ids, so a reader who maps by label gets the wrong oracle for at least two... | **RESOLVED** |
| `G-SEAM-39` | 128 | A restart after `status()` calls have landed during a running cell times out, and the candidate cause is outstanding shell wait... | **OPEN** |
| `G-SEAM-40` | 129 | Two of the six observation-gap stages are vocabulary members with ZERO production producers, so the loss they name cannot occur... | **RESOLVED** |
| `G-SEAM-41` | 130 | A page cursor is refused across a different REVISION but NOT across a different STORE, and the served bytes can hash differentl... | **RESOLVED** |
| `G-SEAM-42` | 131 | The spec is a SHARED MUTABLE FILE that nine agents file verdicts into, and an uncommitted filing was lost once. | **RESOLVED** |
| `G-SEAM-43` | 132 | Two different `epoch` fields are conflated by a careless read: the KERNEL epoch advances on kernel death and is reachable, whil... | **OPEN** |
| `G-SEAM-44` | 133 | `kernel-lifecycle.ts` is itself unreachable, so three RECOVERY cases that PASS are statements about a mechanism rather than abo... | **OPEN** |
| `G-SEAM-45` | 134 | Concurrent `drain` callers all resume together, all observe the same deficit, and ALL ADMIT — over-admitting past the target wh... | **RESOLVED** |
| `G-SEAM-46` | 135 | Two oracles in the pinned spec CONTRADICT each other, because the spec was authored 19 minutes before the composition change th... | **OPEN** |
| `G-SEAM-47` | 136 | One of 223 `@deepseek-ai/*` specifiers resolves from `src/` rather than `lib/` on a real boot of the built launcher, so the mod... | **SUPERSEDED** |
| `G-SEAM-48` | 137 | `tsconfig.json` MISSES type errors that `tsconfig.check.json` catches, and the project's own gate depends on the stricter one. | **RESOLVED** |
| `G-SEAM-49` | 138 | The pinned DSH checkout's git tree is NOT clean, so `ID-06`'s "HEAD matches and the tree is clean" cannot hold. | **SUPERSEDED** |
| `G-SEAM-50` | 139 | `CMP-06`'s protection of the sandbox policy is UNREACHABILITY, not immutability — measured, host code calling `setPolicy` does... | **OPEN** |
| `G-SEAM-51` | 140 | `CMP-14`'s recorded arguments name the profile by REPOSITORY DIRECTORY rather than install name, and there is no launcher-side... | **OPEN** |
| `G-SEAM-52` | 141 | The ported web-search provider is MOUNTED but NOT SELECTED: `ctx.web.search()` reaches a different backend than the one this pr... | **OPEN** |
| `G-SEAM-53` | 142 | No version IDENTITY across the research chain: nothing establishes that a fetched page is the same version as the search row th... | **OPEN** |
| `G-SEAM-54` | 143 | The bridge route has NO disposition vocabulary: it drains the lease but records no per-call disposition, while the scope route... | **RESOLVED** |
| `G-SEAM-58` | 144 | The `as never` idiom used 478 times in tests and 10 times in non-test files is UNNECESSARY, and one of its two forms was maskin... | **OPEN** |
| `G-SEAM-59` | 145 | The kernel connection file is created in the SYSTEM TEMP directory, whose ACL is wider than the file's own — while the file car... | **OPEN** |
| `G-SEAM-60` | 146 | Round-1 writer isolation VERIFIED: all ten writers build and resolve their OWN worktree, so no measurement in this round is of... | **VERIFIED** |
| `G-SEAM-61` | 147 | 22 of the 38 qualification runners hardcode an ABSOLUTE output path into the MAIN checkout, so running one from a worktree writ... | **OPEN** |
| `G-SEAM-62` | 148 | The pinned checkout's three dirty entries are now ONE, and the remaining one is a line-ending artifact with an identical blob i... | **PARTIAL** |
| `G-SEAM-63` | 149 | A recovered host that did not call `createRun` has NO launch port, so draining a recovered run quarantines every task. | **OPEN** |
| `G-SEAM-64` | 150 | `defaultArtifactRoot` reads a `root` member the mounted `storageDomain` does not have, so the artifact store always falls back... | **DUPLICATE** |
| `G-SEAM-65` | 151 | Changing the deployment default does NOT migrate existing sessions: all 76 session logs that carry a sandbox-mode event carry `... | **OPEN** |
| `G-SEAM-66` | 152 | Two writers regenerated the SAME evidence files from their own worktrees, so the integrated tree will hold two mutually-inconsi... | **OPEN** |
| `G-SEAM-67` | 153 | `authorizeRun`'s idempotence was a check-then-act race, and the derived run id made it STRICTLY WORSE than a duplicate — measur... | **FIXED** |
| `G-SEAM-68` | 154 | The product can enter a state it has no path to leave: a task is written `unknown` on the drain path, and nothing can move it out. | **OPEN** |
| `G-SEAM-69` | 155 | Three v1 evidence hashes are CRLF digests that a fresh checkout cannot reproduce, so `G-EVIDENCE-HASHES` FAILS on a correct art... | **OPEN** |
| `G-SEAM-70` | 156 | A web provenance observation id is a function of `(url, acquiredAt)` only, so two observations of one url within the same milli... | **OPEN** |
| `G-SEAM-71` | 157 | The `dsh.data` plane's byte accounting is MEASURED, and the three defects it found while measuring are the reason the numbers c... | **VERIFIED** |
| `G-SEAM-72` | 158 | F2 is closed at the COMPOSITION tier, and the first real boot found a defect that 17 passing code-path tests could not: the ser... | **VERIFIED** |
| `G-SEAM-73` | 159 | A hand-picked state list in a verification test omitted the one state that mattered, so the oracle confirmed the sentence it wa... | **OPEN** |
| `G-SEAM-74` | 160 | `ID-01`'s graph clause is CLOSED: a real built-launcher boot now resolves every `@deepseek-ai/*` specifier under a `lib/` tree,... | **FIXED** |
| `G-SEAM-55` | 161 | `dsh-ipython`'s bundle patch hardcoded ONE checkout's absolute paths, so a second checkout of this repository silently ran the... | **FIXED** |
| `G-SEAM-56` | 162 | `link-all-dsh.ps1` — the DOCUMENTED procedure for recreating an install — produced an install that could not build. | **FIXED** |
| `G-SEAM-57` | 163 | A provisioning check that greps a config dump for a path tests an implementation detail, and it FAILED ON A CORRECT TREE. | **FIXED** |
| `G-FIX-09` | 164 | The B02 replacement probe reported every peer as both "unresolvable" and a "source copy". | **RESOLVED** |
| `G-FIX-10` | 165 | The `tsconfig.check.json` `paths` map is a workaround for an upstream resolution trap, and the entry that explains it was LOST... | **RESOLVED** |
| `G-FIX-11` | 166 | The recorded deployment identity had gone stale, and one of its inputs was corrupted by Python escape processing. | **RESOLVED** |
| `G-FIX-12` | 167 | The deliverable profile mounted neither extension's tool row, and its preset root was cwd-dependent. | **RESOLVED** |
| `G-FIX-13` | 168 | My own `ctx.baseUrl` preset-root fix was wrong on Windows, and my first verification of it was contaminated. | **RESOLVED** |
| `G-TODO-01` | 174 | Terminal (`ctx.terminals`) exact signatures and Windows shell backends. | **IN_PROGRESS** |
| `G-TODO-02` | 175 | `ctx.terminalController` privilege claim — needs a source quote. | **IN_PROGRESS** |
| `G-TODO-03` | 176 | PTC runtime public interface and backend publication status. | **IN_PROGRESS** |
| `G-TODO-04` | 177 | storageDomain interface, purity of `update`, single-writer enforcement. | **IN_PROGRESS** |
| `G-TODO-05` | 178 | Goal `disarm` vs `pause`/`complete` exact semantics. | **IN_PROGRESS** |
| `G-TODO-06` | 179 | Profile/preset loading, composition order, patch `config` replacement. | **IN_PROGRESS** |
| `G-TODO-07` | 180 | Tool authoring protocol, `guard`, waterfall vs serial events. | **IN_PROGRESS** |
| `G-TODO-08` | 181 | Sandbox availability on Windows. | **IN_PROGRESS** |
| `G-TODO-09` | 182 | Whether the zloop web-search dual-lane layer can be ported as a DSH plugin. | **RESOLVED** |
| `G-EXT-01` | 188 | No confirmed live-provider budget authorization. | **BLOCKED_EXTERNAL** |
| `G-EXT-02` | 189 | A model API key being present does not authorize large paid evaluation. | **BLOCKED_EXTERNAL** |
