const BRIDGE_ID_KEY = 'risu-comfy-bridge-id'
let memoryBridgeId = ''

function randomId(): string {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function getComfyBridgeId(): string {
    if (memoryBridgeId) return memoryBridgeId
    try { memoryBridgeId = globalThis.localStorage?.getItem(BRIDGE_ID_KEY) ?? '' } catch {}
    if (!memoryBridgeId) {
        memoryBridgeId = `comfy-${randomId()}`
        try { globalThis.localStorage?.setItem(BRIDGE_ID_KEY, memoryBridgeId) } catch {}
    }
    return memoryBridgeId
}
