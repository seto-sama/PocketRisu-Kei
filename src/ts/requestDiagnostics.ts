import type {
    Message,
    MessageGenerationInfo,
    MessagePresetInfo,
    MessageSwipeMetadata,
} from './storage/database.svelte'
import { getActiveSwipeMetadata } from './process/revenant/recovery/chatGenerationTarget'

export interface RequestDiagnosticContext {
    generationInfo: MessageGenerationInfo
    promptInfo?: MessagePresetInfo
    swipeMetadata?: MessageSwipeMetadata
    requestKey: string
    time?: number
    hasSwipeSet: boolean
}

/**
 * Resolves diagnostics for exactly the selected response variant. A legacy
 * multi-swipe message has no reliable mapping from a string response to the
 * message-level generation metadata, so it intentionally returns no request
 * key instead of substituting the newest generation's log.
 */
export function resolveRequestDiagnosticContext(
    message: Message | undefined,
    fallbackGenerationInfo?: MessageGenerationInfo,
): RequestDiagnosticContext {
    const hasSwipeSet = Array.isArray(message?.swipes)
    if (message && hasSwipeSet) {
        const hasSwipeMetadata = Array.isArray(message.swipeMetadata)
        const swipeMetadata = getActiveSwipeMetadata(message)
        // Upstream's legacy format only stored diagnostics on the message
        // created for the newest (last) swipe. Swipe navigation changed data
        // and swipeId without changing those message-level fields.
        const isLegacyNewestSwipe = !hasSwipeMetadata
            && (message.swipeId ?? 0) === message.swipes!.length - 1
        const generationInfo = swipeMetadata?.generationInfo
            ?? (isLegacyNewestSwipe
                ? message.generationInfo ?? fallbackGenerationInfo ?? {}
                : {})
        return {
            generationInfo,
            promptInfo: swipeMetadata?.promptInfo
                ?? (isLegacyNewestSwipe ? message.promptInfo : undefined),
            swipeMetadata,
            requestKey: swipeMetadata?.chatId ?? swipeMetadata?.generationInfo?.generationId ?? '',
            time: swipeMetadata?.time ?? (isLegacyNewestSwipe ? message.time : undefined),
            hasSwipeSet: true,
        }
    }

    const generationInfo = fallbackGenerationInfo ?? message?.generationInfo ?? {}
    return {
        generationInfo,
        promptInfo: message?.promptInfo,
        requestKey: generationInfo.generationId ?? message?.chatId ?? '',
        time: message?.time,
        hasSwipeSet: false,
    }
}
