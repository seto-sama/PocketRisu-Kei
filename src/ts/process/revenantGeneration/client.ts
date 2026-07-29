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

const revenantGenerationJobIds = new Map<string, string>()
const locallyOwnedRevenantGenerationJobs = new Set<string>()
const revenantGenerationCheckpointAt = new Map<string, number>()
const revenantGenerationCheckpointPending = new Map<string, Promise<void>>()
const revenantGenerationMetadata = new Map<string, RevenantGenerationMetadata>()
let revenantGenerationRetentionPruned = false

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

export function setRevenantGenerationLocallyOwned(jobId: string, owned: boolean): void {
    if (owned) {
        locallyOwnedRevenantGenerationJobs.add(jobId)
    }
    else {
        locallyOwnedRevenantGenerationJobs.delete(jobId)
    }
}

export function isRevenantGenerationLocallyOwned(jobId: string): boolean {
    return locallyOwnedRevenantGenerationJobs.has(jobId)
}

export function registerRevenantGenerationMetadata(
    messageChatId: string,
    metadata: RevenantGenerationMetadata,
): void {
    revenantGenerationMetadata.set(messageChatId, metadata)
}

export function getRevenantGenerationMetadata(
    messageChatId: string,
): RevenantGenerationMetadata | undefined {
    return revenantGenerationMetadata.get(messageChatId)
}

export function trackRevenantGenerationJob(messageChatId: string, jobId: string): void {
    revenantGenerationJobIds.set(messageChatId, jobId)
}

export async function updateRevenantGenerationMetadata(
    messageChatId: string,
    metadata: RevenantGenerationMetadata,
): Promise<void> {
    revenantGenerationMetadata.set(messageChatId, metadata)
    const jobId = revenantGenerationJobIds.get(messageChatId)
    if (!jobId) return
    const auth = await createRevenantGenerationAuth()
    const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/metadata`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/json',
            'risu-auth': auth,
            'x-sync-client-id': getRevenantGenerationSyncClientId(),
        },
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
    rawContent: string,
    force = false,
): Promise<void> {
    const jobId = revenantGenerationJobIds.get(messageChatId)
    if (!jobId) return
    const now = Date.now()
    const previous = revenantGenerationCheckpointAt.get(messageChatId) ?? 0
    if (!force && now - previous < 250) return
    revenantGenerationCheckpointAt.set(messageChatId, now)
    const previousWrite = revenantGenerationCheckpointPending.get(messageChatId) ?? Promise.resolve()
    const write = previousWrite.catch(() => {}).then(async () => {
        const auth = await createRevenantGenerationAuth()
        const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/raw-content`, {
            method: 'PUT',
            headers: {
                'content-type': 'application/json',
                'risu-auth': auth,
                'x-sync-client-id': getRevenantGenerationSyncClientId(),
            },
            body: JSON.stringify({ rawContent }),
            keepalive: force,
        })
        if (!response.ok) {
            throw new Error(`Failed to checkpoint generation job: ${response.status}`)
        }
    })
    revenantGenerationCheckpointPending.set(messageChatId, write)
    try {
        await write
    } finally {
        if (revenantGenerationCheckpointPending.get(messageChatId) === write) {
            revenantGenerationCheckpointPending.delete(messageChatId)
        }
    }
}

export async function cancelRevenantGeneration(messageChatId: string): Promise<void> {
    const jobId = revenantGenerationJobIds.get(messageChatId)
    if (!jobId) return
    const auth = await createRevenantGenerationAuth()
    const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: {
            'risu-auth': auth,
            'x-sync-client-id': getRevenantGenerationSyncClientId(),
        },
        keepalive: true,
    })
    if (!response.ok) {
        throw new Error(`Failed to cancel generation job: ${response.status}`)
    }
    setRevenantGenerationLocallyOwned(jobId, false)
}

export async function finalizeRevenantGeneration(
    messageChatId: string,
    rawContent: string,
    message: Message,
    chat: Chat,
): Promise<MaterializedGeneration | undefined> {
    const jobId = revenantGenerationJobIds.get(messageChatId)
    if (!jobId) return
    await checkpointRevenantGeneration(messageChatId, rawContent, true)
    const auth = await createRevenantGenerationAuth()
    const materialized = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/materialize`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'risu-auth': auth,
            'x-sync-client-id': getRevenantGenerationSyncClientId(),
        },
        // Streaming chats are deliberately skipped by the regular save loop.
        // Submit the current chat so materialization cannot rebuild it from a
        // server copy that predates the user's just-sent message.
        body: JSON.stringify({ message, chat }),
    })
    if (!materialized.ok) {
        throw new Error(`Failed to materialize generation: ${materialized.status} ${await materialized.text()}`)
    }
    const result = await materialized.json() as MaterializedGeneration
    setRevenantGenerationLocallyOwned(jobId, false)
    revenantGenerationJobIds.delete(messageChatId)
    revenantGenerationCheckpointAt.delete(messageChatId)
    revenantGenerationCheckpointPending.delete(messageChatId)
    revenantGenerationMetadata.delete(messageChatId)
    return result
}

export async function listRecoverableGenerations(): Promise<RecoverableGenerationJob[]> {
    const auth = await createRevenantGenerationAuth()
    if (!revenantGenerationRetentionPruned) {
        const pruned = await fetch('/api/generation/jobs/prune-materialized', {
            method: 'POST',
            headers: {
                'risu-auth': auth,
                'x-sync-client-id': getRevenantGenerationSyncClientId(),
            },
        })
        if (pruned.ok) revenantGenerationRetentionPruned = true
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
    return data.jobs
}

export async function materializeRecoveredGeneration(
    jobId: string,
    message: Message,
): Promise<MaterializedGeneration> {
    const auth = await createRevenantGenerationAuth()
    const materialized = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/materialize`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'risu-auth': auth,
            'x-sync-client-id': getRevenantGenerationSyncClientId(),
        },
        body: JSON.stringify({ message }),
    })
    if (!materialized.ok) {
        throw new Error(`Failed to materialize recovered generation: ${materialized.status} ${await materialized.text()}`)
    }
    const result = await materialized.json() as MaterializedGeneration
    setRevenantGenerationLocallyOwned(jobId, false)
    return result
}
