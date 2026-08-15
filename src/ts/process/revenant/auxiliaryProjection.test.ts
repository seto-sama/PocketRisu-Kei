import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    readRecoverableGenerationContent: vi.fn(),
}))

vi.mock('./transport/client', () => ({
    createRevenantGenerationAuth: vi.fn(async () => 'auth'),
    createRevenantJobMutationHeaders: vi.fn(async () => ({})),
    isRevenantGenerationLocallyObserved: vi.fn(() => false),
    setRevenantGenerationLocallyObserved: vi.fn(),
    trackRevenantGenerationWorkflow: vi.fn(),
}))
vi.mock('./transport/stream', () => ({
    readRecoverableGenerationContent: mocks.readRecoverableGenerationContent,
}))

import { resolveRecoverableAuxiliaryGeneration } from './auxiliary'
import type { RecoverableAuxiliaryJob } from './types'

function failedJob(): RecoverableAuxiliaryJob {
    return {
        jobId: 'failed-job',
        chatId: 'aux-1',
        jobType: 'translate',
        status: 'failed',
        characterId: 'character-1',
        roomId: 'room-1',
        rawBytes: 100,
        createdAt: 1,
        updatedAt: 2,
        operationContext: {
            kind: 'translation',
            operationId: 'translation-1',
            cacheKey: 'source',
            styleDecodes: [],
            replaceExisting: false,
            target: null,
        },
    }
}

describe('recoverable auxiliary projection', () => {
    beforeEach(() => {
        mocks.readRecoverableGenerationContent.mockReset()
    })

    it('does not decode a terminal error body as generated model output', async () => {
        const job = failedJob()

        await expect(resolveRecoverableAuxiliaryGeneration(job)).resolves.toBe(job)

        expect(mocks.readRecoverableGenerationContent).not.toHaveBeenCalled()
    })
})
