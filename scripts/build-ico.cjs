// 将多尺寸 PNG 打包为 ICO（PNG-in-ICO，Windows Vista+ 支持）
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const genDir = path.join(root, 'build', 'icon-gen')
const outFile = path.join(root, 'build', 'icon.ico')

// 尺寸从大到小，256 用 0 表示
const sizes = [256, 128, 64, 48, 32, 16]

const images = sizes.map((s) => {
  const data = fs.readFileSync(path.join(genDir, `icon_${s}.png`))
  return { size: s, data }
})

// ICONDIR
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)   // reserved
header.writeUInt16LE(1, 2)   // type: icon
header.writeUInt16LE(images.length, 4)

// ICONDIRENTRY 列表
const entries = Buffer.alloc(images.length * 16)
let offset = 6 + images.length * 16
images.forEach((img, i) => {
  const p = i * 16
  entries.writeUInt8(img.size >= 256 ? 0 : img.size, p)      // width
  entries.writeUInt8(img.size >= 256 ? 0 : img.size, p + 1)  // height
  entries.writeUInt8(0, p + 2)                               // colorCount
  entries.writeUInt8(0, p + 3)                               // reserved
  entries.writeUInt16LE(1, p + 4)                            // planes
  entries.writeUInt16LE(32, p + 6)                           // bitCount
  entries.writeUInt32LE(img.data.length, p + 8)              // bytesInRes
  entries.writeUInt32LE(offset, p + 12)                      // imageOffset
  offset += img.data.length
})

fs.writeFileSync(outFile, Buffer.concat([header, entries, ...images.map((i) => i.data)]))
console.log(`Wrote ${outFile} (${images.length} sizes, ${offset} bytes)`)
