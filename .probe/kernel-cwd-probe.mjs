/**
 * Does a cell's RELATIVE path resolve against the Session's project root?
 *
 * The defect this checks for is silent: a kernel rooted in a scratch directory
 * makes `open("out.csv","w")` succeed and write somewhere the model will never
 * look. No error, wrong file. So the probe compares the kernel's own os.getcwd()
 * against the Session's declared cwd, and ALSO writes a relative file and checks
 * where it landed on the host.
 */
import { writeFileSync } from 'node:fs'
export const name = 'probe-kernel-cwd'
export const inject = ['sessionController', 'ipython']
const OUT = process.env.DSH_PROBE_OUT ?? 'D:/tmp/kernel-cwd.json'
const PROJECT = 'D:/DSH/work/dsh-native-daily'
export async function apply(ctx) {
  const f = { projectRoot: PROJECT, error: null }
  try {
    const sc = ctx.get('sessionController')
    const created = await sc.create({ cwd: PROJECT })
    const agent = ctx.get('agents')?.get(created?.sessionId ?? created?.id)
    f.sessionCwd = agent?.session?.header?.cwd ?? null
    const svc = ctx.get('ipython')
    // A cell that reports its own cwd, and writes a relative file.
    const r1 = await svc.runCell(agent, 'import os; print("KERNEL_CWD=" + os.getcwd())', new AbortController().signal)
    f.cellOut = JSON.stringify(r1.output ?? r1).slice(0, 400)
    const r2 = await svc.runCell(agent, 'open(".probe-kernel-cwd-marker.txt","w").write("x")', new AbortController().signal)
    f.writeOut = JSON.stringify(r2.output ?? r2).slice(0, 300)
  } catch (e) { f.error = String(e) }
  writeFileSync(OUT, JSON.stringify(f, null, 2))
}
