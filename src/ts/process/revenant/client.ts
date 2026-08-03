import type { Chat, Message } from '../../storage/database.svelte'
import type {
    RevenantGenerationMetadata,
    MaterializedGeneration,
    RecoverableGenerationJob,
} from './types'

interface RevenantGenerationClientDependencies {
    createAuth: () => Promise<string>
    getSyncClientId: () => string
}

let dependencies: RevenantGenerationClientDependencies | undefined

const revenantJobIds = new Map<string, string>()
const revenantJobWorkflows = new Map<string, string>()
const revenantWorkflowOwnerEpochs = new Map<string, number>()
const locallyObservedRevenantGenerationJobs = new Set<string>()
const revenantCheckpointAt = new Map<string, number>()
const revenantCheckpointPending = new Map<string, Promise<void>>()
const revenantMetadata = new Map<string, RevenantGenerationMetadata>()
let revenantRetentionPruned = false

export function configureRevenantGenerationClient(
    nextDependencies: RevenantGenerationClientDependencies,
): void {
    dependencies = nextDependencies
}

function requireDependencies(): RevenantGenerationClientDependencies {
    if (!dependencies) {
        throw new Error('Revenant generation client is not configured')
    }
    return dependencies
}

export async function createRevenantGenerationAuth(): Promise<string> {
    const auth = await requireDependencies().createAuth()
    if (!auth) throw new Error('Node auth unavailable')
    return auth
}

export function getRevenantGenerationSyncClientId(): string {
    return requireDependencies().getSyncClientId()
}

export function setRevenantWorkflowOwnerLease(
    workflowId: string,
    ownerEpoch: number | undefined,
): void {
    if (ownerEpoch === undefined) revenantWorkflowOwnerEpochs.delete(workflowId)
    else revenantWorkflowOwnerEpochs.set(workflowId, ownerEpoch)
}

export function trackRevenantGenerationWorkflow(
    jobId: string,
    workflowId: string | undefined,
): void {
    if (workflowId) revenantJobWorkflows.set(jobId, workflowId)
    else revenantJobWorkflows.delete(jobId)
}

/** Explicit user cancellation is never fenced by a workflow owner epoch. */
export async function createRevenantCancellationHeaders(): Promise<Record<string, string>> {
    return {
        'risu-auth': await createRevenantGenerationAuth(),
        'x-sync-client-id': getRevenantGenerationSyncClientId(),
    }
}

export async function createRevenantJobMutationHeaders(
    jobId: string,
    json = false,
): Promise<Record<string, string>> {
    const workflowId = revenantJobWorkflows.get(jobId)
    const ownerEpoch = workflowId
        ? revenantWorkflowOwnerEpochs.get(workflowId)
        : undefined
    if (workflowId && ownerEpoch === undefined) {
        throw new Error('Workflow owner lease is not available for this generation job')
    }
    return {
        ...await createRevenantCancellationHeaders(),
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...(ownerEpoch !== undefined
            ? { 'x-revenant-workflow-owner-epoch': String(ownerEpoch) }
            : {}),
    }
}

export async function reportRevenantGenerationUsage(arg: {
    jobId: string
    timestamp: number
    chatId?: string
    provider?: string
    model?: string
    serviceTier?: string
    usage: unknown
}): Promise<void> {
    const auth = await createRevenantGenerationAuth()
    const response = await fetch(`/api/usage/${encodeURIComponent(arg.jobId)}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'risu-auth': auth,
            'x-sync-client-id': getRevenantGenerationSyncClientId(),
        },
        body: JSON.stringify(arg),
    })
    if (!response.ok) {
        throw new Error(`Failed to report generation usage: ${response.status}`)
    }
}

export function setRevenantGenerationLocallyObserved(jobId: string, observed: boolean): void {
    if (observed) {
        locallyObservedRevenantGenerationJobs.add(jobId)
    }
    else {
        locallyObservedRevenantGenerationJobs.delete(jobId)
    }
}

export function isRevenantGenerationLocallyObserved(jobId: string): boolean {
    return locallyObservedRevenantGenerationJobs.has(jobId)
}

export function registerRevenantGenerationMetadata(
    messageChatId: string,
    metadata: RevenantGenerationMetadata,
): void {
    revenantMetadata.set(messageChatId, metadata)
}

export function getRevenantGenerationMetadata(
    messageChatId: string,
): RevenantGenerationMetadata | undefined {
    return revenantMetadata.get(messageChatId)
}

export function trackRevenantGenerationJob(messageChatId: string, jobId: string): void {
    revenantJobIds.set(messageChatId, jobId)
}

export async function updateRevenantGenerationMetadata(
    messageChatId: string,
    metadata: RevenantGenerationMetadata,
): Promise<void> {
    revenantMetadata.set(messageChatId, metadata)
    const jobId = revenantJobIds.get(messageChatId)
    if (!jobId) return
    const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/metadata`, {
        method: 'PUT',
        headers: await createRevenantJobMutationHeaders(jobId, true),
        body: JSON.stringify({
            generationInfo: metadata.generationInfo,
            promptInfo: metadata.promptInfo,
        }),
    })
    if (!response.ok) {
        throw new Error(`Failed to update generation metadata: ${response.status}`)
    }
}

export async function checkpointRevenantGeneration(
    messageChatId: string,
    content: string,
    force = false,
): Promise<void> {
    const jobId = revenantJobIds.get(messageChatId)
    if (!jobId) return
    const now = Date.now()
    const previous = revenantCheckpointAt.get(messageChatId) ?? 0
    if (!force && now - previous < 250) return
    revenantCheckpointAt.set(messageChatId, now)
    const previousWrite = revenantCheckpointPending.get(messageChatId) ?? Promise.resolve()
    const write = previousWrite.catch(() => {}).then(async () => {
        const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/projection`, {
            method: 'PUT',
            headers: await createRevenantJobMutationHeaders(jobId, true),
            body: JSON.stringify({ content }),
            keepalive: force,
        })
        if (!response.ok) {
            throw new Error(`Failed to checkpoint generation job: ${response.status}`)
        }
    })
    revenantCheckpointPending.set(messageChatId, write)
    try {
        await write
    } finally {
        if (revenantCheckpointPending.get(messageChatId) === write) {
            revenantCheckpointPending.delete(messageChatId)
        }
    }
}

export async function cancelRevenantGeneration(messageChatId: string): Promise<void> {
    const jobId = revenantJobIds.get(messageChatId)
    if (!jobId) return
    const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: await createRevenantCancellationHeaders(),
        keepalive: true,
    })
    if (!response.ok) {
        throw new Error(`Failed to cancel generation job: ${response.status}`)
    }
    setRevenantGenerationLocallyObserved(jobId, false)
    trackRevenantGenerationWorkflow(jobId, undefined)
}

export async function finalizeRevenantGeneration(
    messageChatId: string,
    content: string,
    message: Message,
    chat: Chat,
): Promise<MaterializedGeneration | undefined> {
    const jobId = revenantJobIds.get(messageChatId)
    if (!jobId) return
    await checkpointRevenantGeneration(messageChatId, content, true)
    const materialized = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/materialize`, {
        method: 'POST',
        headers: await createRevenantJobMutationHeaders(jobId, true),
        // Streaming chats are deliberately skipped by the regular save loop.
        // Submit the current chat so materialization cannot rebuild it from a
        // server copy that predates the user's just-sent message.
        body: JSON.stringify({ message, chat }),
    })
    if (!materialized.ok) {
        throw new Error(`Failed to materialize generation: ${materialized.status} ${await materialized.text()}`)
    }
    const result = await materialized.json() as MaterializedGeneration
    setRevenantGenerationLocallyObserved(jobId, false)
    revenantJobIds.delete(messageChatId)
    revenantCheckpointAt.delete(messageChatId)
    revenantCheckpointPending.delete(messageChatId)
    revenantMetadata.delete(messageChatId)
    trackRevenantGenerationWorkflow(jobId, undefined)
    return result
}

export async function listRecoverableGenerations(): Promise<RecoverableGenerationJob[]> {
    const auth = await createRevenantGenerationAuth()
    if (!revenantRetentionPruned) {
        const pruned = await fetch('/api/generation/jobs/prune-retained', {
            method: 'POST',
            headers: {
                'risu-auth': auth,
                'x-sync-client-id': getRevenantGenerationSyncClientId(),
            },
        })
        if (pruned.ok) revenantRetentionPruned = true
    }
    const response = await fetch('/api/generation/jobs/recoverable?limit=200', {
        headers: { 'risu-auth': auth },
    })
    if (!response.ok) {
        throw new Error(`Failed to list recoverable generations: ${response.status}`)
    }
    const data = await response.json()
    if (!Array.isArray(data?.jobs)) {
        throw new Error('Invalid recoverable generation response')
    }
    const jobs = data.jobs as RecoverableGenerationJob[]
    for (const job of jobs) trackRevenantGenerationWorkflow(job.jobId, job.workflowId)
    return jobs
}

export async function materializeRecoveredGeneration(
    jobId: string,
    message: Message,
    chat?: Chat,
): Promise<MaterializedGeneration> {
    const materialized = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/materialize`, {
        method: 'POST',
        headers: await createRevenantJobMutationHeaders(jobId, true),
        body: JSON.stringify({ message, chat }),
    })
    if (!materialized.ok) {
        throw new Error(`Failed to materialize recovered generation: ${materialized.status} ${await materialized.text()}`)
    }
    const result = await materialized.json() as MaterializedGeneration
    setRevenantGenerationLocallyObserved(jobId, false)
    trackRevenantGenerationWorkflow(jobId, undefined)
    return result
}
