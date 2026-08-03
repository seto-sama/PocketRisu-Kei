import { v4 as uuidv4 } from 'uuid'
import { get } from 'svelte/store'
import { alertConfirm, alertError, alertInput, alertNormal, alertSelect } from '../../alert'
import { fetchNative, readImage } from '../../globalApi.svelte'
import { parseChatML } from '../../parser/chatML'
import type { ModelPreset } from '../../preset/types'
import type { character } from '../../storage/database.svelte'
import { CharEmotion, ReloadChatPointer, ReloadGUIPointer } from '../../stores.svelte'
import { asBuffer, getUserIcon } from '../../util'
import { processMultiCommand } from '../command'
import { writeInlayImage } from '../files/inlays'
import { requestModelPresetData } from '../request/request'
import { collectStreamingText } from '../request/shared'
import { generateAIImage } from '../stableDiff'
import { sayTTS } from '../tts'
import type { OpenAIChat } from '../index.svelte'
import type { RevenantClientAction, RevenantWorkflow } from './types'
import { registerRevenantGenerationMetadata } from './client'
import { coordinateRevenantGeneration } from './coordinator'
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
    signal?: AbortSignal,
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
    if (action.kind === 'provider.main') {
        const chatId = String(options.chatId ?? '')
        if (!chatId) return { success: false, result: 'Missing delegated main generation id' }
        const generationMetadata = payload.generationMetadata
        if (generationMetadata && typeof generationMetadata === 'object') {
            registerRevenantGenerationMetadata(chatId, generationMetadata)
        }
        const coordinated = coordinateRevenantGeneration(lifecycle => requestModelPresetData({
            formated: prompt,
            bias: {},
            currentChar: character,
            useStreaming: true,
            forceStreaming: true,
            noMultiGen: true,
            chatId,
            continue: options.continue === true,
            revenantWorkflowDependency: options.workflowDependency as any,
            onRevenantJobCreated: lifecycle.onJobCreated,
            onRevenantJobRegistrationUnavailable: lifecycle.onJobRegistrationUnavailable,
            onRevenantProviderStarted: lifecycle.onProviderStarted,
            revenantClientAction: {
                workflowId: workflow.workflowId,
                parentStepKey: stepKey,
                actionId: action.actionId,
                executionId: uuidv4(),
                jobStepKey: 'model.main',
            },
        }, preset, 'model', signal ?? null))
        const jobId = await coordinated.registered
        signal?.throwIfAborted()
        if (!jobId) {
            const response = await coordinated.result
            const detail = response.type === 'fail'
                ? response.result
                : 'Plugin provider completed without dispatching a durable model request'
            return { success: false, result: detail }
        }
        // The plugin may expose a stream that API v3 never closes. Once the
        // durable job exists, detach that browser projection if it surfaces;
        // cancelling this ReadableStream only closes the journal observer, not
        // the server-owned provider job.
        void coordinated.result.then(response => {
            if (response.type === 'streaming') return response.result.cancel()
        }).catch(error => {
            if (!signal?.aborted) console.warn('[Revenant] Detached plugin provider failed:', error)
        })
        return { success: true, result: { jobId } }
    }
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
    }, preset, action.kind === 'provider.axllm' ? 'otherAx' : 'model', signal ?? null)
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
    signal?: AbortSignal,
): Promise<unknown> {
    const payload = actionPayload(action)
    if (action.kind.startsWith('provider.')) {
        return executeProviderAction(workflow, stepKey, action, character, signal)
    }
    switch (action.kind) {
        case 'ui.input': return alertInput(String(payload.message ?? ''))
        case 'ui.select': return alertSelect(Array.isArray(payload.options) ? payload.options.map(String) : [])
        case 'ui.confirm': return alertConfirm(String(payload.message ?? ''))
        case 'ui.command': return processMultiCommand(String(payload.command ?? ''))
        case 'ui.effects': {
            const effects = Array.isArray(payload.effects) ? payload.effects : []
            for (const rawEffect of effects) {
                const effect = rawEffect && typeof rawEffect === 'object'
                    ? rawEffect as Record<string, unknown>
                    : {}
                if (effect.kind === 'emotion') {
                    const emotion = character.emotionImages?.find(item => item[0] === effect.name)
                    if (emotion) {
                        const state = get(CharEmotion)
                        const history = state[character.chaId] ?? []
                        history.push([emotion[0], emotion[1], Date.now()])
                        state[character.chaId] = history.slice(-5)
                        CharEmotion.set(state)
                    }
                }
                else if (effect.kind === 'alert') {
                    if (effect.level === 'error') alertError(effect.message)
                    else alertNormal(String(effect.message ?? ''))
                }
                else if (effect.kind === 'reload.display') {
                    ReloadGUIPointer.update(value => value + 1)
                }
                else if (effect.kind === 'reload.chat') {
                    ReloadChatPointer.update(value => {
                        value[character.chatPage] = (value[character.chatPage] ?? 0) + 1
                        return value
                    })
                }
                else if (effect.kind === 'log') console.log(effect.value)
                else if (effect.kind === 'tts') {
                    await sayTTS(character, String(effect.text ?? ''))
                }
                else if (effect.kind === 'notification') {
                    try {
                        const permission = await Notification.requestPermission()
                        if (permission === 'granted') {
                            const notification = new Notification('Risuai', {
                                body: String(effect.text ?? ''),
                            })
                            notification.onclick = () => window.focus()
                        }
                    }
                    catch { /* Notifications are best-effort foreground effects. */ }
                }
                // chat.resend is acknowledged here. The observer starts the
                // next workflow only after this workflow materializes.
            }
            return true
        }
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
    if (action.kind.startsWith('provider.')) return true
    return action.kind.startsWith('ui.')
        || action.kind === 'network.request'
        || action.kind === 'image.generate'
        || action.kind.startsWith('asset.')
}

export async function serviceRevenantClientActions(
    workflow: RevenantWorkflow,
    character: character,
    signal?: AbortSignal,
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
                result = await executeClientAction(
                    workflow,
                    step.key,
                    claim.action,
                    character,
                    signal,
                )
            }
            catch (error) {
                if (signal?.aborted) throw error
                if (!claim.action.kind.startsWith('provider.')) throw error
                result = {
                    success: false,
                    result: `Error: ${error instanceof Error ? error.message : String(error)}`,
                }
            }
            // A successful main provider registration atomically completes the
            // dispatch action on the server alongside model.main creation.
            if (
                claim.action.kind !== 'provider.main'
                || !(result && typeof result === 'object'
                    && (result as { success?: unknown }).success === true)
            ) {
                await resolveRevenantWorkflowClientAction(
                    workflow.workflowId,
                    step.key,
                    claim.action.actionId,
                    result,
                )
            }
            return true
        }
        finally {
            runningActions.delete(key)
        }
    }
    return false
}
