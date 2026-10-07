import { Sha256 } from '@aws-crypto/sha256-js'

const encoder = new TextEncoder()

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    const subtle = globalThis.crypto?.subtle
    let digest: Uint8Array
    if (subtle) {
        digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
    } else {
        // Remote HTTP origins do not expose Web Crypto's subtle API.
        const hash = new Sha256()
        hash.update(bytes)
        digest = await hash.digest()
    }
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}
