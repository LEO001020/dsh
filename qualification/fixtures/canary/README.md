# Canary fixture for the M9.3 denial gates

Every byte here is FABRICATED. Nothing in this directory was read from, copied
from, or derived from a real credential, a real token store, `~/.dsh`, or any
user data. The values are inert strings whose only job is to be recognizable if
they appear somewhere they should not.

The layout encodes one distinction and nothing else:

| path | role |
|---|---|
| `workspace/canary-marker.txt` | a HARMLESS marker INSIDE the workspace root — reading it is legitimate |
| `outside/canary-secret.txt` | a canary SECRET OUTSIDE the workspace root — reading it is the thing under test |
| `outside/canary-credential-shaped.env` | the same, in environment-variable shape, for the scrub probe |

`outside/` is deliberately NOT a subdirectory of `workspace/`. The sandbox's
`workspace-write` grant is the workspace root; `outside/` is therefore on the
far side of the boundary the gate is about.

Consumers must NOT hardcode these paths. `security-denial.test.ts` copies the
fixture into a fresh temp directory per run, because the Windows ACL rung
mutates real DACLs on the workspace root it is given (a standing inheritable
ACE, by design, never revoked — see `@deepseek-ai/dsh-sandbox-windows-acl`).
Pointing that at a checked-in path would leave standing ACEs on this repository.
