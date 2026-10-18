import { createEntityId } from '../../../id'

const BRIDGE_ID_KEY = 'risu-comfy-bridge-id'
let memoryBridgeId = ''

export function getComfyBridgeId(): string {
    if (memoryBridgeId) return memoryBridgeId
    try { memoryBridgeId = globalThis.localStorage?.getItem(BRIDGE_ID_KEY) ?? '' } catch {}
    if (!memoryBridgeId) {
        memoryBridgeId = `comfy-${createEntityId()}`
        try { globalThis.localStorage?.setItem(BRIDGE_ID_KEY, memoryBridgeId) } catch {}
    }
    return memoryBridgeId
}
