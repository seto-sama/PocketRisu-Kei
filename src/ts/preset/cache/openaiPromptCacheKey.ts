import { sha256Hex } from '../../hash'
import type { PromptItem } from '../../process/prompt'

const CACHE_KEY_PREFIX = 'rk'
const ROOM_ID_LENGTH = 8
const PRESET_HASH_LENGTH = 12

function canonicalStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`
    }

    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
        .join(',')}}`
}

function getRawPresetPrefix(promptTemplate: readonly PromptItem[]): readonly PromptItem[] {
    let lastCachePoint = -1
    for (let index = 0; index < promptTemplate.length; index++) {
        if (promptTemplate[index].type === 'cache') lastCachePoint = index
    }
    const throughFinalCachePoint = lastCachePoint === -1
        ? promptTemplate
        : promptTemplate.slice(0, lastCachePoint)
    return throughFinalCachePoint.filter(item => item.type !== 'cache')
}

/** Hashes raw prompt cards before the final cache marker, or all cards when none exists. */
export async function createOpenAiPromptCacheKey(
    roomId: string | undefined,
    promptTemplate: readonly PromptItem[] | null | undefined,
): Promise<string | undefined> {
    if (!roomId || !Array.isArray(promptTemplate)) return undefined

    const roomPrefix = roomId.slice(0, ROOM_ID_LENGTH)

    const rawPresetPrefix = getRawPresetPrefix(promptTemplate)
    const presetHash = await sha256Hex(canonicalStringify(rawPresetPrefix))
    return `${CACHE_KEY_PREFIX}-${roomPrefix}-${presetHash.slice(0, PRESET_HASH_LENGTH)}`
}
