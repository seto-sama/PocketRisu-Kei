import { v4 as uuidv4 } from 'uuid'
import { alertConfirm, alertInput, alertSelect } from '../../alert'
import { fetchNative, readImage } from '../../globalApi.svelte'
import { parseChatML } from '../../parser/chatML'
import type { ModelPreset } from '../../preset/types'
import type { character } from '../../storage/database.svelte'
import { asBuffer, getUserIcon } from '../../util'
import { processMultiCommand } from '../command'
import { writeInlayImage } from '../files/inlays'
import { requestModelPresetData } from '../request/request'
import { collectStreamingText } from '../request/shared'
import { generateAIImage } from '../stableDiff'
import type { OpenAIChat } from '../index.svelte'
import type { RevenantClientAction, RevenantWorkflow } from './types'
import {
    claimRevenantWorkflowClientAction,
    resolveRevenantWorkflowClientAction,
} from './workflow'

const runningActions = new Set<string>()

function actionPayload(action: RevenantClientAction): Record<string, unknown> {
    return action.payload && typeof action.payload === 'object' ? action.payload : {}
}

function normalizedPrompt(value: unknown): OpenAIChat[] {
    if (Array.isArray(value)) {
        return value.map(item => {
            const source = item && typeof item === 'object' ? item as Record<string, unknown> : {}
            const rawRole = String(source.role ?? 'assistant')
            return {
                role: rawRole === 'system' || rawRole === 'user' ? rawRole : 'assistant',
                content: String(source.content ?? source.data ?? ''),
            }
        })
    }
    const text = String(value ?? '')
    return parseChatML(text) || [{ role: 'user', content: text }]
}

async function executeProviderAction(
    workflow: RevenantWorkflow,
    stepKey: string,
    action: RevenantClientAction,
    character: character,
): Promise<{ success: boolean, result: unknown }> {
    const payload = actionPayload(action)
    const preset = payload.modelPreset as ModelPreset | undefined
    if (!preset || typeof preset !== 'object') {
        return { success: false, result: 'Error: Missing delegated model preset' }
    }
    const prompt = action.kind === 'provider.simplellm'
        ? [{ role: 'user', content: String(payload.prompt ?? '') }] satisfies OpenAIChat[]
        : normalizedPrompt(payload.prompt)
    const options = payload.options && typeof payload.options === 'object'
        ? payload.options as Record<string, unknown>
        : {}
    const useStreaming = options.streaming === true
    const response = await requestModelPresetData({
        formated: prompt,
        bias: {},
        currentChar: character,
        useStreaming,
        forceStreaming: useStreaming,
        noMultiGen: true,
        revenantClientAction: {
            workflowId: workflow.workflowId,
            parentStepKey: stepKey,
            actionId: action.actionId,
            executionId: uuidv4(),
        },
    }, preset, action.kind === 'provider.axllm' ? 'otherAx' : 'model')
    if (response.type === 'fail') return { success: false, result: `Error: ${response.result}` }
    if (response.type === 'streaming') {
        return { success: true, result: await collectStreamingText(response.result) }
    }
    if (response.type === 'multiline') return { success: false, result: response.result }
    return { success: true, result: response.result }
}

async function imageToInlay(dataUrl: string, name?: string): Promise<string> {
    const image = new Image()
    image.src = dataUrl
    const id = await writeInlayImage(image, name ? { name } : {})
    return id ? `{{inlayed::${id}}}` : ''
}

async function assetToInlay(assetId: string | undefined): Promise<string> {
    if (!assetId) return ''
    const data = await readImage(assetId)
    const extension = assetId.split('.').at(-1) || 'png'
    const url = URL.createObjectURL(new Blob([asBuffer(data)], { type: `image/${extension}` }))
    try {
        return await imageToInlay(url, assetId)
    }
    finally {
        URL.revokeObjectURL(url)
    }
}

async function executeClientAction(
    workflow: RevenantWorkflow,
    stepKey: string,
    action: RevenantClientAction,
    character: character,
): Promise<unknown> {
    const payload = actionPayload(action)
    if (action.kind.startsWith('provider.')) {
        return executeProviderAction(workflow, stepKey, action, character)
    }
    switch (action.kind) {
        case 'ui.input': return alertInput(String(payload.message ?? ''))
        case 'ui.select': return alertSelect(Array.isArray(payload.options) ? payload.options.map(String) : [])
        case 'ui.confirm': return alertConfirm(String(payload.message ?? ''))
        case 'ui.command': return processMultiCommand(String(payload.command ?? ''))
        case 'network.request': {
            const url = String(payload.url ?? '')
            if (url.length > 120 || !url.startsWith('https://')) {
                return JSON.stringify({ status: 400, data: 'Only HTTPS URLs up to 120 characters are allowed' })
            }
            const response = await fetchNative(url, { method: 'GET' })
            return JSON.stringify({ status: response.status, data: await response.text() })
        }
        case 'image.generate': {
            const image = await generateAIImage(
                String(payload.prompt ?? ''),
                character,
                String(payload.negativePrompt ?? ''),
                'inlay',
            )
            return image ? imageToInlay(image) : 'Error: Image generation failed'
        }
        case 'asset.character-image': return assetToInlay(character.image)
        case 'asset.persona-image': return assetToInlay(getUserIcon())
        default: throw new Error(`Unsupported Revenant client action: ${action.kind}`)
    }
}

function canExecuteClientAction(action: RevenantClientAction): boolean {
    if (action.kind.startsWith('provider.')) {
        return actionPayload(action).backend === 'plugin'
    }
    return action.kind.startsWith('ui.')
        || action.kind === 'network.request'
        || action.kind === 'image.generate'
        || action.kind.startsWith('asset.')
}

export async function serviceRevenantClientActions(
    workflow: RevenantWorkflow,
    character: character,
): Promise<boolean> {
    for (const step of workflow.steps) {
        if (step.status !== 'waiting_client') continue
        const action = step.metadata?.action as RevenantClientAction | undefined
        if (!action?.actionId || !action.kind || !canExecuteClientAction(action)) continue
        const key = `${workflow.workflowId}:${step.key}:${action.actionId}`
        if (runningActions.has(key)) return true
        const claim = await claimRevenantWorkflowClientAction(
            workflow.workflowId,
            step.key,
            action.actionId,
        )
        if (!claim) return true
        runningActions.add(key)
        try {
            let result: unknown
            try {
                result = await executeClientAction(workflow, step.key, claim.action, character)
            }
            catch (error) {
                if (!claim.action.kind.startsWith('provider.')) throw error
                result = {
                    success: false,
                    result: `Error: ${error instanceof Error ? error.message : String(error)}`,
                }
            }
            await resolveRevenantWorkflowClientAction(
                workflow.workflowId,
                step.key,
                claim.action.actionId,
                result,
            )
            return true
        }
        finally {
            runningActions.delete(key)
        }
    }
    return false
}
