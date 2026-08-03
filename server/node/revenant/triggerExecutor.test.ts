// @vitest-environment node
import { describe, expect, it } from 'vitest'
import executorPkg from './triggerExecutor.cjs'

const { executeRevenantOutputTriggers } = executorPkg as {
    executeRevenantOutputTriggers: (options: any) => Promise<any>
}

function recipe() {
    return {
        providerBackend: 'plugin',
        modelPreset: { id: 'plugin-preset' },
        character: {
            name: 'Alice',
            lowLevelAccess: true,
            triggerscript: [{
                type: 'output', conditions: [], lowLevelAccess: true,
                effect: [
                    { type: 'setvar', operator: '=', var: 'mood', value: 'happy' },
                    { type: 'runLLM', value: 'judge {{lastmessage}}', inputVar: 'judge' },
                ],
            }],
        },
        database: { globalChatVariables: {}, templateDefaultVariables: '', username: 'Bob', personas: [] },
        modules: [], moduleTriggers: [],
        chat: { id: 'room-1', message: [{ role: 'char', data: 'answer' }] },
    }
}

describe('revenant output trigger executor', () => {
    it('replays deterministic mutations around a plugin waiting_client action', async () => {
        const waiting = await executeRevenantOutputTriggers({ recipe: recipe(), chat: recipe().chat, text: 'answer' })
        expect(waiting).toMatchObject({
            status: 'waiting_client',
            action: {
                actionId: 'trigger.0.1.provider.llm',
                kind: 'provider.llm',
                payload: { backend: 'plugin' },
            },
        })
        const completed = await executeRevenantOutputTriggers({
            recipe: recipe(), chat: recipe().chat, text: 'answer',
            responses: { 'trigger.0.1.provider.llm': { success: true, result: 'safe' } },
        })
        expect(completed.status).toBe('completed')
        expect(completed.chat.scriptstate).toEqual({ $mood: 'happy', $judge: 'safe' })
    })
})
