import { createSubscriber } from 'svelte/reactivity'
import { DBState, selIdState } from '../../stores.svelte'
import {
    acknowledgeRecoverableTranslation,
    getRecoverableTranslationCacheKeyForTarget,
    isRecoverableTranslationSnapshotLoaded,
    subscribeRecoverableTranslations,
} from './auxiliary'
import type { RevenantChatMessageTranslationTarget } from './types'
import {
    recoverRevenantTranslationJobs,
    type RevenantTranslationCache,
} from './translationRecovery'

type ParseMode = 'normal' | 'back' | 'pretranslate' | 'notrim'
type ParseMessageMarkdown = (data: string, mode: ParseMode) => Promise<string>

export interface RevenantChatTranslationRecoveryScope {
    characterId: string
    roomId: string
}

export interface RevenantChatTranslationRecoverySnapshot {
    pending: boolean
    cacheKey: string | null
    scope: RevenantChatTranslationRecoveryScope | null
    target: RevenantChatMessageTranslationTarget | null
}

export interface RevenantChatTranslationRecovery {
    readonly pending: boolean
    readonly inspectionReady: boolean
    capture: () => RevenantChatTranslationRecoverySnapshot
    shouldDisplayTranslation: (
        snapshot: RevenantChatTranslationRecoverySnapshot,
        options: {
            data: string
            translated: boolean
            streaming: boolean
            parseMarkdown: ParseMessageMarkdown
        },
    ) => Promise<boolean>
    waitForResult: (
        snapshot: RevenantChatTranslationRecoverySnapshot,
    ) => Promise<void>
    acknowledgeResolved: (
        snapshot: RevenantChatTranslationRecoverySnapshot,
    ) => Promise<void>
}

export interface RevenantChatTranslationRecoveryContext {
    trackSnapshot: () => void
}

export function createRevenantChatTranslationRecoveryContext(): RevenantChatTranslationRecoveryContext {
    const trackRecoverableTranslations = createSubscriber((update) =>
        subscribeRecoverableTranslations(update)
    )
    return { trackSnapshot: trackRecoverableTranslations }
}

export function createRevenantChatTranslationRecovery(options: {
    getTarget: () => RevenantChatMessageTranslationTarget | null
    translationCache: RevenantTranslationCache
    getContext?: () => RevenantChatTranslationRecoveryContext | undefined
    getScope?: () => RevenantChatTranslationRecoveryScope | null | undefined
}): RevenantChatTranslationRecovery {
    let fallbackContext: RevenantChatTranslationRecoveryContext | undefined
    let lastSnapshot: RevenantChatTranslationRecoverySnapshot | undefined

    function currentContext(): RevenantChatTranslationRecoveryContext {
        return options.getContext?.()
            ?? (fallbackContext ??= createRevenantChatTranslationRecoveryContext())
    }

    function currentScope(): RevenantChatTranslationRecoveryScope | null {
        const explicitScope = options.getScope?.()
        if (explicitScope !== undefined) return explicitScope
        const currentCharacter = DBState.db.characters[selIdState.selId]
        const currentChat = currentCharacter?.chats[currentCharacter.chatPage]
        return currentCharacter?.chaId && currentChat?.id
            ? {
                characterId: currentCharacter.chaId,
                roomId: currentChat.id,
            }
            : null
    }

    function capture(): RevenantChatTranslationRecoverySnapshot {
        currentContext().trackSnapshot()
        const scope = currentScope()
        const target = options.getTarget()
        const cacheKey = scope && target
            ? getRecoverableTranslationCacheKeyForTarget({ ...scope, target })
            : null
        const pending = cacheKey !== null
        if (
            lastSnapshot
            && lastSnapshot.pending === pending
            && lastSnapshot.cacheKey === cacheKey
            && lastSnapshot.scope?.characterId === scope?.characterId
            && lastSnapshot.scope?.roomId === scope?.roomId
            && lastSnapshot.target?.kind === target?.kind
            && lastSnapshot.target?.messageChatId === target?.messageChatId
            && lastSnapshot.target?.messageIndex === target?.messageIndex
            && lastSnapshot.target?.swipeId === target?.swipeId
        ) {
            return lastSnapshot
        }
        lastSnapshot = {
            pending,
            cacheKey,
            scope: scope ? { ...scope } : null,
            target: target ? { ...target } : null,
        }
        return lastSnapshot
    }

    async function shouldDisplayTranslation(
        snapshot: RevenantChatTranslationRecoverySnapshot,
        renderOptions: {
            data: string
            translated: boolean
            streaming: boolean
            parseMarkdown: ParseMessageMarkdown
        },
    ): Promise<boolean> {
        if (renderOptions.streaming) return false
        if (!renderOptions.data.trim()) return false
        if (snapshot.pending || renderOptions.translated) return true
        if (!DBState.db.autoTranslate) return false
        if (
            !DBState.db.autoTranslateCachedOnly
            || DBState.db.translatorType !== 'llm'
        ) return true

        const translationCacheKey = snapshot.cacheKey
            ?? (DBState.db.translateBeforeHTMLFormatting
                ? renderOptions.data
                : !DBState.db.legacyTranslation
                    ? await renderOptions.parseMarkdown(renderOptions.data, 'pretranslate')
                    : await renderOptions.parseMarkdown(renderOptions.data, 'notrim'))
        snapshot.cacheKey = translationCacheKey
        const cached = await options.translationCache.get(translationCacheKey) !== null
        return cached
    }

    async function waitForResult(
        snapshot: RevenantChatTranslationRecoverySnapshot,
    ): Promise<void> {
        if (!snapshot.pending || !snapshot.cacheKey || !snapshot.scope) return
        await recoverRevenantTranslationJobs(options.translationCache, {
            force: true,
            scope: snapshot.scope,
            cacheKey: snapshot.cacheKey,
        })
    }

    async function acknowledgeResolved(
        snapshot: RevenantChatTranslationRecoverySnapshot,
    ): Promise<void> {
        if (
            !snapshot.pending
            || !snapshot.cacheKey
            || !snapshot.scope
            || await options.translationCache.get(snapshot.cacheKey) === null
        ) return
        acknowledgeRecoverableTranslation({
            cacheKey: snapshot.cacheKey,
            ...snapshot.scope,
        })
    }

    return {
        get pending() {
            return capture().pending
        },
        get inspectionReady() {
            currentContext().trackSnapshot()
            return DBState.db.translatorType !== 'llm'
                || currentScope() === null
                || isRecoverableTranslationSnapshotLoaded()
        },
        capture,
        shouldDisplayTranslation,
        waitForResult,
        acknowledgeResolved,
    }
}
