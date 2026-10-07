import { decodeBinaryMessage, encodeBinaryMessage } from '../network/binaryMessage'
import { isInlayMediaType } from '../../../shared/inlayTypes.mjs'

export interface InlayMetadata {
    ext: string
    name: string
    type: 'image' | 'video' | 'audio'
    height?: number
    width?: number
    mime: string
}

export function encodeInlayAsset(metadata: InlayMetadata, bytes: Uint8Array) {
    return encodeBinaryMessage({ ...metadata }, bytes)
}

export function decodeInlayAsset(message: Uint8Array): { metadata: InlayMetadata; bytes: Uint8Array } {
    const { metadata, bytes } = decodeBinaryMessage(message)
    if (typeof metadata.ext !== 'string' || typeof metadata.name !== 'string'
        || typeof metadata.mime !== 'string'
        || !isInlayMediaType(metadata.type)
        || [metadata.width, metadata.height].some(value => value !== undefined
            && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
        throw new Error('Invalid inlay metadata')
    }
    return { metadata: metadata as unknown as InlayMetadata, bytes }
}
