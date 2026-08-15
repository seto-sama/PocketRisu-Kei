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
        const swipeMetadata = getActiveSwipeMetadata(message)
        // Legacy swipe sets have only message-level diagnostics. Preserve
        // those panels exactly as before, but do not use their newest
        // generation id to look up a log for an older selected swipe.
        const generationInfo = swipeMetadata?.generationInfo
            ?? message.generationInfo
            ?? fallbackGenerationInfo
            ?? {}
        return {
            generationInfo,
            promptInfo: swipeMetadata?.promptInfo ?? message.promptInfo,
            swipeMetadata,
            requestKey: swipeMetadata?.chatId ?? swipeMetadata?.generationInfo?.generationId ?? '',
            time: swipeMetadata?.time ?? message.time,
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
