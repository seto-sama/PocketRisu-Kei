const encoder = new TextEncoder()

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}
