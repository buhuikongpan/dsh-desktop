const sharp = require('sharp')
const path = require('path')

const input = process.argv[2] || 'D:\\Administrator\\Pictures\\deepseek.jpg'
const outputPng = path.join(__dirname, 'icon.png')
const outputIco = path.join(__dirname, 'icon.ico')

// B/C 之间（logo 明显留白、圆角白底）：整体偏 C 一点但没到 C 那么宽
const OUTER_R = 0.21    // 白底圆角半径比例（相对整体尺寸）
const LOGO_FILL = 0.82  // logo 占边长比例，四周留白 = (1-0.82)/2 = 9%
const INNER_R = 0.16    // logo 自身圆角半径比例（相对 logo 尺寸）

function roundedSvg(size, radius) {
  return Buffer.from(
    `<svg width="${size}" height="${size}">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>
    </svg>`
  )
}

async function makeIcon(size) {
  const outerR = Math.max(2, Math.round(size * OUTER_R))
  const logoSize = Math.max(8, Math.round(size * LOGO_FILL))
  const innerR = Math.max(2, Math.round(logoSize * INNER_R))
  const off = Math.round((size - logoSize) / 2)

  // 外层白色圆角底面
  const whiteBase = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: await sharp(roundedSvg(size, outerR)).png().toBuffer(), blend: 'dest-in' }])
    .png()
    .toBuffer()

  // 内层 logo（圆角，带透明角）
  const logo = await sharp(input)
    .resize(logoSize, logoSize, { fit: 'cover' })
    .composite([{ input: await sharp(roundedSvg(logoSize, innerR)).png().toBuffer(), blend: 'dest-in' }])
    .png()
    .toBuffer()

  // logo 居中合成到白底上
  return sharp(whiteBase)
    .composite([{ input: logo, left: off, top: off }])
    .png()
    .toBuffer()
}

async function convert() {
  // 256 PNG（主窗口/进度窗预览与构建用）
  const png256 = await makeIcon(256)
  await sharp(png256).png().toFile(outputPng)
  console.log('Created icon.png (B 白边圆角)')

  // 多尺寸 ICO
  const sizes = [256, 128, 64, 48, 32, 16]
  const buffers = []
  for (const size of sizes) {
    buffers.push({ size, buf: await makeIcon(size) })
  }

  const headerSize = 6
  const dirEntrySize = 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(buffers.length, 4)

  const dirEntries = []
  let offset = headerSize + dirEntrySize * buffers.length
  for (const { size, buf } of buffers) {
    const entry = Buffer.alloc(dirEntrySize)
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(buf.length, 8)
    entry.writeUInt32LE(offset, 12)
    dirEntries.push(entry)
    offset += buf.length
  }

  const ico = Buffer.concat([header, ...dirEntries, ...buffers.map(b => b.buf)])
  require('fs').writeFileSync(outputIco, ico)
  console.log('Created icon.ico (B 白边圆角)')
}

convert().catch(console.error)
