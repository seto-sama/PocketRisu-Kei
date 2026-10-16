import { language } from 'src/lang'
import apiErrorCodes from '../../../shared/apiErrorCodes.json'

export { apiErrorCodes }

const MAX_API_ERROR_MESSAGE_LENGTH = 512

export interface ApiErrorPayload {
    code?: string
    message: string
    details?: Record<string, unknown>
}

export class ApiRequestError extends Error {
    constructor(
        readonly status: number,
        readonly serverMessage: string,
        readonly code?: string,
        readonly details?: Record<string, unknown>,
        fallback = '',
        prefix = `HTTP ${status}`,
    ) {
        const detail = localizedApiErrorMessage({ code, message: serverMessage, status, fallback })
        super(`${prefix}${prefix && detail ? ': ' : ''}${detail}`)
        this.name = 'ApiRequestError'
    }
}

function boundedMessage(message: unknown): string {
    return typeof message === 'string'
        ? message.replace(/\s+/g, ' ').trim().slice(0, MAX_API_ERROR_MESSAGE_LENGTH)
        : ''
}

/** Read the common `{ code, error }` API error envelope without exposing proxy HTML. */
export async function readApiErrorPayload(response: Response): Promise<ApiErrorPayload> {
    const body = await response.text().catch(() => '')
    try {
        const data = JSON.parse(body)
        return {
            code: typeof data?.code === 'string' ? data.code : undefined,
            details: data?.details && typeof data.details === 'object' && !Array.isArray(data.details)
                ? data.details : undefined,
            message: boundedMessage(
                typeof data?.error === 'string' ? data.error
                    : typeof data?.message === 'string' ? data.message : '',
            ),
        }
    } catch {
        const isHtml = response.headers.get('content-type')?.includes('text/html')
            || body.trimStart().startsWith('<')
        return { message: isHtml ? '' : boundedMessage(body) }
    }
}

export async function apiRequestError(response: Response, fallback = ''): Promise<ApiRequestError> {
    const payload = await readApiErrorPayload(response)
    return new ApiRequestError(
        response.status,
        payload.message,
        payload.code,
        payload.details,
        fallback,
    )
}

/** Resolve stable API codes to user text. Raw messages remain diagnostic fallbacks. */
export function localizedApiErrorMessage(payload: {
    code?: string
    message?: string
    status?: number
    fallback?: string
}): string {
    switch (payload.code) {
        case apiErrorCodes.DRIVE_NOT_FOUND: return language.serverDrive.notFound
        case apiErrorCodes.DRIVE_ALREADY_EXISTS: return language.serverDrive.conflictTitle
        case apiErrorCodes.DRIVE_UNSUPPORTED_ENTRY: return language.serverDrive.unsupportedEntry
        case apiErrorCodes.DRIVE_UNAVAILABLE: return language.serverDrive.unavailable
        case apiErrorCodes.DATABASE_LOCKED: return language.errors.databaseLocked
        case apiErrorCodes.CHAT_CONTENT_CHANGED: return language.errors.chatContentChangedOnAnotherClient
        case apiErrorCodes.BACKUP_ENCRYPTION_METADATA_INVALID: return language.errors.backupEncryptionMetadataInvalid
        case apiErrorCodes.BACKUP_ENCRYPTION_KEY_UNAVAILABLE: return language.errors.backupEncryptionKeyUnavailable
        case apiErrorCodes.BACKUP_DECRYPTION_FAILED: return language.errors.backupDecryptionFailed
        case apiErrorCodes.BACKUP_IMPORT_IN_PROGRESS: return language.errors.backupImportInProgress
        case apiErrorCodes.BACKUP_NOT_FOUND: return language.errors.backupNotFound
        case apiErrorCodes.BACKUP_TOO_LARGE: return language.errors.backupTooLarge
        case apiErrorCodes.INSUFFICIENT_STORAGE: return language.errors.insufficientStorage
        case apiErrorCodes.AUTH_INVALID_PASSWORD: return language.errors.wrongPassword
        case apiErrorCodes.AUTH_RATE_LIMITED: return language.errors.authRateLimited
        case apiErrorCodes.AUTH_PASSWORD_NOT_SET: return language.errors.authPasswordNotSet
        case apiErrorCodes.AUTH_CRYPTO_FAILED: return language.errors.authCryptoFailed
        case apiErrorCodes.AUTH_PASSWORD_ALREADY_SET: return language.errors.authPasswordAlreadySet
        case apiErrorCodes.AUTH_REQUIRED: return language.errors.authRequired
        case apiErrorCodes.AUTH_TOKEN_EXPIRED: return language.errors.authTokenExpired
        case apiErrorCodes.AUTH_INVALID_TOKEN: return language.errors.authInvalidToken
        case apiErrorCodes.SYNC_CLIENT_ID_REQUIRED: return language.errors.syncClientIdRequired
        case apiErrorCodes.INVALID_FILE_PATH: return language.errors.invalidFilePath
        case apiErrorCodes.CHAT_NOT_FOUND: return language.errors.chatNotFound
        case apiErrorCodes.CHAT_RESTORE_FAILED: return language.errors.chatRestoreFailed
        case apiErrorCodes.BOOKMARK_NOT_FOUND: return language.errors.bookmarkNotFound
        case apiErrorCodes.SNAPSHOT_NOT_FOUND: return language.errors.snapshotNotFound
        case apiErrorCodes.INVALID_BACKUP_FILENAME: return language.errors.invalidBackupFilename
        case apiErrorCodes.INVALID_SNAPSHOT_KEY: return language.errors.invalidSnapshotKey
        case apiErrorCodes.DATABASE_NOT_FOUND: return language.errors.databaseNotFound
        case apiErrorCodes.BOOKMARK_TAGS_LOCAL_ONLY: return language.errors.bookmarkTagsLocalOnly
        case apiErrorCodes.REVENANT_JOB_NOT_FOUND: return language.errors.revenantJobNotFound
        case apiErrorCodes.REVENANT_WORKFLOW_NOT_FOUND: return language.errors.revenantWorkflowNotFound
        case apiErrorCodes.REVENANT_CLIENT_ACTION_NOT_FOUND: return language.errors.revenantClientActionNotFound
        case apiErrorCodes.COMFY_PROMPT_MISMATCH: return language.errors.comfyPromptMismatch
        case apiErrorCodes.REVENANT_PROVIDER_CAPACITY: return language.errors.revenantProviderCapacity
        case apiErrorCodes.REVENANT_WORKFLOW_LIMIT: return language.errors.revenantWorkflowLimit
        case apiErrorCodes.UNSUPPORTED_REMOTE_SAVE: return language.unsupportedRemoteSave
    }
    if (payload.status === 413) return language.errors.storageRequestTooLarge

    const message = boundedMessage(payload.message)
    return message || payload.fallback || ''
}
