/**
 * Encode backup entries in the RisuAI .bin format.
 *
 * Binary format per entry:
 *   [nameLength: UInt32LE][name: UTF-8][dataLength: UInt32LE][data: bytes]
 */

export function encodeBackupEntry(name: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf-8')
  const buf = Buffer.alloc(4 + nameBytes.length + 4 + data.length)
  buf.writeUInt32LE(nameBytes.length, 0)
  nameBytes.copy(buf, 4)
  buf.writeUInt32LE(data.length, 4 + nameBytes.length)
  data.copy(buf, 4 + nameBytes.length + 4)
  return buf
}

export function encodeBackup(entries: Array<{ name: string; data: Buffer }>): Buffer {
  return Buffer.concat(entries.map(e => encodeBackupEntry(e.name, e.data)))
}

export function encodeRisuSaveBlocks(blocks: Array<{
  type: number; name: string; data: Buffer; compressed?: boolean
}>): Buffer {
  return Buffer.concat([
    Buffer.from('RISUSAVE\0'),
    ...blocks.map(({ type, name, data, compressed = false }) => {
      const nameBytes = Buffer.from(name)
      const header = Buffer.alloc(7 + nameBytes.length)
      header[0] = type
      header[1] = Number(compressed)
      header[2] = nameBytes.length
      nameBytes.copy(header, 3)
      header.writeUInt32LE(data.length, 3 + nameBytes.length)
      return Buffer.concat([header, data])
    }),
  ])
}
