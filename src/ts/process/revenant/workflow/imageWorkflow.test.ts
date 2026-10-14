import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RevenantWorkflow } from '../types'

const statusMocks = vi.hoisted(() => ({
    startStatus: vi.fn(),
    setStatusProgress: vi.fn(),
    endStatus: vi.fn(),
}))
const workflowMocks = vi.hoisted(() => ({
    beginImageGenerationWorkflow: vi.fn(),
    getRevenantWorkflow: vi.fn(),
}))

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

import {
    generateImageWorkflowSequence,
    generateImageThroughWorkflow,
    observeRevenantImageGenerationWorkflow,
} from './imageWorkflow'

function imageWorkflow(status: 'active' | 'completed' = 'active', label = 'NovelAI'): RevenantWorkflow {
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
            label,
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

    it('observes server progress and preserves the workflow label in status', async () => {
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

        const label = 'Ink · smile · 1/26'
        await observeRevenantImageGenerationWorkflow(imageWorkflow('active', label))

        expect(statusMocks.startStatus).toHaveBeenCalledWith('operation-1', expect.objectContaining({ label }))
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

    it('returns the generated inlay reference from a return-mode workflow', async () => {
        const prompt = String.raw`portrait \(group\)`
        const completed = imageWorkflow('completed')
        completed.steps[0].metadata = {
            ...completed.steps[0].metadata,
            result: { reference: '{{inlayed::asset-id}}' },
        }
        workflowMocks.beginImageGenerationWorkflow.mockResolvedValue(completed)

        await expect(generateImageThroughWorkflow({
            characterId: 'character-1',
            roomId: 'room-1',
            prompt,
        })).resolves.toBe('{{inlayed::asset-id}}')

        expect(workflowMocks.beginImageGenerationWorkflow).toHaveBeenCalledWith({
            characterId: 'character-1',
            roomId: 'room-1',
            prompt,
            negativePrompt: '',
            label: 'NovelAI',
            messageId: 'room-1',
            projection: 'return',
        })
    })

    it('rejects image generation when the active chat has no ID', async () => {
        await expect(generateImageThroughWorkflow({
            characterId: 'character-1',
            roomId: undefined,
            prompt: 'portrait',
        })).rejects.toThrow('Image generation requires a chat ID')
        expect(workflowMocks.beginImageGenerationWorkflow).not.toHaveBeenCalled()
    })

    it('waits for each image to complete and finishes the current image before cancelling the rest', async () => {
        let completeCurrent: ((response: Response) => void) | undefined
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { completeCurrent = resolve })))
        workflowMocks.beginImageGenerationWorkflow.mockResolvedValue(imageWorkflow())
        workflowMocks.getRevenantWorkflow.mockResolvedValue(imageWorkflow('completed'))
        const requests = ['smile', 'angry', 'grin'].map(prompt => ({
            characterId: 'character-1', roomId: 'room-1', prompt, negativePrompt: '', label: 'NovelAI',
        }))
        let cancelRequested = false
        const queued = vi.fn()
        const sequence = generateImageWorkflowSequence(requests, {
            onStart: queued,
            shouldStop: () => cancelRequested,
        })
        await vi.waitFor(() => expect(completeCurrent).toBeDefined())
        expect(workflowMocks.beginImageGenerationWorkflow).toHaveBeenCalledTimes(1)
        completeCurrent!(new Response(JSON.stringify({ status: 'completed' })))
        completeCurrent = undefined
        await vi.waitFor(() => expect(completeCurrent).toBeDefined())
        cancelRequested = true
        expect(statusMocks.endStatus).toHaveBeenCalledTimes(1)
        completeCurrent!(new Response(JSON.stringify({ status: 'completed' })))
        await sequence
        expect(statusMocks.endStatus).toHaveBeenCalledTimes(2)
        expect(workflowMocks.beginImageGenerationWorkflow.mock.calls.map(([request]) => request.prompt)).toEqual(['smile', 'angry'])
        workflowMocks.beginImageGenerationWorkflow.mockResolvedValue(imageWorkflow('completed'))
        await generateImageWorkflowSequence([requests[0]], { onStart: queued })
        expect(queued.mock.calls).toEqual([[2], [1], [0]])
    })

    it('stops the sequence when an image fails', async () => {
        workflowMocks.beginImageGenerationWorkflow.mockResolvedValue(imageWorkflow())
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ status: 'failed', error: 'generation failed' })),
        ))
        const request = { characterId: 'character-1', roomId: 'room-1', prompt: 'smile', negativePrompt: '', label: 'NovelAI' }
        await expect(generateImageWorkflowSequence([request, { ...request, prompt: 'angry' }])).rejects.toThrow('generation failed')
        expect(workflowMocks.beginImageGenerationWorkflow).toHaveBeenCalledTimes(1)
    })
})
