import { language } from 'src/lang'
import { ApiRequestError, readApiErrorPayload, localizedApiErrorMessage } from '../network/apiError'
import { SaveConflictCancelledError } from './saveConflict'

export class ConflictError extends Error {
    constructor(message: string, readonly currentEtag: string, readonly code?: string) {
        super(localizedApiErrorMessage({ code, message }))
        this.name = 'ConflictError'
    }
}

// Chat entry only: bound header wait without replaying the request or
// limiting the time needed to download a large conversation after headers.
export const CHAT_CONTENT_READ_POLICY = Object.freeze({
    firstResponseTimeoutMs: 30_000,
})

export class StorageRequestError extends ApiRequestError {
    constructor(
        readonly operation: string,
        status: number,
        serverMessage = '',
        code?: string,
        details?: Record<string, unknown>,
    ) {
        super(status, serverMessage, code, details, '', `${operation} (HTTP ${status})`)
        this.name = 'StorageRequestError'
    }
}

/** Consume an unsuccessful response once, keeping useful text out of proxy HTML. */
export async function storageRequestError(operation: string, response: Response): Promise<StorageRequestError> {
    const payload = await readApiErrorPayload(response)
    return new StorageRequestError(operation, response.status, payload.message, payload.code, payload.details)
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
    if (error instanceof ConflictError || error instanceof SaveConflictCancelledError) return false
    if (error instanceof StorageRequestError) {
        return error.status === 408 || error.status === 429 || error.status >= 500
    }
    return true
}

export function isCancelledSaveConflict(error: unknown): boolean {
    if (error instanceof ChatSaveError) return error.errors.every(isCancelledSaveConflict)
    return error instanceof SaveConflictCancelledError
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
