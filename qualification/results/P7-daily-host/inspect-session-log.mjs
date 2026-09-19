/**
 * Read-only inspection of a persisted session log: dump the events that carry a
 * given marker, so a FINDINGS claim can quote the real record instead of a
 * boolean. Prints KEY/VALUE pairs only; no credentials are read or printed.
 *
 * Usage: node inspect-session-log.mjs <sessionsRoot> [marker]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
const marker = process.argv[3] ?? 'MISSING_CREDENTIAL'

/** Decompress a concatenated-frame zstd log, frame by frame. */
function decompressZstdFrames(raw) {
  const ZSTD_MAGIC = 0xFD2FB528
  let text = ''
  let offset = 0
  while (offset < raw.length) {
    const start = offset
    if (raw.length - offset < 4) return text
    if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) return text
    offset += 4
    if (offset === raw.length) return text
    const descriptor = raw.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (raw.length - offset < remainingHeaderBytes) return text
    offset += remainingHeaderBytes
    for (;;) {
      if (raw.length - offset < 3) return text
      const blockHeader = raw.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (raw.length - offset < payloadBytes) return text
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (raw.length - offset < 4) return text
      offset += 4
    }
    try {
      text += zstdDecompressSync(raw.subarray(start, offset)).toString()
    } catch { return text }
  }
  return text
}

const logs = []
for (const dir of readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const inner = join(root, dir.name)
  let subs = []
  try { subs = readdirSync(inner, { withFileTypes: true }) } catch { continue }
  for (const s of subs) {
    if (!s.isDirectory()) continue
    const file = join(inner, s.name, 'session.v3.jsonl.zstd')
    if (existsSync(file)) logs.push(file)
  }
}

console.log(`logs_found: ${logs.length}`)
for (const file of logs) {
  const text = decompressZstdFrames(readFileSync(file))
  const records = text.split('\n').filter(l => l.trim() !== '')
  const types = {}
  for (const line of records) {
    try { const r = JSON.parse(line); types[r.type] = (types[r.type] ?? 0) + 1 } catch { /* skip */ }
  }
  console.log(`\n=== ${file} ===`)
  console.log(`records: ${records.length}`)
  console.log(`event_types: ${JSON.stringify(types)}`)
  const hits = records.filter(l => l.includes(marker))
  console.log(`records_containing_${marker}: ${hits.length}`)
  for (const hit of hits.slice(0, 4)) {
    try {
      const r = JSON.parse(hit)
      console.log(`  type=${r.type}`)
      console.log(`  data=${JSON.stringify(r.data ?? r).slice(0, 700)}`)
    } catch { console.log(`  raw=${hit.slice(0, 300)}`) }
  }
}
