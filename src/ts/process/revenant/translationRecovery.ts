import {
    consumeRecoverableAuxiliaryGeneration,
    listRecoverableAuxiliaryGenerations,
    resolveRecoverableAuxiliaryGeneration,
} from './auxiliary'
import {
    createRevenantOperation,
    isRevenantTranslationOperation,
    type RecoverableAuxiliaryJob,
    type RevenantChatMessageTranslationTarget,
    type RevenantTranslationOperation,
} from './types'

export interface RevenantTranslationCache {
    get: (key: string) => Promise<string | null>
    store: (key: string, value: string) => Promise<void>
}

export interface RevenantTranslationRequest {
    cacheKey: string
    requestText: string
    styleDecodes: string[]
    operationContext: RevenantTranslationOperation
}

export interface RevenantTranslationRecoveryOptions {
    force?: boolean
    scope?: {
        characterId: string
        roomId: string
    }
    cacheKey?: string
}

type RecoverableTranslationJob =
    Omit<RecoverableAuxiliaryJob, 'operationContext'>
    & { operationContext: RevenantTranslationOperation }

const recoveringTranslationJobs =
    new Map<string, Promise<RecoverableTranslationJob | null>>()

export function prepareRevenantTranslationRequest(
    text: string,
    replaceExisting: boolean,
    target: RevenantChatMessageTranslationTarget | null = null,
): RevenantTranslationRequest {
    const cacheKey = text
    const styleDecodes: string[] = []
    const requestText = text.replace(
        /<risu-style>(.+?)<\/risu-style>/gms,
        (_match, style: string) => {
            styleDecodes.push(style)
            return `<style-data style-index="${styleDecodes.length - 1}"></style-data>`
        },
    )
    return {
        cacheKey,
        requestText,
        styleDecodes,
        operationContext: createRevenantOperation({
            kind: 'translation',
            cacheKey,
            styleDecodes,
            replaceExisting,
            target,
        }),
    }
}

export function decodeRevenantTranslation(
    content: string,
    styleDecodes: string[],
): string {
    return content
        .replace(/<style-data style-index="(\d+)" ?\/?>/g, (_match, index) =>
            styleDecodes[Number(index)] ?? '')
        .replace(/<\/style-data>/g, '')
}

export async function completeRevenantTranslation(
    cache: RevenantTranslationCache,
    request: RevenantTranslationRequest,
    content: string,
    jobId?: string | null,
): Promise<string> {
    const result = decodeRevenantTranslation(content, request.styleDecodes)
    await cache.store(request.cacheKey, result)
    if (jobId) {
        try {
            await consumeRecoverableAuxiliaryGeneration(jobId)
        }
        catch (error) {
            console.warn('[Translation] Failed to consume completed translation job:', error)
        }
    }
    return result
}

function isMatchingTranslationJob(
    job: RecoverableAuxiliaryJob,
    options: RevenantTranslationRecoveryOptions,
): job is RecoverableTranslationJob {
    if (
        job.jobType !== 'translate'
        || !isRevenantTranslationOperation(job.operationContext)
    ) return false
    if (
        options.scope
        && (
            job.characterId !== options.scope.characterId
            || job.roomId !== options.scope.roomId
        )
    ) return false
    return options.cacheKey === undefined
        || job.operationContext.cacheKey === options.cacheKey
}

async function recoverTranslationJob(
    cache: RevenantTranslationCache,
    job: RecoverableTranslationJob,
): Promise<RecoverableTranslationJob | null> {
    const existing = recoveringTranslationJobs.get(job.jobId)
    if (existing) return await existing

    const recovering = (async () => {
        const resolved = (
            await resolveRecoverableAuxiliaryGeneration(job)
        ) as RecoverableTranslationJob
        const context = resolved.operationContext
        let recovered = false
        const projectedContent = resolved.projection?.content ?? ''
        if (resolved.status === 'generated' && projectedContent.trim()) {
            const existingTranslation = await cache.get(context.cacheKey)
            if (context.replaceExisting || existingTranslation === null) {
                const result = decodeRevenantTranslation(
                    projectedContent,
                    context.styleDecodes,
                )
                if (result !== existingTranslation) {
                    await cache.store(context.cacheKey, result)
                    recovered = true
                }
            }
        }
        await consumeRecoverableAuxiliaryGeneration(resolved.jobId)
        return recovered ? resolved : null
    })()
    recoveringTranslationJobs.set(job.jobId, recovering)
    try {
        return await recovering
    }
    finally {
        if (recoveringTranslationJobs.get(job.jobId) === recovering) {
            recoveringTranslationJobs.delete(job.jobId)
        }
    }
}

export async function recoverRevenantTranslationJobs(
    cache: RevenantTranslationCache,
    options: RevenantTranslationRecoveryOptions = {},
): Promise<number> {
    const jobs = (await listRecoverableAuxiliaryGenerations(options.force))
        .filter(job => isMatchingTranslationJob(job, options))
    const recovered = await Promise.all(
        jobs.map(job => recoverTranslationJob(cache, job)),
    )
    return recovered.filter(Boolean).length
}
