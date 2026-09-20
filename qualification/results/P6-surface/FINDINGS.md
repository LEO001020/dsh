# P6 — the model-facing child-creation surface, before and after

**Verdict: PASS.** 22 assertions, 0 failed, 0 not-run, from one two-sided boot.
`qualification/results/P6-surface/driver.json` is the artifact; the two catalogs
beside it are the deliverable.

Command: `node qualification/results/P6-surface/p6-surface-driver.mjs`
(`--replay` re-judges recorded artifacts without booting; `--build-only`
constructs the two scratch homes and stops.)

---

## 1. The deliverable: the model tool catalog, VERBATIM

Read from a real `daily` boot's agent-keyed registry (`ctx.tools.schemas(agent)`),
not from the YAML and not as a count.

```
BEFORE (27)                              AFTER (24)
ask_user_question                        ask_user_question
create_goal                              create_goal
edit                                     edit
exit_plan_mode                           exit_plan_mode
get_goal                                 get_goal
glob                                     glob
grep                                     grep
interrupt_agent                          interrupt_agent
ipython                                  ipython
job_kill                                 job_kill
job_list                                 job_list
job_output                               job_output
list_agents                              list_agents
present                                  present
read                                     read
read_image                               read_image
send_message                             send_message
skill                                    skill
todo_write                               todo_write
update_goal                              update_goal
web_fetch                                web_fetch
web_search                               web_search
work                                     work
write                                    write
subagent            <- REMOVED
subagent_fork       <- REMOVED
workflow            <- REMOVED
```

`removed: [subagent, subagent_fork, workflow]` — `added: []`.
Both catalogs are byte-identical across two independent pairs of boots.

### FOUR ROWS, THREE TOOL NAMES — and the difference matters

Four composition rows changed enablement, all four `true -> false`, and no other
row moved (32 rows on both sides):

| row (short id) | before | after |
|---|---|---|
| `tool-subagent` | true | false |
| `tool-subagent-fork` | true | false |
| `workflow-ptc` | true | false |
| `tool-workflow` | true | false |

The catalog lost **three** names, not four. `workflow-ptc` publishes no tool of
its own — it *provides* `workflowEngine`, which `tool-workflow` injects — so the
`workflow` tool disappears when its provider does. A report claiming "four tools
removed" would be wrong by one, and a reader can check it.

### The management surface survives, and is usable

| tool | visible | parameters |
|---|---|---|
| `send_message` | yes | `agent_id`, `message` |
| `interrupt_agent` | yes | `agent_id` |
| `list_agents` | yes | `scope` |
| `work` | yes | `action`, `taskId`, `goal`, `childId` |

`send_message` and `interrupt_agent` both take `agent_id`, which is what makes
them a management surface for `WorkService`-created children rather than a stub.
The rows behind them stay `enabled: true` on **both** sides.

---

## 2. The negative test, and why the BEFORE boot is the point

The same probe, with the same arguments, through the real `ToolRuntime.execute`:

| route | BEFORE | AFTER |
|---|---|---|
| `subagent` | **executed=true** — `started subagent 74de0bbb-…` | `UNKNOWN_TOOL` |
| `subagent_fork` | **executed=true** — `started subagent b7dff2dc-…` | `UNKNOWN_TOOL` |
| `workflow` | `INVALID_ARGS` (missing `meta`) | `UNKNOWN_TOOL` |
| `subagent_codex` | `UNKNOWN_TOOL` | `UNKNOWN_TOOL` |
| `subagent_claude_code` | `UNKNOWN_TOOL` | `UNKNOWN_TOOL` |
| `ralph` | `UNKNOWN_TOOL` | `UNKNOWN_TOOL` |

On the pre-change composition a direct model-facing call **created two real
continuable children**. Without the before side, six refusals would be equally
consistent with a broken probe, a malformed argument, or a missing service; with
it, the change is what removed the routes. `workflow`'s BEFORE result is also
informative: `INVALID_ARGS` means the tool existed and its own body validated the
arguments — a stronger fact than mere visibility.

### The hidden arm

`ipython` is a **second model-facing door** into the same registry: a cell's
`dsh.call(...)` is translated by the host into `ctx.tools.execute` with
host-bound authority (`packages/dsh-ipython/src/native-call.ts:148`). A
direct-call-only probe would leave "the model reaches it from Python instead"
untested. Driven on the AFTER boot, all six routes came back `UNKNOWN_TOOL`
through the bridge too.

---

## 3. The honest boundary — MEASURED, not asserted

Removing the model-facing tools does **not** remove the capability. Read out of
the boot, on **both** sides:

| fact | BEFORE | AFTER |
|---|---|---|
| `ctx.get('subagents')` present | yes | yes |
| `startContinuable` callable | yes | yes |
| `start` callable | yes | yes |
| registered providers | `["spawn","fork"]` | `["spawn","fork"]` |
| `ctx.agents.create` callable | yes | yes |

**A reader must not conclude the substrate became unreachable.** It did not:
every seam the removed tools called is present, callable, and backed by a
registered provider. What this change removed is the **model-facing route** to
them — which is what V5 §8 asks about and all it asks about. The probe creates
nothing: presence and callability are the claim, and calling `startContinuable`
would both cost a child and change the composition the other arms measured.

---

## 4. G-SEAM-19, re-read — the cap claim

`docs/GAPS.md` G-SEAM-19 records that DSH's own `maxActiveSubagents` pool is
`rootPools = new WeakMap<Agent, ActivationPool>()`
(`continuation-activation.ts:180`) — **per root, not per host**. Two roots each
get a full pool.

**This change does not fix the per-root pool, and does not claim to.** Setting
`maxActiveSubagents: 30` sizes DSH's own continuable pool to the deployment's
physical limit; it does not make any bound host-wide. The host-wide bound is
this project's `HARD_CHILD_CAPACITY = 30` ledger gate in `capacity.ts`, which is
unchanged. G-SEAM-19 also records that a one-shot `ctx.subagents.start()`
performs no capacity check on its own path — closed for in-process children by
the `agent/created` guard (T10), still open upstream for `workflow-ptc`'s
`startChild` with respect to the *depth* ceiling.

The live loader confirms the config from the mounted composition, not the file:
`maxActiveSubagents` **10 -> 30**, `maxDepth: 1` on both sides.

---

## 5. What would make this result wrong

- **If the deployment were in PTC mode**, the catalog would not be the model's
  full surface: the registry would present only `run_code` and collapse the
  executor to match (`core/tools/src/index.ts:653-668`, `collapses()` :1330).
  A creation tool with a live row could then be reachable without appearing in
  the catalog. Measured: `run_code` is **absent from both catalogs** and no
  `tools` row in the profile patch sets a mode, so the deployment is native and
  the catalog is the whole surface. The driver asserts this
  (`deploymentIsNativeMode`), so a future flip to PTC **fails the assertion**
  rather than silently invalidating the measurement.
- **If the probe's creation-route list were incomplete.** It is written out by
  hand (six routes) rather than derived from the preset, so it can fail; but it
  is a hand list and a route nobody thought of would not be in it.
- **If the AFTER refusals came from somewhere other than the registry.** They
  carry `UNKNOWN_TOOL` from `ToolNotFoundError` (`core/tools/src/index.ts:493-507`),
  which is the registry's own "not registered" code, not a body's failure.

## 6. Claims I am not making

1. **Not** that the capability is unreachable. It is reachable from any
   in-process caller holding a `Context` (§3), and an out-of-process provider
   (`acp`, `codex`, `claude-code`, `dsh-sdk`) publishes no local Agent at all
   (`capacity.ts:69-73`).
2. **Not** that the host bound is now host-wide, or that the per-root pool was
   fixed (§4).
3. **Not** that a model turn was driven. There is no LLM in this boot; the probe
   calls the same `ctx.tools.execute` the agent loop calls, but the model's
   decision to call a tool is not exercised.
4. **Not** that the Work queue's own accounting is correct. `createRun` is not
   called and no run exists; that is a different slice's subject.
5. **Not** that the four rows are gone from the file. They are `disabled: true`,
   still declared, which is deliberate and explained in the preset's comment.
