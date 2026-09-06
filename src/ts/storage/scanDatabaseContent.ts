import { getDatabase } from './database.svelte'
import { forageStorage } from './autoStorage'
import { createContentReferenceCollector, type ContentReferenceKind } from '../../../shared/contentReferences.mjs'

type ScanMetadata = { scannedAt: number; totalMessages: number }
type InlayReferences = ScanMetadata & { kind: 'inlay'; refCounts: Record<string, number> }
type TranslationReferences = ScanMetadata & { kind: 'translation'; keys: string[] }

/** Union authoritative server references with local edits; never hydrate UI chats. */
export function scanDatabaseContent(kind: 'inlay', candidates: string[]): Promise<InlayReferences>
export function scanDatabaseContent(kind: 'translation', candidates: string[]): Promise<TranslationReferences>
export function scanDatabaseContent(kind: ContentReferenceKind, candidates: string[]): Promise<InlayReferences | TranslationReferences>
export async function scanDatabaseContent(kind: ContentReferenceKind, candidates: string[]): Promise<InlayReferences | TranslationReferences> {
    await forageStorage.Init()
    const server = await forageStorage.realStorage.scanContentReferences(kind, candidates)
    const collector = createContentReferenceCollector(kind)
    // Read local state after the await, including edits made while the server scanned.
    for (const character of getDatabase().characters ?? []) collector.addCharacter(character)
    const local = collector.result()
    if ('keys' in local) {
        const keys = new Set<string>(server.keys)
        for (const key of local.keys) keys.add(key)
        return { kind: 'translation', scannedAt: server.scannedAt, keys: [...keys], totalMessages: local.totalMessages }
    }
    const refCounts: Record<string, number> = Object.assign(Object.create(null), server.refCounts)
    for (const [id, count] of Object.entries(local.refCounts)) {
        refCounts[id] = Math.max(refCounts[id] ?? 0, count)
    }
    return { kind: 'inlay', scannedAt: server.scannedAt, refCounts, totalMessages: local.totalMessages }
}
