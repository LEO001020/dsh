=== M5.1: measured security boundaries (E02 / E04 / E05) ===

METHOD: read the SHIPPED compositions and the resolved graphs. No claim below is
inferred from a tool name; each is a row in a real file or a real dump.

--- E02: the human Web terminal is NOT reachable from the agent preset ---

The human terminal controller IS mounted, at HOST level in the web profile:
  packages/bundle/web-app/cordis.patch.yml -> id: terminal-controller
    name: '@deepseek-ai/dsh-api-terminal-controller'
Confirmed in the resolved web graph:
  425:- id: terminal-controller
  426:  name: '@deepseek-ai/dsh-api-terminal-controller'

It is NOT present in the headless profile's resolved graph (grep for
'terminal' returns nothing). So it is a web-surface host row, not an agent tool.

The shipped STANDARD agent preset mounts NO terminal tools at all. Its tool
rows are: tool-bash, tool-pwsh, tool-fs, tool-fs-search, tool-jobs, tool-skill,
tool-goal, tool-subagent*, tool-workflow, tool-ralph, tool-ask-user, tool-todo,
tool-web, present, tool-plugin-manager. There is no terminal_open / terminal_send.

Source-level reason this matters (read at this commit):
  packages/api/terminal-controller/src/index.ts:1
    'Session-owned user terminals with the execution environment's
     system-user permissions.'
  :151 'Allocate a user shell once for a caller-generated identity, without
       Agent sandbox or approval restrictions.'
  :346-351 spawns via subprocess.spawnTerminal with NO sandbox.confine call.
So wrapping that service as a model tool would be privilege escalation. This
project does not do it, and our tool surface is asserted to contain no
terminal_* name (see src/security.test.ts).

--- E04: the plugin manager is DISABLED in the shipped standard preset ---

  packages/preset/agent-presets/presets/standard/agent.cordis.yml:264
    - id: tool-plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager/tools'
      disabled: true

And when a deployment DOES enable it, the tool itself demands the top
permission mode. Its own description string (packages/boot/plugin-manager/src/tools.ts:20):
  'Every action requires danger-full-access permission or approval for this
   call. Approval does not change the session permission mode. Changes affect
   every session in this profile. ... Package installation can execute allowed
   build scripts.'

Its actions are list_plugins, list_bundles, set_plugin, set_bundle,
install_bundle, remove_bundle. This project does not enable it, and the
model is not given a path to install a plugin.

--- E05: the control files live outside the task workspace by construction ---

Layout actually in use on this machine:
  D:\DSH\work\dsh-native-daily\  <- implementation repo: lock, specs, profiles,
                                    packages. NOT a task workspace.
  D:\DSH\home\canary, canary3\    <- DSH_HOME: sessions, storages, profiles.
  D:\DSH\work\t1, t2\             <- task working directories.

The delivery plan's requirement is that a task workspace is not the control
directory. That holds here because they are different paths by construction,
and the profile that daily use boots is copied INTO the DSH_HOME rather than
read from the repo (see the canary3 setup).

--- WHAT IS NOT PROVEN, AND MUST NOT BE CLAIMED ---

1. No OS-level sandbox denial has been demonstrated on this machine.
   Windows sandboxing exists (packages/sandbox/sandbox-windows-acl, a
   WRITE_RESTRICTED-token ACL rung) but it is documented as 'partial':
   'writes are restricted; reads, network, and process visibility are NOT'.
   So E01 (credential isolation) and E06 (network egress) cannot be claimed
   as PASS from source reading alone.

2. There is NO network egress control for bash/pwsh/subprocess/PTC anywhere in
   DSH. Grepping 'egress' across packages/ and apps/ returns zero hits for the
   security term. Only web_fetch has SSRF filtering. A sandboxed command can
   reach the network in every mode, including read-only.

3. The model-to-control-plane reachability test the plan requires (a canary
   secret and a reproducible probe) has NOT been run. What is proven here is
   the SHAPE of the surface: the agent preset has no terminal_* tool and the
   plugin manager is disabled. That is necessary but not sufficient.

GATE STATUS: E02 partially evidenced (surface shape, not a live probe);
E04 evidenced for the shipped preset; E05 evidenced structurally;
E01/E06 NOT RUN because the platform boundary is 'partial' by upstream
documentation and a real denial test needs a designed fixture.
