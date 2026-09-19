/**
 * Which link in the kernel-cwd chain drops the value?
 *
 * G-SEAM-29 measured the SYMPTOM: a cell's os.getcwd() is the scratch dir, not
 * the Session root. The source at every link looks correct, so this probe
 * measures the LINKS rather than re-reading them:
 *   1. what the plugin computed (kernelWorkingDirectoryFor)
 *   2. what the broker process actually received in its environment
 *   3. what the kernel process reports as its cwd
 *   4. whether the host believes the guarantee is in force (kernelCwdEnforced)
 */
import { writeFileSync } from 'node:fs'

export const name = 'verify-kernel-cwd-chain'
export const inject = ['sessionController', 'ipython']
const OUT = process.env.DSH_PROBE_OUT ?? 'D:/DSH/work/dsh-native-daily/qualification/results/ROOT-verification/kernel-cwd-chain.json'

export async function apply(ctx) {
  const f = { probe: 'verify-kernel-cwd-chain', steps: [] }
  try {
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: 'D:/DSH/work/dsh-native-daily' })
    const sessionId = created?.sessionId ?? created?.id ?? null
    f.sessionId = sessionId
    f.sessionCwdRequested = 'D:/DSH/work/dsh-native-daily'
    const agent = ctx.get('agents')?.get(sessionId)
    f.agentFound = agent !== undefined
    // (1) What the AGENT's session header actually carries. This is what
    //     kernelWorkingDirectoryFor() reads, so if it is empty the fallback is
    //     this.config.root and the scratch dir is the wrong answer by design.
    f.agentSessionCwd = agent?.session?.header?.cwd ?? null
    const svc = ctx.get('ipython')
    // (2)(3) Run one cell that reports everything the KERNEL can see.
    const cell = await svc.runCell(agent, [
      'import os, json',
      'print("CWD=" + os.getcwd())',
      'print("ENV_KERNEL_CWD=" + str(os.environ.get("DSH_IPYTHON_KERNEL_CWD")))',
      'print("ENV_KERNEL_DIR=" + str(os.environ.get("DSH_IPYTHON_KERNEL_DIR")))',
    ].join('\n'))
    f.cellOutcome = cell?.outcome ?? null
    f.cellStdout = cell?.stdout?.text ?? null
    // (4) The host's own view of whether cwd was enforced.
    const status = typeof svc.kernelStatus === 'function' ? await svc.kernelStatus(agent) : undefined
    f.kernelStatus = status === undefined ? null : JSON.parse(JSON.stringify(status))
  } catch (error) {
    f.error = String(error && error.message ? error.message : error)
  }
  writeFileSync(OUT, JSON.stringify(f, null, 1))
  throw new Error('probe-complete')
}
