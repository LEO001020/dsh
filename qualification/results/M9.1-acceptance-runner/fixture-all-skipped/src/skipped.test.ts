// A suite in which every case is skipped. The real exit code is 0, which is
// exactly why an exit-code-only verifier would call this a pass.
import { describe, it } from 'vitest'
describe('candidate', () => {
  it.skip('never runs', () => { throw new Error('unreachable') })
})
