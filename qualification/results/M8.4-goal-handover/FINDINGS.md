=== M8.4: Goal handover (C14) ===

THE PROBLEM: DSH's Goal is two things at once - a durable objective AND an
independent round driver that auto-continues an idle agent. A managed work run
is ALSO a continuation driver, because it wakes the root when a child settles.
Two drivers on one root is a double-continuation loop.

THE RESOLUTION, and why it is the mildest available
(packages/goal/goal/src/index.ts:282-294):
  'Remove process-local continuation authority without changing durable goal'
  'phase or revision. Lifecycle owners use this before unloading a driver;'
  'a later human-authorized resume records the new activation edge.'
  disarm(agent) { this.setActivation(agent.session, 'disarmed') }

So disarm touches ONLY process-local activation. It does not clear the
objective, does not bump the revision, and does not fake completion.

PROVEN against the REAL Goal service:
  - with no Goal service mounted it is a complete, honest no-op with a reason,
    not a throw
  - with no current goal it is a no-op with a reason
  - objectivePreserved is true AND revisionUnchanged is true, read back from
    the service rather than trusted from the handover object
  - the phase stays ACTIVE, not completed and not blocked. A deployment that
    faked completion here would be lying about the objective.
  - the objective remains readable after the handover
  - ANOTHER ROOT IS UNTOUCHED: still armed, same objective, same revision.
    That is what stops this being a global switch.
  - idempotent: taking continuation twice leaves the same revision
  - a later resume WORKS and advances the revision, so the handover is
    reversible by a human and is a recorded authorization edge

WHAT IS NOT DONE: nothing here re-arms the goal on unload. The plan requires
that a re-take be a new authorization, so this project deliberately does not
restore a previous armed state automatically.
