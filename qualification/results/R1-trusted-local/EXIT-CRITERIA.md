# R1 — exit criteria, as measured

Every line below names the exact artifact that carries the measurement. Nothing
here is asserted from source alone.

## EC-1 — the guard fails LOUD when the mode is not full access

| boundary | how it was reached | artifact | verdict |
|---|---|---|---|
| `startup` | a real boot of the composed daily profile with the profile's `sandbox-policy` mode reverted to `workspace-write`, **no probe in the tree** | `loudness-after-fix.json` | **LOUD.** The violating entry is named on stderr under `warning: 1 entry did not activate`, with the failing check id (`startup.sandboxPolicy.mode`) and the observed mode (`'workspace-write'`). The healthy control produced empty stderr, so the two are distinguishable. |
| `session-resume` | two real boots: one seeds a session with a real `sandbox/mode` event, the second calls the product's own `ctx.sessionController.resolveAgent(sessionId)` on a fresh process | `session-resume-boundary.json` | **REFUSED.** `resume failed for session …: trusted-local contract violated at the session-resume boundary: 2 check(s) failed` (`session.override`, `narration.sandbox-policy`). `agentLiveAfter: false` — the resume did not proceed. |
| `ptc-execution` | a real `ctx.tools.execute({ name: 'workflow', … })` through the live registry | `negative-arm-correct-deployment.json` (`ptc.guardRefusal`) | **REFUSED.** `"REFUSED by the contract guard"`, with the message naming the resolved mode, the default mode and the session override. |

## EC-2 — CMP-02's oracle satisfied by a MEASURED boot

`composition-after.json` (and re-confirmed after the wiring fix as
`composition-after-fixed.json`):

- `declared.rowPresent: true` — the row is present, not deleted;
- `declared.configAsComposed.mode: "danger-full-access"` — the configured mode is
  the trusted-local value, and it is a LITERAL rather than an unresolved `!!js`
  expression (contrast `composition-before.json`, which recorded
  `{"__jsExpr": "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'"}`);
- `effective.workspaceRoot: "C:\Windows\Temp"` — absolute;
- `narration.sandboxPolicyContextText`: *"Current DSH file policy:
  danger-full-access. The DSH file sandbox does not restrict file modifications by
  available operations."* — the model-facing half, read from a real
  `ctx.systemPrompt.assemble()`;
- `contract.ok: true`, `contract.violations: []`.

The before/after pair is `composition-before.json` vs `composition-after.json`,
measured on real boots of the same profile.

## EC-3 — the negative arm

- `negative-arm-reverted-profile.json` (RE-MEASURED after the wiring fix, so its
  arm A reads differently from the pre-fix copy and both readings are correct):
  - `startup.serviceAbsentBecauseEntryFailed: true` — `ctx.noSandboxContract` is
    **not published**, because the guard's own entry failed at `apply`. That is
    the LOUD outcome, not a missing reading, and the artifact says so in its
    `note` rather than leaving a bare `null` for a reader to interpret.
  - `startup.bootEvidence.guardEntryNamedOnStderr: true`,
    `refusalTextOnStderr: true`, `activationWarningLine: "warning: 2 entries did
    not activate"` — the driver merges the boot's own stderr into the artifact, so
    "the guard refused and its entry died" cannot be confused with "the guard
    never ran".
  - `session.checkObserved` records `overrideOf = 'workspace-write'` with
    `resolve()` returning the same, and `modeWasRestored` records that the arm
    deliberately did NOT restore the default.
- `loudness-after-fix.json`: the same reverted mode, booted with **no probe**, is
  named on stderr with the failing check id and the observed mode — the half the
  negative-arm probe cannot show, because its own `probe-complete` throw also
  appears there. The healthy control's stderr is empty, so the two are
  distinguishable.
- `wire-candidates3.json`: the two loud wiring shapes, each with a healthy
  control, on a real boot.
- `negative-arm-correct-deployment.json` (the CONTROL arm, post-fix):
  `startup.reportOk: true` with no violations on the correct deployment — the
  guard does not cry wolf — while the deliberately-confined session in the same
  artifact still trips `session.override` and the PTC guard still refuses
  `workflow` with the full explanation.

## EC-4 — PTC / `run_code` / `workflow-ptc` are NOT removed

- `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` still
  contains `workflow-ptc` and `tool-workflow`; the file's own comment block
  records the dependency chain and what must be verified before removal.
- `composition-after.json`: `ptc.runtimePresent: true`, `runtimeName:
  "NodePtcRuntime"`, `sandboxMode: "danger-full-access"`, and the model surface
  includes `workflow`. `run_code` is absent — the shipped state, unchanged.

## The defect found while producing this file

The `startup` boundary was **SILENT** before this fix. It was written as
`ctx.inject(['sandboxPolicy'], cb)` with the returned fiber discarded; a throw
inside a discarded CHILD fiber leaves the ENTRY's fiber `ACTIVE`, and DSH's
activation audit classifies by the entry's fiber. Measured with no probe in the
tree, the reverted deployment produced **the same empty stderr as the healthy
control** (`loudness-verdict.json`, `diagnosis: "SILENT"`).

`no-sandbox-contract.ts` now runs the check in `apply`'s own async body, after a
BOUNDED wait for `sandboxPolicy` (the bound is measured: the service was readable
193 ms after `apply` started — `mount-latency.json`). Two unit cases pin the
shape so a later edit cannot silently restore it, and the bounded-wait
requirement is pinned because an `apply` that never resolves suppresses the
activation audit for EVERY entry (`wire-candidates2.json` measured that).
