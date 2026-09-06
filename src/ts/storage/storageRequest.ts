import { language } from 'src/lang'

const MAX_STORAGE_ERROR_MESSAGE_LENGTH = 512

// Chat entry only: bound header wait without replaying the request or
// limiting the time needed to download a large conversation after headers.
export const CHAT_CONTENT_READ_POLICY = Object.freeze({
    firstResponseTimeoutMs: 30_000,
})

export class StorageRequestError extends Error {
    constructor(
        readonly operation: string,
        readonly status: number,
        readonly serverMessage = '',
    ) {
        serverMessage = serverMessage.replace(/\s+/g, ' ').trim().slice(0, MAX_STORAGE_ERROR_MESSAGE_LENGTH)
        const detail = status === 413 ? language.errors.storageRequestTooLarge : serverMessage
        super(`${operation} (HTTP ${status})${detail ? `: ${detail}` : ''}`)
        this.name = 'StorageRequestError'
    }
}

/** Consume an unsuccessful response once, keeping useful text out of proxy HTML. */
export async function storageRequestError(operation: string, response: Response): Promise<StorageRequestError> {
    const body = await response.text().catch(() => '')
    let message = ''
    try {
        const data = JSON.parse(body)
        message = typeof data?.error === 'string' ? data.error
            : typeof data?.message === 'string' ? data.message : ''
    } catch {
        if (!response.headers.get('content-type')?.includes('text/html') && !body.trimStart().startsWith('<')) {
            message = body
        }
    }
    return new StorageRequestError(operation, response.status, message)
}

export class ChatSaveError extends Error {
    constructor(
        readonly failedChats: [string, string][],
        readonly projectionSaved: boolean,
        readonly errors: unknown[],
    ) {
        // When a batch cannot be retried, show the error that requires action.
        const first = errors.find(error => !isRetryableSaveError(error)) ?? errors[0]
        super(`Failed to save ${failedChats.length} chat${failedChats.length === 1 ? '' : 's'}: ${first instanceof Error ? first.message : String(first)}`,
            { cause: first })
        this.name = 'ChatSaveError'
    }
}

export function isRetryableSaveError(error: unknown): boolean {
    if (error instanceof ChatSaveError) return error.errors.every(isRetryableSaveError)
    if (error instanceof StorageRequestError) {
        return error.status === 408 || error.status === 429 || error.status >= 500
    }
    return true
}

export class SaveConflictError extends Error {
    constructor() {
        super(language.errors.saveConflictRetryExhausted)
        this.name = 'SaveConflictError'
    }
}

// One budget for transport failures and successful requests that ask us to
// rebase. A new edit can start another budget after automatic saving stops.
const SAVE_RETRY_LIMIT = 4
const SAVE_RETRY_DELAY_MS = 500
const SAVE_RETRY_MAX_DELAY_MS = 3000

export type SaveAttemptResult = 'saved' | 'retry' | 'noop' | 'discarded'

export class SaveRetryPolicy {
    private failures = 0

    reset() { this.failures = 0 }

    async runAttempt(save: () => Promise<SaveAttemptResult>) {
        const result = await save()
        if (result === 'retry') throw new SaveConflictError()
        if (result === 'saved') this.reset()
        return result
    }

    recordFailure(error: unknown) {
        this.failures += 1
        return {
            retry: isRetryableSaveError(error) && this.failures <= SAVE_RETRY_LIMIT,
            delayMs: Math.min(SAVE_RETRY_DELAY_MS * this.failures, SAVE_RETRY_MAX_DELAY_MS),
        }
    }
}
