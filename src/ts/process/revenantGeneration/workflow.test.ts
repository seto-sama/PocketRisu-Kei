import { describe, expect, it } from 'vitest'
import type { RevenantWorkflow } from './types'
import {
    createRevenantWorkflowResumeMetadata,
    getRevenantWorkflowResumeContext,
} from './workflow'

function workflowWithMetadata(metadata?: Record<string, unknown>): RevenantWorkflow {
    return {
        workflowId: 'workflow-1',
        characterId: 'character-1',
        roomId: 'room-1',
        ownerClientId: 'client-1',
        planVersion: 1,
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
        steps: [{
            key: 'prompt.build',
            kind: 'prompt.build',
            recoveryPolicy: 'resume',
            status: 'pending',
            order: 0,
            metadata,
            updatedAt: 1,
        }],
    }
}

describe('revenant workflow resume checkpoint', () => {
    it('round-trips the stable main message identity and invocation mode', () => {
        const metadata = createRevenantWorkflowResumeMetadata({
            version: 1,
            chatProcessIndex: -1,
            messageChatId: 'message-1',
            continue: true,
        })

        expect(getRevenantWorkflowResumeContext(workflowWithMetadata(metadata))).toEqual({
            version: 1,
            chatProcessIndex: -1,
            messageChatId: 'message-1',
            continue: true,
            rerollSnapshot: undefined,
        })
    })

    it('rejects an incomplete checkpoint instead of guessing', () => {
        expect(getRevenantWorkflowResumeContext(workflowWithMetadata({
            version: 1,
            chatProcessIndex: -1,
            continue: false,
        }))).toBeUndefined()
    })
})
