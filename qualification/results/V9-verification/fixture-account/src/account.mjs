/**
 * V9 / VER-09 — is the verification environment a DIFFERENT account from the host?
 *
 * WHY THIS EXISTS. VER-09's oracle has two halves, and the second is the one that
 * is easy to skip: "Under trusted-local the verification environment runs as the
 * SAME OS user as the host, so the record must ALSO state that no privilege
 * separation between the verifier and the verified exists."
 *
 * The in-suite cases already MEASURE the consequences (a candidate child read a
 * host file outside its snapshot verbatim; a candidate child completed a real TCP
 * connection). This probe measures the CAUSE directly rather than inferring it:
 * it reports the account and the process identity from INSIDE the verification
 * child, and the runner writes that into a real receipt.
 *
 * It is deliberately tiny — one child, no loops — because the point is an
 * identity comparison, not a load test.
 */
import { userInfo } from 'node:os'
import { readFileSync } from 'node:fs'

const info = userInfo()
const report = {
  // The account the CHILD runs as, read from inside the child.
  childUser: info.username,
  childUid: info.uid,
  childGid: info.gid,
  childPid: process.pid,
  childPpid: process.ppid,
  // Windows has no getuid; recorded as absent rather than as a fabricated 0.
  childGetuid: typeof process.getuid === 'function' ? process.getuid() : null,
  platform: process.platform,
  execPath: process.execPath,
  node: process.version,
  // The environment the child inherited, so a scrubbed-name claim is visible here.
  envDshNames: Object.keys(process.env).filter(name => name.toUpperCase().startsWith('DSH_')).length,
  // Written by the fixture so the parent has something to compare against.
  parentUser: readFileSync(new URL('./parent-account.txt', import.meta.url), 'utf8').trim(),
}

console.log(JSON.stringify(report, null, 2))
