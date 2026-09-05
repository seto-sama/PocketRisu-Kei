import { language } from 'src/lang'

const MAX_STORAGE_ERROR_MESSAGE_LENGTH = 512

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
