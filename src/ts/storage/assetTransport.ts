import { encodeBinaryMessage, decodeBinaryMessage } from '../network/binaryMessage'

export const MAX_ASSET_BATCH_BYTES = 100 * 1024 * 1024

export interface AssetEntry {
    key: string
    value: Uint8Array
}

export function encodeAssetBatch(entries: AssetEntry[]) {
    return encodeBinaryMessage({
        entries: entries.map(({ key, value }) => ({ key, size: value.length })),
    }, entries.map(entry => entry.value))
}

export function decodeAssetBatch(message: Uint8Array): AssetEntry[] {
    const { metadata, bytes } = decodeBinaryMessage(message)
    if (!Array.isArray(metadata.entries)) throw new Error('Asset entries must be an array')
    let offset = 0
    const entries = metadata.entries.map(entry => {
        if (!entry || typeof entry.key !== 'string' || !Number.isSafeInteger(entry.size)
            || entry.size < 0 || entry.size > bytes.length - offset) {
            throw new Error('Invalid asset entry')
        }
        const value = bytes.subarray(offset, offset + entry.size)
        offset += entry.size
        return { key: entry.key, value }
    })
    if (offset !== bytes.length) throw new Error('Unexpected trailing asset bytes')
    return entries
}
