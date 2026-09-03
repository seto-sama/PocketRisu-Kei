import { Sha256 } from '@aws-crypto/sha256-js'
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

async function sha256Hex(value: string): Promise<string> {
    const hash = new Sha256()
    hash.update(value)
    const digest = await hash.digest()
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Builds the stable GPT-5.6 prompt-cache routing key for a chat request.
 * The preset component intentionally hashes the unparsed prompt cards through
 * the card immediately before the final explicit cache card. With no explicit
 * cache card, the complete raw prompt template participates in the hash.
 */
export async function createOpenAiPromptCacheKey(
    roomId: string | undefined,
    promptTemplate: readonly PromptItem[] | null | undefined,
): Promise<string | undefined> {
    if (!roomId || !Array.isArray(promptTemplate)) return undefined

    const roomPrefix = roomId.slice(0, ROOM_ID_LENGTH)
    if (!roomPrefix) return undefined

    const rawPresetPrefix = getRawPresetPrefix(promptTemplate)
    const presetHash = await sha256Hex(canonicalStringify(rawPresetPrefix))
    return `${CACHE_KEY_PREFIX}-${roomPrefix}-${presetHash.slice(0, PRESET_HASH_LENGTH)}`
}
