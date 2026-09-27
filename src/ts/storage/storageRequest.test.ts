import { describe, expect, it, vi } from 'vitest'
import { changeLanguage } from 'src/lang'
import { apiRequestError } from '../network/apiError'
import { ChatSaveError, SaveConflictError, SaveRetryPolicy, isRetryableSaveError, storageRequestError, StorageRequestError } from './storageRequest'

describe('storage error details', () => {
    it('preserves server JSON and plain-text errors with bounded display text', async () => {
        const json = await storageRequestError('save', new Response(JSON.stringify({ error: 'disk full' }), { status: 500 }))
        expect(json).toMatchObject({ operation: 'save', status: 500, serverMessage: 'disk full' })
        expect(json.message).toContain('HTTP 500')
        expect(json.message).toContain('disk full')

        const plain = await storageRequestError('save', new Response('unavailable\n' + 'x'.repeat(2000), { status: 503 }))
        expect(plain.serverMessage).toHaveLength(512)
        expect(plain.serverMessage).toMatch(/^unavailable x/)
    })

    it('explains proxy 413 responses without displaying the HTML page', async () => {
        const error = await storageRequestError('save', new Response('<html>nginx body limit</html>', {
            status: 413, headers: { 'content-type': 'text/html' },
        }))
        expect(error.message).toContain('HTTP 413')
        expect(error.message).toContain('request-size limit')
        expect(error.message).not.toContain('<html>')
        expect(isRetryableSaveError(error)).toBe(false)
    })

    it('localizes coded server errors instead of displaying their diagnostic text', async () => {
        changeLanguage('ko')
        try {
            const locked = await storageRequestError('save', new Response(JSON.stringify({
                code: 'DATABASE_LOCKED', error: 'database is locked',
            }), { status: 503 }))
            expect(locked.code).toBe('DATABASE_LOCKED')
            expect(locked.serverMessage).toBe('database is locked')
            expect(locked.message).toContain('DB가 사용 중입니다')
            expect(locked.message).not.toContain('database is locked')

            const uncoded = new StorageRequestError('save', 503, 'database is locked')
            expect(uncoded.message).toContain('database is locked')
        } finally {
            changeLanguage('en')
        }
    })

    it.each([
        ['BACKUP_IMPORT_IN_PROGRESS', '다른 백업 가져오기 또는 복원이 이미 진행 중입니다.'],
        ['BACKUP_NOT_FOUND', '백업 파일을 찾을 수 없습니다.'],
        ['BACKUP_TOO_LARGE', '백업 파일이 서버의 업로드 크기 제한을 초과했습니다.'],
        ['INSUFFICIENT_STORAGE', '작업을 완료할 디스크 여유 공간이 부족합니다.'],
        ['AUTH_INVALID_PASSWORD', '비밀번호가 잘못되었습니다.'],
        ['AUTH_RATE_LIMITED', '로그인 시도가 너무 많습니다.'],
        ['AUTH_PASSWORD_NOT_SET', '서버 비밀번호가 설정되지 않았습니다.'],
        ['AUTH_CRYPTO_FAILED', '비밀번호 해시에 실패했습니다.'],
        ['AUTH_PASSWORD_ALREADY_SET', '서버 비밀번호가 이미 설정되어 있습니다.'],
        ['AUTH_REQUIRED', '인증이 필요합니다.'],
        ['AUTH_TOKEN_EXPIRED', '인증 토큰이 만료되었습니다.'],
        ['AUTH_INVALID_TOKEN', '인증 토큰이 올바르지 않습니다.'],
        ['SYNC_CLIENT_ID_REQUIRED', '동기화 클라이언트 ID가 필요합니다.'],
        ['INVALID_FILE_PATH', '올바른 파일 경로가 필요합니다.'],
        ['CHAT_NOT_FOUND', '채팅을 찾을 수 없습니다.'],
        ['CHAT_RESTORE_FAILED', '콜드 스토리지에서 채팅을 복원하지 못했습니다.'],
        ['BOOKMARK_NOT_FOUND', '북마크를 찾을 수 없습니다.'],
        ['SNAPSHOT_NOT_FOUND', '스냅샷을 찾을 수 없습니다.'],
        ['INVALID_BACKUP_FILENAME', '올바른 백업 파일명이 필요합니다.'],
        ['INVALID_SNAPSHOT_KEY', '올바른 스냅샷 키가 필요합니다.'],
        ['DATABASE_NOT_FOUND', '데이터베이스를 찾을 수 없습니다.'],
        ['BOOKMARK_TAGS_LOCAL_ONLY', '북마크 태그는 로컬 서버에서만 사용할 수 있습니다.'],
        ['REVENANT_JOB_NOT_FOUND', '생성 작업을 찾을 수 없습니다.'],
        ['REVENANT_WORKFLOW_NOT_FOUND', '생성 워크플로를 찾을 수 없습니다.'],
        ['REVENANT_CLIENT_ACTION_NOT_FOUND', '대기 중인 워크플로 클라이언트 작업을 찾을 수 없습니다.'],
        ['COMFY_PROMPT_MISMATCH', 'ComfyUI 프롬프트가 이 작업과 일치하지 않습니다.'],
        ['REVENANT_PROVIDER_CAPACITY', '서버의 생성 처리 용량이 가득 찼습니다.'],
        ['REVENANT_WORKFLOW_LIMIT', '서버에서 처리 중인 작업이 너무 많습니다.'],
    ])('uses the common translation for API code %s', async (code, expected) => {
        changeLanguage('ko')
        try {
            const error = await apiRequestError(new Response(JSON.stringify({
                code, error: 'diagnostic server message',
            }), { status: 400 }))
            expect(error.code).toBe(code)
            expect(error.message).toContain(expected)
            expect(error.message).not.toContain('diagnostic server message')
        } finally {
            changeLanguage('en')
        }
    })

    it('retains failed targets, acknowledged projection state and the original chat error', () => {
        const cause = new StorageRequestError('saveChatContent', 413)
        const error = new ChatSaveError([['character', 'chat']], true, [cause])
        expect(error.failedChats).toEqual([['character', 'chat']])
        expect(error.projectionSaved).toBe(true)
        expect(error.cause).toBe(cause)
        expect(error.message).toContain(cause.message)
        expect(isRetryableSaveError(error)).toBe(false)
        expect(isRetryableSaveError(new ChatSaveError([['a', 'b']], false, [new TypeError('Failed to fetch')]))).toBe(true)
    })

    it('shows the permanent failure when a batch also has a transient failure', () => {
        const temporary = new StorageRequestError('saveChatContent', 503, 'unavailable')
        const oversized = new StorageRequestError('saveChatContent', 413)
        const error = new ChatSaveError([['a', '1'], ['a', '2']], true, [temporary, oversized])
        expect(error.cause).toBe(oversized)
        expect(error.message).toContain('HTTP 413')
        expect(isRetryableSaveError(error)).toBe(false)
        expect(isRetryableSaveError(temporary)).toBe(true)
    })

})

describe('automatic save retry policy', () => {
    it('bounds repeated rebase outcomes and mixed transport failures in one budget', async () => {
        const policy = new SaveRetryPolicy()
        const rebase = vi.fn(async () => 'retry' as const)
        const send = vi.fn()
            .mockImplementationOnce(rebase)
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockImplementation(rebase)
        let stopped: unknown
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                await policy.runAttempt(send)
            } catch (error) {
                const decision = policy.recordFailure(error)
                if (!decision.retry) { stopped = error; break }
                expect(decision.delayMs).toBeGreaterThan(0)
            }
        }
        expect(send).toHaveBeenCalledTimes(5)
        expect(rebase).toHaveBeenCalledTimes(4)
        expect(stopped).toBeInstanceOf(SaveConflictError)
    })

    it('resets after an acknowledged save or a new attempt after stopping, not a noop', async () => {
        const policy = new SaveRetryPolicy()
        const failure = new TypeError('network')
        for (let i = 0; i < 4; i++) expect(policy.recordFailure(failure).retry).toBe(true)
        await policy.runAttempt(async () => 'noop')
        expect(policy.recordFailure(failure).retry).toBe(false)
        policy.reset()
        expect(policy.recordFailure(failure).delayMs).toBe(500)
        await policy.runAttempt(async () => 'saved')
        expect(policy.recordFailure(failure).delayMs).toBe(500)
        expect(policy.recordFailure(new StorageRequestError('patchDatabase', 413)).retry).toBe(false)
    })
})
