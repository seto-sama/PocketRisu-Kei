import {
    createRevenantGenerationAuth,
    getRevenantGenerationSyncClientId,
    isRevenantGenerationLocallyOwned,
    setRevenantGenerationLocallyOwned,
} from './client'
import {
    isRevenantJobActive,
    isRevenantTranslationOperation,
    type RevenantOperationContext,
    type RecoverableAuxiliaryJob,
} from './types'
import { readRecoverableGenerationContent } from './stream'

let auxiliaryGenerationListCache: {
    at: number
    jobs: RecoverableAuxiliaryJob[]
} | undefined
let auxiliaryGenerationListInFlight: Promise<RecoverableAuxiliaryJob[]> | undefined
let auxiliaryGenerationSnapshot: RecoverableAuxiliaryJob[] = []
let auxiliaryGenerationSnapshotLoaded = false
let recoverableTranslationSnapshotSignature = ''
const recoverableTranslationListeners = new Set<() => void>()
const recoveredTranslationIntents = new Map<string, string>()
const consumedAuxiliaryGenerationIds = new Set<string>()
const consumingAuxiliaryGenerations = new Map<string, Promise<void>>()
let auxiliaryGenerationListRequestId = 0
let latestCommittedAuxiliaryGenerationListRequestId = 0

function isTranslationPending(job: RecoverableAuxiliaryJob): boolean {
    return isRevenantJobActive(job.status) || job.status === 'generated'
}

function translationIntentKey(options: {
    cacheKey: string
    characterId: string
    roomId: string
}): string {
    return JSON.stringify([options.characterId, options.roomId, options.cacheKey])
}

function getTranslationJobKey(job: RecoverableAuxiliaryJob): {
    cacheKey: string
    characterId: string
    roomId: string
} | undefined {
    if (
        job.jobType !== 'translate'
        || !job.characterId
        || !job.roomId
        || !isRevenantTranslationOperation(job.operationContext)
    ) return
    return {
        cacheKey: job.operationContext.cacheKey,
        characterId: job.characterId,
        roomId: job.roomId,
    }
}

function notifyRecoverableTranslationSnapshot(): void {
    const liveSignatures: string[] = []
    for (const job of auxiliaryGenerationSnapshot) {
        const key = getTranslationJobKey(job)
        if (
            !key
            || !isTranslationPending(job)
            || isRevenantGenerationLocallyOwned(job.jobId)
        ) continue
        liveSignatures.push([
            job.jobId,
            job.status,
            key.characterId,
            key.roomId,
            key.cacheKey,
        ].join('\u0000'))
    }
    const nextSignature = [
        auxiliaryGenerationSnapshotLoaded ? 'loaded' : 'loading',
        ...liveSignatures.sort(),
        ...Array.from(recoveredTranslationIntents.entries())
            .map(([jobId, key]) => `${jobId}\u0000${key}`)
            .sort(),
    ].join('\u0001')
    if (nextSignature === recoverableTranslationSnapshotSignature) return
    recoverableTranslationSnapshotSignature = nextSignature
    recoverableTranslationListeners.forEach(listener => listener())
}

function updateAuxiliaryGenerationSnapshot(jobs: RecoverableAuxiliaryJob[]): void {
    auxiliaryGenerationSnapshot = jobs.filter(job =>
        !consumedAuxiliaryGenerationIds.has(job.jobId))
    auxiliaryGenerationSnapshotLoaded = true
    notifyRecoverableTranslationSnapshot()
}

function updateAuxiliaryGenerationJob(job: RecoverableAuxiliaryJob): void {
    if (consumedAuxiliaryGenerationIds.has(job.jobId)) return
    const index = auxiliaryGenerationSnapshot.findIndex(item => item.jobId === job.jobId)
    const jobs = auxiliaryGenerationSnapshot.slice()
    if (index >= 0) jobs[index] = job
    else jobs.push(job)
    updateAuxiliaryGenerationSnapshot(jobs)
}

export function subscribeRecoverableTranslations(listener: () => void): () => void {
    recoverableTranslationListeners.add(listener)
    return () => recoverableTranslationListeners.delete(listener)
}

export function hasRecoverableTranslation(options: {
    cacheKey: string
    characterId: string
    roomId: string
}): boolean {
    const intentKey = translationIntentKey(options)
    if (Array.from(recoveredTranslationIntents.values()).includes(intentKey)) return true
    return auxiliaryGenerationSnapshot.some(job =>
        !isRevenantGenerationLocallyOwned(job.jobId)
        && isTranslationPending(job)
        && getTranslationJobKey(job)?.cacheKey === options.cacheKey
        && job.characterId === options.characterId
        && job.roomId === options.roomId)
}

export function isRecoverableTranslationSnapshotLoaded(): boolean {
    return auxiliaryGenerationSnapshotLoaded
}

export function acknowledgeRecoverableTranslation(options: {
    cacheKey: string
    characterId: string
    roomId: string
}): void {
    const intentKey = translationIntentKey(options)
    let changed = false
    for (const [jobId, key] of recoveredTranslationIntents) {
        if (key !== intentKey) continue
        recoveredTranslationIntents.delete(jobId)
        changed = true
    }
    if (!changed) return
    notifyRecoverableTranslationSnapshot()
}

export async function listRecoverableAuxiliaryGenerations(
    force = false,
): Promise<RecoverableAuxiliaryJob[]> {
    if (!force && auxiliaryGenerationListCache && Date.now() - auxiliaryGenerationListCache.at < 500) {
        return auxiliaryGenerationListCache.jobs
    }
    if (!force && auxiliaryGenerationListInFlight) return auxiliaryGenerationListInFlight
    const requestId = ++auxiliaryGenerationListRequestId
    const request = (async () => {
        const auth = await createRevenantGenerationAuth()
        const response = await fetch('/api/generation/jobs/auxiliary-recoverable?limit=500', {
            headers: { 'risu-auth': auth },
        })
        if (!response.ok) {
            throw new Error(`Failed to list recoverable auxiliary generations: ${response.status}`)
        }
        const data = await response.json()
        if (!Array.isArray(data?.jobs)) {
            throw new Error('Invalid recoverable auxiliary generation response')
        }
        const jobs = (data.jobs as RecoverableAuxiliaryJob[])
            .filter(job => !consumedAuxiliaryGenerationIds.has(job.jobId))
        if (requestId > latestCommittedAuxiliaryGenerationListRequestId) {
            latestCommittedAuxiliaryGenerationListRequestId = requestId
            auxiliaryGenerationListCache = { at: Date.now(), jobs }
            updateAuxiliaryGenerationSnapshot(jobs)
        }
        return jobs
    })()
    auxiliaryGenerationListInFlight = request
    const clearInFlight = () => {
        if (auxiliaryGenerationListInFlight === request) {
            auxiliaryGenerationListInFlight = undefined
        }
    }
    void request.then(clearInFlight, clearInFlight)
    return request
}

export async function waitForRecoverableAuxiliaryGeneration(
    jobId: string,
    onUpdate?: (job: RecoverableAuxiliaryJob) => void,
): Promise<RecoverableAuxiliaryJob> {
    while (true) {
        const auth = await createRevenantGenerationAuth()
        const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}`, {
            headers: { 'risu-auth': auth },
        })
        if (!response.ok) {
            throw new Error(`Failed to inspect auxiliary generation: ${response.status}`)
        }
        const job = await response.json() as RecoverableAuxiliaryJob
        updateAuxiliaryGenerationJob(job)
        onUpdate?.(job)
        if (!isRevenantJobActive(job.status)) return job
        await new Promise(resolve => setTimeout(resolve, 500))
    }
}

export async function resolveRecoverableAuxiliaryGeneration(
    job: RecoverableAuxiliaryJob,
    onUpdate?: (job: RecoverableAuxiliaryJob) => void,
): Promise<RecoverableAuxiliaryJob> {
    onUpdate?.(job)
    const resolved = isRevenantJobActive(job.status)
        ? await waitForRecoverableAuxiliaryGeneration(job.jobId, onUpdate)
        : job
    if (!resolved.projection?.content && (resolved.rawBytes ?? 0) > 0) {
        const content = await readRecoverableGenerationContent(resolved)
        resolved.projection = {
            schemaVersion: 1,
            source: 'client',
            adapterKind: resolved.adapterKind ?? 'openai-compatible',
            content,
        }
        await updateRecoverableAuxiliaryGenerationProjection(
            resolved.jobId,
            content,
        )
    }
    updateAuxiliaryGenerationJob(resolved)
    return resolved
}

export type TypedRecoverableAuxiliaryJob<T extends RevenantOperationContext> =
    Omit<RecoverableAuxiliaryJob, 'operationContext'> & { operationContext: T }

export async function resolveRecoverableAuxiliaryGenerations<T extends RevenantOperationContext>(
    options: {
        jobType: RecoverableAuxiliaryJob['jobType']
        isContext: (value: unknown) => value is T
        force?: boolean
        matchesContext?: (context: T) => boolean
        matchesJob?: (job: TypedRecoverableAuxiliaryJob<T>) => boolean
        onJobUpdate?: (job: RecoverableAuxiliaryJob) => void
    },
): Promise<TypedRecoverableAuxiliaryJob<T>[]> {
    const jobs = await listRecoverableAuxiliaryGenerations(options.force)
    const matching = jobs.filter((job): job is TypedRecoverableAuxiliaryJob<T> => {
        if (job.jobType !== options.jobType) return false
        const context = job.operationContext
        if (!options.isContext(context)) return false
        const typedJob = job as TypedRecoverableAuxiliaryJob<T>
        return (options.matchesContext?.(context) ?? true)
            && (options.matchesJob?.(typedJob) ?? true)
    })
    return await Promise.all(matching.map(async job =>
        await resolveRecoverableAuxiliaryGeneration(
            job,
            options.onJobUpdate,
        ) as TypedRecoverableAuxiliaryJob<T>))
}

export async function findRecoverableAuxiliaryGeneration(
    predicate: (job: RecoverableAuxiliaryJob) => boolean,
): Promise<RecoverableAuxiliaryJob | undefined> {
    const job = (await listRecoverableAuxiliaryGenerations(true)).find(predicate)
    return job ? await resolveRecoverableAuxiliaryGeneration(job) : undefined
}

async function consumeRecoverableAuxiliaryGenerationOnce(jobId: string): Promise<void> {
    const consumingJob = auxiliaryGenerationSnapshot.find(job => job.jobId === jobId)
    const preserveTranslationIntent = consumingJob
        && !isRevenantGenerationLocallyOwned(jobId)
        && consumingJob.status === 'generated'
        ? getTranslationJobKey(consumingJob)
        : undefined
    if (preserveTranslationIntent) {
        recoveredTranslationIntents.set(
            jobId,
            translationIntentKey(preserveTranslationIntent),
        )
        notifyRecoverableTranslationSnapshot()
    }
    try {
        const auth = await createRevenantGenerationAuth()
        const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/consume`, {
            method: 'POST',
            headers: {
                'risu-auth': auth,
                'x-sync-client-id': getRevenantGenerationSyncClientId(),
            },
        })
        if (!response.ok) {
            throw new Error(`Failed to consume auxiliary generation: ${response.status} ${await response.text()}`)
        }
    }
    catch (error) {
        if (preserveTranslationIntent) {
            recoveredTranslationIntents.delete(jobId)
            notifyRecoverableTranslationSnapshot()
        }
        throw error
    }
    consumedAuxiliaryGenerationIds.add(jobId)
    setRevenantGenerationLocallyOwned(jobId, false)
    auxiliaryGenerationListCache = undefined
    updateAuxiliaryGenerationSnapshot(
        auxiliaryGenerationSnapshot.filter(job => job.jobId !== jobId),
    )
}

export async function consumeRecoverableAuxiliaryGeneration(jobId: string): Promise<void> {
    if (consumedAuxiliaryGenerationIds.has(jobId)) return
    const existing = consumingAuxiliaryGenerations.get(jobId)
    if (existing) return await existing

    const consuming = consumeRecoverableAuxiliaryGenerationOnce(jobId)
    consumingAuxiliaryGenerations.set(jobId, consuming)
    try {
        await consuming
    }
    finally {
        if (consumingAuxiliaryGenerations.get(jobId) === consuming) {
            consumingAuxiliaryGenerations.delete(jobId)
        }
    }
}

export async function updateRecoverableAuxiliaryGenerationProjection(
    jobId: string,
    content: string,
): Promise<void> {
    const auth = await createRevenantGenerationAuth()
    const response = await fetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/projection`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/json',
            'risu-auth': auth,
            'x-sync-client-id': getRevenantGenerationSyncClientId(),
        },
        body: JSON.stringify({ content }),
    })
    if (!response.ok) {
        throw new Error(`Failed to store auxiliary generation result: ${response.status}`)
    }
    auxiliaryGenerationListCache = undefined
}
