import { describe, it } from 'vitest'
describe('candidate', () => {
  it.skip('never runs', () => { throw new Error('unreachable') })
  it.skip('also never runs', () => { throw new Error('unreachable') })
})
