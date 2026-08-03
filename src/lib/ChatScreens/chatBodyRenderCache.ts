type ChatBodyRenderCacheEntry = {
    sourceData: string
    html: string
    translated: boolean
    translationCacheKey: string | null
    translationCacheRevision: number
}

// Keep several ordinary 30-message rooms hot. The character budget remains
// the primary memory bound for unusually large histories.
const MAX_ENTRIES = 256
const MAX_HTML_CHARACTERS = 12_000_000
const MAX_COMMIT_CHARACTERS_PER_FRAME = 50_000
const MAX_COMMITS_PER_FRAME = 3
const cache = new Map<string, ChatBodyRenderCacheEntry>()
let cachedHtmlCharacters = 0
const pendingCommits: Array<{ characters: number; resolve: () => void }> = []
let commitFramePending = false

function scheduleCommitFrame(): void {
    if (commitFramePending || pendingCommits.length === 0) return
    commitFramePending = true
    const flush = () => {
        commitFramePending = false
        let committedCharacters = 0
        let committedEntries = 0
        while (pendingCommits.length > 0) {
            const next = pendingCommits[0]
            if (
                committedEntries > 0
                && (
                    committedEntries >= MAX_COMMITS_PER_FRAME
                    || committedCharacters + next.characters > MAX_COMMIT_CHARACTERS_PER_FRAME
                )
            ) break
            pendingCommits.shift()
            committedCharacters += next.characters
            committedEntries += 1
            next.resolve()
        }
        scheduleCommitFrame()
    }
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(flush)
    }
    else {
        setTimeout(flush, 0)
    }
}

export function waitForChatBodyRenderCacheCommit(characters: number): Promise<void> {
    return new Promise((resolve) => {
        pendingCommits.push({ characters, resolve })
        scheduleCommitFrame()
    })
}

export function getChatBodyRenderCache(
    key: string,
    sourceData: string,
    translationCacheRevision: number,
    expectedTranslated?: boolean,
): ChatBodyRenderCacheEntry | null {
    const entry = cache.get(key)
    if (
        !entry
        || entry.sourceData !== sourceData
        || entry.translationCacheRevision !== translationCacheRevision
        || (expectedTranslated !== undefined && entry.translated !== expectedTranslated)
    ) return null
    cache.delete(key)
    cache.set(key, entry)
    return entry
}

export function setChatBodyRenderCache(key: string, entry: ChatBodyRenderCacheEntry): void {
    const previous = cache.get(key)
    if (previous) cachedHtmlCharacters -= previous.html.length
    cache.delete(key)
    cache.set(key, entry)
    cachedHtmlCharacters += entry.html.length

    while (cache.size > MAX_ENTRIES || cachedHtmlCharacters > MAX_HTML_CHARACTERS) {
        const oldestKey = cache.keys().next().value
        if (oldestKey === undefined) break
        const oldest = cache.get(oldestKey)
        if (oldest) cachedHtmlCharacters -= oldest.html.length
        cache.delete(oldestKey)
    }
}

export function clearChatBodyRenderCache(): void {
    cache.clear()
    cachedHtmlCharacters = 0
}
