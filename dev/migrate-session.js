// Migrate a session log to a different project cwd by copying (option A: keep original).
// Rewrites ONLY the header frame's `cwd`; all event frames are byte-identical.
// Usage: node migrate-session.js <src.jsonl.zstd> <newCwd> <dest.jsonl.zstd>
const { zstdDecompressSync, zstdCompressSync, constants } = require('node:zlib')
const fs = require('fs')
const path = require('path')

const ZSTD_MAGIC = 0xfd2fb528
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt: reserved frame-header bit at ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt: reserved block type at ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

async function main() {
  const [src, newCwd, dest] = process.argv.slice(2)
  if (!src || !newCwd || !dest) {
    console.error('usage: node migrate-session.js <src> <newCwd> <dest>')
    process.exit(2)
  }

  const buf = fs.readFileSync(src)
  const { frames, tornStart } = scanZstdFrames(buf)
  if (tornStart !== undefined) throw new Error('torn/incomplete frame; refusing to migrate')
  if (frames.length < 1) throw new Error('no frames found')

  // Decode header frame 0, change cwd, re-encode
  const headerPlain = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
  const header = JSON.parse(headerPlain)
  if (typeof header.cwd !== 'string') throw new Error('header has no cwd; not a session log?')
  const oldCwd = header.cwd
  header.cwd = newCwd
  const newHeaderPlain = JSON.stringify(header) + '\n'
  const newHeaderFrame = zstdCompressSync(Buffer.from(newHeaderPlain, 'utf8'), CHECKSUM_OPTIONS)

  // Concatenate: new header frame + byte-identical event frames
  const parts = [newHeaderFrame]
  for (let i = 1; i < frames.length; i++) {
    parts.push(buf.subarray(frames[i].start, frames[i].end))
  }
  const out = Buffer.concat(parts)

  // Ensure dest dir, then write
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, out)

  // Verify
  const re = scanZstdFrames(fs.readFileSync(dest))
  const reHeader = JSON.parse(zstdDecompressSync(fs.readFileSync(dest).subarray(re.frames[0].start, re.frames[0].end)).toString('utf8'))
  console.log('OK')
  console.log('old cwd:', oldCwd)
  console.log('new cwd:', reHeader.cwd)
  console.log('id unchanged:', reHeader.id === header.id)
  console.log('createdAt unchanged:', reHeader.createdAt === header.createdAt)
  console.log('orig frames:', frames.length, '-> dest frames:', re.frames.length)
  console.log('dest size:', fs.statSync(dest).size)
  console.log('dest path:', dest)
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
