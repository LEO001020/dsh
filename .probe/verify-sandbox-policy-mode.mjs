/**
 * What does the composed profile's sandbox POLICY actually say, and does the
 * model get told it?
 *
 * T5 measured `sandboxPolicy.defaultMode === 'workspace-write'` on the composed
 * profile, while the architecture claims no confinement. Two consequences are
 * claimed in source and measured here:
 *   (a) the system prompt carries a "Current DSH file policy: workspace-write"
 *       line -- a statement about the model's own authority;
 *   (b) PTC confines unless mode is exactly 'danger-full-access'.
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-sandbox-policy-mode'
export const inject = ['sessionController']
const OUT = process.env.DSH_PROBE_OUT ?? 'D:/DSH/work/dsh-native-daily/qualification/results/ROOT-verification/sandbox-policy-mode.json'

export async function apply(ctx) {
  const f = { probe: 'verify-sandbox-policy-mode' }
  try {
    const policy = ctx.get('sandboxPolicy')
    f.sandboxPolicyPresent = policy !== undefined
    if (policy !== undefined) {
      f.defaultMode = policy.defaultMode ?? null
      // The resolution the PTC path performs: what does a call with no explicit
      // mode and no session override resolve to?
      try {
        const resolved = policy.resolve?.({})
        f.resolveNoArgs = resolved === undefined ? null : { mode: resolved.mode ?? null, workspaceRoot: resolved.workspaceRoot ?? null }
      } catch (error) {
        f.resolveNoArgsError = String(error && error.message ? error.message : error)
      }
    }
    // The prompt line the policy contributes. `describe` is the function at
    // sandbox-policy/src/index.ts:45-49; if it is not exposed, say so rather
    // than guessing the text.
    f.policyDescribeExposed = typeof policy?.describe === 'function'
    if (typeof policy?.describe === 'function') {
      f.describeWorkspaceWrite = policy.describe({ mode: 'workspace-write', workspaceRoot: 'X:/ws' })
    }
    // The sandbox service itself: does it exist, and what does it say?
    const sandbox = ctx.get('sandbox')
    f.sandboxPresent = sandbox !== undefined
    if (sandbox !== undefined) f.sandboxModeGetter = typeof sandbox.mode === 'function' ? String(sandbox.mode()) : String(sandbox.mode ?? null)
  } catch (error) {
    f.error = String(error && error.message ? error.message : error)
  }
  writeFileSync(OUT, JSON.stringify(f, null, 1))
  throw new Error('probe-complete')
}
