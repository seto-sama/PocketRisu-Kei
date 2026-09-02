import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RevenantWorkflow } from '../types'

const statusMocks = vi.hoisted(() => ({
    startStatus: vi.fn(),
    setStatusProgress: vi.fn(),
    endStatus: vi.fn(),
}))
const workflowMocks = vi.hoisted(() => ({ getRevenantWorkflow: vi.fn() }))

vi.mock('../../../storage/database.svelte', () => ({
    getDatabase: () => ({ showRequestStatus: true }),
}))
vi.mock('../../../imageGeneration/presets', () => ({
    getCurrentImageGenerationPreset: () => ({ name: 'NovelAI' }),
}))
vi.mock('../../../status/requestStatus', () => statusMocks)
vi.mock('../transport/client', () => ({
    createRevenantGenerationAuth: async () => 'auth',
}))
vi.mock('./workflow', () => workflowMocks)

import { observeRevenantImageGenerationWorkflow } from './imageWorkflow'

function imageWorkflow(status: 'active' | 'completed' = 'active'): RevenantWorkflow {
    return {
        workflowId: 'workflow-image',
        characterId: 'character-1',
        roomId: 'image-generation:room-1',
        planVersion: 1,
        status,
        context: {
            schemaVersion: 1,
            kind: 'image-generation',
            comfyBridgeId: 'comfy-test-device',
            operationId: 'operation-1',
            messageId: 'message-1',
            target: { characterId: 'character-1', roomId: 'room-1' },
            prompt: 'portrait',
            negativePrompt: '',
            label: 'NovelAI',
            projection: 'reroll',
        },
        steps: [{
            key: 'image.generate',
            kind: 'image.generate.server',
            recoveryPolicy: 'at_least_once',
            status: status === 'active' ? 'running' : 'completed',
            order: 0,
            metadata: {
                action: { actionId: 'image-generation:operation-1', kind: 'image.generate' },
            },
            updatedAt: 1,
            executions: [],
        }],
        createdAt: 1,
        updatedAt: 1,
    }
}

describe('server-owned image workflow observer', () => {
    beforeEach(() => vi.clearAllMocks())
    afterEach(() => vi.unstubAllGlobals())

    it('resubscribes to the Node job after reload without claiming a client action', async () => {
        workflowMocks.getRevenantWorkflow.mockResolvedValue(imageWorkflow('completed'))
        let polls = 0
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
            polls += 1
            return new Response(JSON.stringify(polls === 1 ? {
                status: 'generating',
                progress: { value: 4, max: 28 },
            } : {
                status: 'completed',
                progress: { value: 28, max: 28 },
            }), { status: 200, headers: { 'content-type': 'application/json' } })
        })
        vi.stubGlobal('fetch', fetchMock)

        await observeRevenantImageGenerationWorkflow(imageWorkflow())

        expect(fetchMock).toHaveBeenCalledWith(
            '/api/image-generation/jobs/workflow-image%3Aimage-generation%3Aoperation-1',
            { headers: { 'risu-auth': 'auth' } },
        )
        expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/client-action/claim'))).toBe(true)
        expect(statusMocks.setStatusProgress).toHaveBeenCalledWith(
            'operation-1',
            { value: 4, max: 28 },
        )
        expect(statusMocks.endStatus).toHaveBeenCalledWith('operation-1', 'done', expect.any(Object))
    })
})
