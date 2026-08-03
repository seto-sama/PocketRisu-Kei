import {
    createRevenantCancellationHeaders,
    createRevenantGenerationAuth,
    getRevenantGenerationSyncClientId,
} from './client'
import { writable } from 'svelte/store'
import type {
    RevenantOperationContext,
    RevenantClientAction,
    RevenantClientActionClaim,
    RevenantRerollSnapshot,
    RevenantWorkflow,
    RevenantWorkflowContext,
    RevenantWorkflowExecution,
    RevenantWorkflowPlanStep,
    RevenantWorkflowStatus,
    RevenantWorkflowStepStatus,
} from './types'

const activeWorkflows = new Map<string, RevenantWorkflow>()
export const activeRevenantWorkflows = writable<RevenantWorkflow[]>([])

function roomKey(characterId: string, roomId: string): string {
    return `${characterId}\u0000${roomId}`
}

function publishActiveWorkflows(): void {
    activeRevenantWorkflows.set([...activeWorkflows.values()])
}

function rememberWorkflow(workflow: RevenantWorkflow): RevenantWorkflow {
    const key = roomKey(workflow.characterId, workflow.roomId)
    if (workflow.status === 'active') {
        activeWorkflows.set(key, workflow)
        publishActiveWorkflows()
    }
    else if (activeWorkflows.delete(key)) {
        publishActiveWorkflows()
    }
    return workflow
}

function forgetWorkflow(
    workflowId: string | undefined,
    characterId?: string,
    roomId?: string,
): void {
    let changed = false
    if (characterId && roomId) {
        const key = roomKey(characterId, roomId)
        if (activeWorkflows.delete(key)) {
            changed = true
        }
    }
    if (workflowId) {
        for (const [key, workflow] of activeWorkflows) {
            if (workflow.workflowId === workflowId) {
                activeWorkflows.delete(key)
                changed = true
            }
        }
    }
    if (changed) publishActiveWorkflows()
}

async function revenantHeaders(json = false): Promise<Record<string, string>> {
    return {
        ...(json ? { 'content-type': 'application/json' } : {}),
        'risu-auth': await createRevenantGenerationAuth(),
        'x-sync-client-id': getRevenantGenerationSyncClientId(),
    }
}

async function workflowMutationHeaders(
    _workflowId: string,
    json = false,
): Promise<Record<string, string>> {
    return revenantHeaders(json)
}

export class RevenantWorkflowBusyError extends Error {
    readonly workflow?: RevenantWorkflow

    constructor(workflow?: RevenantWorkflow) {
        super('A generation workflow is already active for this room')
        this.name = 'RevenantWorkflowBusyError'
        this.workflow = workflow
    }
}

export interface RevenantWorkflowResumeContext {
    version: 1
    chatProcessIndex: number
    messageChatId: string
    continue: boolean
    rerollSnapshot?: RevenantRerollSnapshot
}

export function createRevenantWorkflowResumeMetadata(
    context: RevenantWorkflowResumeContext,
): Record<string, unknown> {
    return { ...context }
}

export function createChatGenerationWorkflowPlan(options: {
    resumeContext: RevenantWorkflowResumeContext
    persistUserMessage: boolean
    hypaEnabled: boolean
    igpEnabled: boolean
    pluginProvider: boolean
}): RevenantWorkflowPlanStep[] {
    return [
        {
            key: 'user.persist',
            kind: 'preprocess.user.persist',
            recoveryPolicy: 'resume',
            status: options.persistUserMessage ? 'pending' : 'completed',
        },
        {
            key: 'trigger.start',
            kind: 'preprocess.trigger.start',
            recoveryPolicy: 'at_least_once',
        },
        {
            key: 'memory.hypav3',
            kind: 'preprocess.memory.hypav3',
            recoveryPolicy: 'replay_output',
            status: options.hypaEnabled ? 'pending' : 'skipped',
        },
        {
            key: 'prompt.build',
            kind: 'preprocess.prompt.build',
            recoveryPolicy: 'resume',
            metadata: createRevenantWorkflowResumeMetadata(options.resumeContext),
        },
        {
            key: 'model.dispatch',
            kind: 'model.dispatch.client',
            recoveryPolicy: 'resume',
            status: options.pluginProvider ? 'pending' : 'skipped',
        },
        {
            key: 'model.main',
            kind: 'model.main',
            recoveryPolicy: 'replay_output',
        },
        {
            key: 'output.transform',
            kind: 'postprocess.output.transform',
            recoveryPolicy: 'resume',
        },
        {
            key: 'trigger.output',
            kind: 'postprocess.trigger.output',
            recoveryPolicy: 'at_least_once',
        },
        {
            key: 'igp',
            kind: 'postprocess.igp',
            recoveryPolicy: 'replay_output',
            status: options.igpEnabled ? 'pending' : 'skipped',
        },
        {
            key: 'postprocess',
            kind: 'postprocess.foreground',
            recoveryPolicy: 'foreground_restart',
        },
        {
            key: 'message.materialize',
            kind: 'message.materialize',
            recoveryPolicy: 'resume',
        },
    ]
}

const LOCAL_PRE_MODEL_STEP_KEYS = new Set([
    'user.persist',
    'trigger.start',
    'memory.hypav3',
    'prompt.build',
])

/** Marks the local-only prompt assembly boundary before the workflow is sent. */
export function completeChatGenerationPreModelPlan(
    plan: RevenantWorkflowPlanStep[],
): RevenantWorkflowPlanStep[] {
    return plan.map(step => LOCAL_PRE_MODEL_STEP_KEYS.has(step.key)
        ? {
            ...step,
            status: step.status === 'skipped' ? 'skipped' : 'completed',
        }
        : step)
}

export function getRevenantWorkflowResumeContext(
    workflow: RevenantWorkflow,
): RevenantWorkflowResumeContext | undefined {
    const metadata = workflow.steps.find(step => step.key === 'prompt.build')?.metadata
    if (
        metadata?.version !== 1
        || !Number.isInteger(metadata.chatProcessIndex)
        || typeof metadata.messageChatId !== 'string'
        || !metadata.messageChatId
        || typeof metadata.continue !== 'boolean'
    ) return undefined
    const rerollSnapshot = metadata.rerollSnapshot
    if (
        rerollSnapshot !== undefined
        && (!rerollSnapshot || typeof rerollSnapshot !== 'object' || Array.isArray(rerollSnapshot))
    ) return undefined
    return {
        version: 1,
        chatProcessIndex: metadata.chatProcessIndex as number,
        messageChatId: metadata.messageChatId,
        continue: metadata.continue,
        rerollSnapshot: rerollSnapshot as RevenantRerollSnapshot | undefined,
    }
}

export async function beginRevenantWorkflow(arg: {
    characterId: string
    roomId: string
    plan: RevenantWorkflowPlanStep[]
    context: RevenantWorkflowContext
}): Promise<RevenantWorkflow> {
    const response = await fetch('/api/generation/workflows', {
        method: 'POST',
        headers: await revenantHeaders(true),
        body: JSON.stringify(arg),
    })
    const body = await response.json().catch(() => ({})) as { workflow?: RevenantWorkflow, error?: string }
    if (response.status === 409) {
        if (body.workflow) rememberWorkflow(body.workflow)
        throw new RevenantWorkflowBusyError(body.workflow)
    }
    if (!response.ok || !body.workflow) {
        throw new Error(body.error || `Failed to create generation workflow: ${response.status}`)
    }
    return rememberWorkflow(body.workflow)
}

export function getLocalRevenantWorkflow(
    characterId: string | undefined,
    roomId: string | undefined,
): RevenantWorkflow | undefined {
    if (!characterId || !roomId) return undefined
    return activeWorkflows.get(roomKey(characterId, roomId))
}

export async function getActiveRevenantWorkflow(
    characterId: string,
    roomId: string,
): Promise<RevenantWorkflow | undefined> {
    const query = new URLSearchParams({ characterId, roomId })
    const response = await fetch(`/api/generation/workflows/active?${query}`, {
        headers: await revenantHeaders(),
    })
    if (!response.ok) {
        throw new Error(`Failed to load active generation workflow: ${response.status}`)
    }
    const body = await response.json() as { workflow?: RevenantWorkflow | null }
    if (body.workflow) return rememberWorkflow(body.workflow)
    forgetWorkflow(undefined, characterId, roomId)
    return undefined
}

export async function getRevenantWorkflow(workflowId: string): Promise<RevenantWorkflow> {
    const response = await fetch(
        `/api/generation/workflows/${encodeURIComponent(workflowId)}`,
        { headers: await revenantHeaders() },
    )
    if (!response.ok) {
        throw new Error(`Failed to load generation workflow: ${response.status}`)
    }
    const body = await response.json() as { workflow?: RevenantWorkflow }
    if (!body.workflow) throw new Error('Invalid generation workflow response')
    return rememberWorkflow(body.workflow)
}

export async function updateRevenantWorkflowStep(
    workflowId: string,
    stepKey: string,
    status: RevenantWorkflowStepStatus,
    metadata?: Record<string, unknown>,
): Promise<void> {
    const response = await fetch(
        `/api/generation/workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepKey)}`,
        {
            method: 'PUT',
            headers: await workflowMutationHeaders(workflowId, true),
            body: JSON.stringify({ status, metadata }),
        },
    )
    if (!response.ok) {
        throw new Error(`Failed to update generation workflow step: ${response.status}`)
    }
}

export async function claimRevenantWorkflowClientAction(
    workflowId: string,
    stepKey: string,
    actionId: string,
): Promise<{ action: RevenantClientAction, claim: RevenantClientActionClaim } | undefined> {
    const response = await fetch(
        `/api/generation/workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepKey)}/client-action/claim`,
        {
            method: 'POST',
            headers: await revenantHeaders(true),
            body: JSON.stringify({ actionId }),
        },
    )
    if (response.status === 404 || response.status === 409) return undefined
    const body = await response.json().catch(() => ({})) as {
        action?: RevenantClientAction
        claim?: RevenantClientActionClaim
        error?: string
    }
    if (!response.ok || !body.action || !body.claim) {
        throw new Error(body.error || `Failed to claim workflow client action: ${response.status}`)
    }
    return { action: body.action, claim: body.claim }
}

export async function resolveRevenantWorkflowClientAction(
    workflowId: string,
    stepKey: string,
    actionId: string,
    actionResponse: unknown,
): Promise<void> {
    const response = await fetch(
        `/api/generation/workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepKey)}/client-action/resolve`,
        {
            method: 'POST',
            headers: await revenantHeaders(true),
            body: JSON.stringify({ actionId, response: actionResponse }),
        },
    )
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `Failed to resolve workflow client action: ${response.status}`)
    }
}

export async function finishRevenantWorkflow(
    workflowId: string,
    status: Exclude<RevenantWorkflowStatus, 'active'>,
): Promise<void> {
    const response = await fetch(`/api/generation/workflows/${encodeURIComponent(workflowId)}/finish`, {
        method: 'POST',
        headers: await workflowMutationHeaders(workflowId, true),
        body: JSON.stringify({ status }),
        keepalive: true,
    })
    if (!response.ok) {
        throw new Error(`Failed to finish generation workflow: ${response.status}`)
    }
    forgetWorkflow(workflowId)
}

export async function cancelRevenantWorkflow(workflowId: string): Promise<void> {
    const response = await fetch(
        `/api/generation/workflows/${encodeURIComponent(workflowId)}/cancel`,
        {
            method: 'POST',
            headers: await createRevenantCancellationHeaders(),
            keepalive: true,
        },
    )
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `Failed to cancel generation workflow: ${response.status}`)
    }
    forgetWorkflow(workflowId)
}

export async function cancelRevenantWorkflowStepExecution(
    workflowId: string,
    executionId: string,
): Promise<void> {
    const response = await fetch(
        `/api/generation/workflows/${encodeURIComponent(workflowId)}`
            + `/step-executions/${encodeURIComponent(executionId)}/cancel`,
        {
            method: 'POST',
            headers: await createRevenantCancellationHeaders(),
        },
    )
    if (!response.ok) {
        throw new Error(`Failed to cancel workflow step execution: ${response.status}`)
    }
}

export async function prepareRevenantHypaExecution<TRecipe>(
    workflowId: string,
    recipe: TRecipe,
): Promise<RevenantWorkflowExecution> {
    const response = await fetch(
        `/api/generation/workflows/${encodeURIComponent(workflowId)}/hypav3-execution`,
        {
            method: 'PUT',
            headers: await workflowMutationHeaders(workflowId, true),
            body: JSON.stringify(recipe),
        },
    )
    const body = await response.json().catch(() => ({})) as {
        execution?: RevenantWorkflowExecution
        error?: string
    }
    if (!response.ok || !body.execution) {
        throw new Error(body.error || `Failed to prepare HypaV3 execution: ${response.status}`)
    }
    return body.execution
}

export async function getRevenantHypaExecution<TResult>(
    workflowId: string,
    signal?: AbortSignal,
): Promise<RevenantWorkflowExecution<TResult> | undefined> {
    const response = await fetch(
        `/api/generation/workflows/${encodeURIComponent(workflowId)}/hypav3-execution`,
        { headers: await revenantHeaders(), signal },
    )
    if (response.status === 404) return undefined
    const body = await response.json().catch(() => ({})) as {
        execution?: RevenantWorkflowExecution<TResult>
        error?: string
    }
    if (!response.ok || !body.execution) {
        throw new Error(body.error || `Failed to load HypaV3 execution: ${response.status}`)
    }
    return body.execution
}

export async function waitForRevenantHypaExecution<TResult>(
    workflowId: string,
    signal?: AbortSignal,
): Promise<TResult> {
    while (true) {
        signal?.throwIfAborted()
        const execution = await getRevenantHypaExecution<TResult>(workflowId, signal)
        if (!execution) throw new Error('HypaV3 execution disappeared')
        if (execution.status === 'completed' && execution.result !== undefined) {
            return execution.result
        }
        if (execution.status === 'failed') {
            throw new Error(execution.error || 'Server HypaV3 execution failed')
        }
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(done, 500)
            const abort = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', abort)
                reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
            }
            function done() {
                signal?.removeEventListener('abort', abort)
                resolve()
            }
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) abort()
        })
    }
}

function safeStepPart(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+/, '')
    return normalized.slice(0, 80) || 'unknown'
}

export function getRevenantWorkflowStepKey(
    jobType: string,
    operation: RevenantOperationContext | undefined,
    chatId: string,
): string {
    if (jobType === 'model') return 'model.main'
    if (operation?.kind === 'lua-llm') {
        return `lua.llm:${safeStepPart(operation.executionKey)}:${operation.callIndex}`.slice(0, 128)
    }
    if (operation?.kind === 'hypav3-summary') {
        return `memory.hypav3:${safeStepPart(operation.operationId)}`.slice(0, 128)
    }
    if (operation?.kind === 'translation') {
        return `translation:${safeStepPart(operation.operationId)}`.slice(0, 128)
    }
    return `${safeStepPart(jobType)}:${safeStepPart(chatId)}`.slice(0, 128)
}
