/**
 * The bounded framing, tested without a kernel.
 *
 * WHY THIS DESERVES ITS OWN FILE. The framing is the layer that stands between a
 * hostile or merely careless peer and the other side's memory. Requirement 10's
 * "must not OOM the host" is only partly about cell output: a peer that declares a
 * 4 GB frame would OOM a reader that trusted the prefix, and no cell-level cap
 * would help. The decoder therefore rejects the CLAIM before waiting for the
 * bytes, and this file proves that ordering rather than describing it.
 */
import { describe, expect, it } from 'vitest'
import {
  asBrokerMessage,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
} from './protocol.ts'

/** Collect frames from a decoder plus whatever it failed with. */
function collector() {
  const frames: unknown[] = []
  const errors: FrameError[] = []
  const decoder = new FrameDecoder(
    value => { frames.push(value) },
    error => { errors.push(error) },
  )
  return { decoder, frames, errors }
}

describe('bounded framing', () => {
  it('round-trips a message', () => {
    const { decoder, frames } = collector()
    decoder.push(encodeFrame({ hello: 'world', n: 1 }))
    expect(frames).toEqual([{ hello: 'world', n: 1 }])
  })

  it('reassembles a frame split across arbitrary chunk boundaries', () => {
    const { decoder, frames } = collector()
    const frame = encodeFrame({ text: 'a'.repeat(1000) })
    // One byte at a time: the worst case a stream reader can be handed.
    for (const byte of frame) decoder.push(Buffer.from([byte]))
    expect(frames).toEqual([{ text: 'a'.repeat(1000) }])
  })

  it('decodes several frames delivered in one chunk', () => {
    const { decoder, frames } = collector()
    decoder.push(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]))
    expect(frames).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('rejects an oversized frame on the DECLARED length, without buffering it', () => {
    const { decoder, frames, errors } = collector()
    // A header claiming far more than the limit, and no payload at all. A decoder
    // that read first and checked later would wait for 4 GB here.
    const header = Buffer.alloc(FRAME_HEADER_BYTES)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    decoder.push(header)
    expect(frames).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('exceeds')
    expect(decoder.failed).toBe(true)
  })

  it('refuses to encode a value that exceeds the limit', () => {
    expect(() => encodeFrame({ text: 'x'.repeat(MAX_FRAME_BYTES + 10) }))
      .toThrow(FrameError)
  })

  it('stops permanently after a consumer failure instead of misaligning', () => {
    let calls = 0
    const errors: FrameError[] = []
    const decoder = new FrameDecoder(
      () => {
        calls += 1
        throw new Error('consumer exploded')
      },
      error => { errors.push(error) },
    )
    decoder.push(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]))
    // The consumer was called once and then the decoder stopped: delivering the
    // second frame to a handler that already rejected the first would be worse
    // than stopping.
    expect(calls).toBe(1)
    expect(errors).toHaveLength(1)
    expect(decoder.failed).toBe(true)
  })

  it('rejects a payload that is not valid JSON', () => {
    const { decoder, errors } = collector()
    const payload = Buffer.from('{not json', 'utf8')
    const header = Buffer.alloc(FRAME_HEADER_BYTES)
    header.writeUInt32BE(payload.byteLength, 0)
    decoder.push(Buffer.concat([header, payload]))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('not valid JSON')
  })
})

describe('broker message shape', () => {
  it('accepts a well-formed reply and preserves the id', () => {
    const message = asBrokerMessage({ type: 'reply', id: 'abc', ok: true, result: { n: 1 } })
    expect(message).toEqual({ type: 'reply', id: 'abc', ok: true, result: { n: 1 } })
  })

  it('requires a non-empty id, so a reply cannot be matched to nothing', () => {
    expect(() => asBrokerMessage({ type: 'reply', id: '', ok: true })).toThrow(FrameError)
    expect(() => asBrokerMessage({ type: 'reply', ok: true })).toThrow(FrameError)
  })

  it('accepts a late_output event and defaults missing fields rather than throwing', () => {
    const message = asBrokerMessage({ type: 'event', event: 'late_output', epoch: 3 })
    expect(message).toEqual({ type: 'event', event: 'late_output', epoch: 3, cellId: '', text: '' })
  })

  it('rejects an event with no epoch, because it cannot be attributed to a generation', () => {
    expect(() => asBrokerMessage({ type: 'event', event: 'late_output' })).toThrow(FrameError)
  })

  it('rejects an unknown type instead of guessing', () => {
    expect(() => asBrokerMessage({ type: 'nonsense' })).toThrow(FrameError)
    expect(() => asBrokerMessage('a string')).toThrow(FrameError)
    expect(() => asBrokerMessage(null)).toThrow(FrameError)
  })
})
