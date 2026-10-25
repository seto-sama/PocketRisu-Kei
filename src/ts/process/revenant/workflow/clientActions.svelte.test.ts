import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { saveConflictDialog } from '../../../storage/saveConflict'
import type { RevenantWorkflow } from '../types'
import { serviceRevenantClientActions } from './clientActions.svelte'

const mocks = vi.hoisted(() => ({ claim: vi.fn(), resolve: vi.fn() }))
vi.mock('./workflow', async importOriginal => ({
    ...await importOriginal<typeof import('./workflow')>(),
    claimRevenantWorkflowClientAction: mocks.claim,
    resolveRevenantWorkflowClientAction: mocks.resolve,
}))
vi.mock('../../modules', () => ({
    getModules: () => [], getModuleTriggers: () => [], getModuleRegexScripts: () => [], moduleUpdate: vi.fn(),
}))

afterEach(() => {
    get(saveConflictDialog)?.complete(null)
    vi.clearAllMocks()
})

describe('generation variable conflict action', () => {
    it.each([{ choices: ['local' as const] }, { choices: null }])('uses the existing comparison dialog and acknowledges choices: %j', async ({ choices }) => {
        const action = {
            schemaVersion: 1, actionId: 'materialize.conflict:example', kind: 'ui.resolve-conflict',
            payload: { conflicts: [{ path: ['scriptstate', '$score'], base: '10', local: '13', server: '20' }] },
        }
        const workflow = {
            workflowId: 'workflow-1', roomId: 'room-1',
            steps: [{ key: 'message.materialize', status: 'waiting_client', metadata: { action } }],
        } as unknown as RevenantWorkflow
        mocks.claim.mockResolvedValue({ action })
        mocks.resolve.mockResolvedValue(true)

        const pending = serviceRevenantClientActions(workflow, {} as any)
        await vi.waitFor(() => expect(get(saveConflictDialog)).not.toBeNull())
        const dialog = get(saveConflictDialog)!
        expect(dialog.items[0].blocks[0]).toMatchObject({ local: { text: '13' }, server: { text: '20' } })
        dialog.complete(choices)

        await expect(pending).resolves.toBe(true)
        expect(mocks.resolve).toHaveBeenCalledWith('workflow-1', 'message.materialize', action.actionId, choices)
    })
})
