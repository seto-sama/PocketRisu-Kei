import { tick } from 'svelte'
import { createSubscriber } from 'svelte/reactivity'
import { safeStructuredClone } from '../../polyfill'
import {
    type Chat,
    type Message,
    type character,
} from '../../storage/database.svelte'
import { DBState, ReloadChatPointer, selIdState } from '../../stores.svelte'
import { saveChatToServer } from '../../storage/chatStorage'
import { abortStatusesForChat, endStatus, startStatus, type RequestKind } from '../../status/requestStatus'
import { recoverHypaV3SummaryJobs } from '../memory/hypav3'
import { recoverRevenantLuaJobsForChat } from '../scriptings'
import {
    acknowledgeRecoverableTranslation,
    getRecoverableTranslationCacheKeyForTarget,
    isRecoverableTranslationSnapshotLoaded,
    listRecoverableAuxiliaryGenerations,
    subscribeRecoverableTranslations,
} from './auxiliary'
import {
    isRevenantGenerationLocallyObserved,
    listRecoverableGenerations,
    setRevenantGenerationLocallyObserved,
} from './client'
import {
    readRecoverableGenerationContent,
    subscribeRecoverableGeneration,
} from './stream'
import {
    isRevenantJobActive,
    type RecoverableAuxiliaryJob,
    type RecoverableGenerationJob,
    type RevenantChatMessageTranslationTarget,
    type RevenantRerollSnapshot,
    type RevenantWorkflow,
} from './types'
import {
    recoverRevenantTranslationJobs,
    type RevenantTranslationCache,
} from './translationRecovery'
import {
    finishRevenantWorkflow,
    getActiveRevenantWorkflow,
    getRevenantWorkflow,
    getRevenantWorkflowResumeContext,
    type RevenantWorkflowResumeContext,
    updateRevenantWorkflowStep,
} from './workflow'
import { commitCancelledGenerationProjection } from './chatCancellation'
import { serviceRevenantClientActions } from './clientActions.svelte'
import {
    clientActionRecoveryMode,
    mainRecoveryStatusAction,
    shouldWaitForMainJobRegistration,
} from './chatRecoveryPolicy'

interface ChatRecoveryDependencies {
    isChatBusy: () => boolean
}

export interface RevenantChatRecoveryOptions {
    onDeferredRecovered?: (count: number) => void
}

let dependencies: ChatRecoveryDependencies = {
    isChatBusy: () => false,
}

const recoveringGenerationChats = new Set<string>()
const recoveringAuxiliaryGenerationChats = new Set<string>()
const notifiedRecoveryJobs = new Set<string>()
const recoveryRetryAt = new Map<string, number>()
const recoveryFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>()
const recoveryStreamSubscriptions = new Map<string, {
    unsubscribe: () => void
    characterId: string
    roomId: string
    workflowId?: string
    messageChatId: string
    isContinuation: boolean
    rerollSnapshot?: RevenantRerollSnapshot
}>()

function invalidateRecoveredMessage(character: character, messageIndex: number): void {
    character.reloadKeys += 1
    ReloadChatPointer.update(pointers => ({
        ...pointers,
        [messageIndex]: (pointers[messageIndex] ?? 0) + 1,
    }))
}

function resolveCurrentRecoveryTarget(options: {
    characterId: string
    roomId: string
    messageChatId: string
    isContinuation: boolean
    rerollTargetChatId?: string
    rerollTargetIndex?: number
}): { character: character, chat: Chat, message: Message, messageIndex: number } | undefined {
    const currentCharacter = DBState.db.characters.find(item =>
        item?.chaId === options.characterId)
    const currentChat = currentCharacter?.chats.find(item =>
        item?.id === options.roomId && !item._placeholder)
    if (!currentCharacter || !currentChat) return undefined

    let currentMessage = currentChat.message.find(item =>
        item?.chatId === options.messageChatId)
    if (!currentMessage && options.isContinuation) {
        currentMessage = currentChat.message.slice().reverse().find(item =>
            item?.role === 'char')
    }
    if (!currentMessage && options.rerollTargetChatId) {
        currentMessage = currentChat.message.find(item =>
            item?.chatId === options.rerollTargetChatId)
    }
    if (!currentMessage && options.rerollTargetIndex !== undefined) {
        currentMessage = currentChat.message[options.rerollTargetIndex]
    }
    if (!currentMessage) return undefined

    return {
        character: currentCharacter,
        chat: currentChat,
        message: currentMessage,
        messageIndex: currentChat.message.indexOf(currentMessage),
    }
}

export function configureRevenantGenerationChatRecovery(
    nextDependencies: ChatRecoveryDependencies,
): void {
    dependencies = nextDependencies
}

export function clearRevenantRecoveryForChat(
    character: character,
    chat: Chat,
    options: { preserveProjection?: boolean, cancelled?: boolean } = {},
): void {
    let changed = false
    if (options.cancelled) abortStatusesForChat(chat.id)
    for (const [jobId, subscription] of recoveryStreamSubscriptions) {
        if (
            subscription.characterId !== character.chaId
            || subscription.roomId !== chat.id
        ) continue
        if (options.preserveProjection) {
            const currentTarget = resolveCurrentRecoveryTarget({
                characterId: character.chaId,
                roomId: chat.id,
                messageChatId: subscription.messageChatId,
                isContinuation: subscription.isContinuation,
                rerollTargetChatId: subscription.rerollSnapshot?.targetMessage.chatId,
                rerollTargetIndex: subscription.rerollSnapshot?.targetIndex,
            })
            const targetMessage = currentTarget?.message
            commitCancelledGenerationProjection(chat, {
                messageChatId: subscription.messageChatId,
                content: targetMessage?.recoveryDisplayData ?? '',
                isContinuation: subscription.isContinuation,
                targetMessage,
                rerollSnapshot: subscription.rerollSnapshot,
            })
        }
        changed = true
        subscription.unsubscribe()
        recoveryStreamSubscriptions.delete(jobId)
        endStatus(jobId, options.cancelled ? 'aborted' : 'done', { now: Date.now() })
    }
    if (chat.isStreaming) {
        chat.isStreaming = false
        changed = true
    }
    for (const message of chat.message) {
        if (message.isRecovering !== undefined) {
            delete message.isRecovering
            changed = true
        }
        if (message.recoveryDisplayData !== undefined) {
            delete message.recoveryDisplayData
            changed = true
        }
    }
    if (changed) character.reloadKeys += 1
}

function auxiliaryRequestKind(jobType: string): RequestKind {
    switch (jobType) {
        case 'translate': return 'translate'
        case 'memory': return 'memory'
        case 'emotion': return 'emotion'
        default: return 'sub'
    }
}

function startRecoveryStatus(
    jobId: string,
    kind: RequestKind,
    chatId: string,
    startedAt = Date.now(),
): void {
    if (notifiedRecoveryJobs.has(jobId)) return
    notifiedRecoveryJobs.add(jobId)
    startStatus(jobId, {
        kind,
        label: '',
        chatId,
        phase: 'connecting',
        now: startedAt,
    })
}

function updateAuxiliaryRecoveryStatus(job: RecoverableAuxiliaryJob, chatId: string): void {
    if (job.status === 'queued') return
    startRecoveryStatus(
        job.jobId,
        auxiliaryRequestKind(job.jobType),
        chatId,
        job.dispatchedAt ?? Date.now(),
    )
    if (job.status === 'generated') {
        endStatus(job.jobId, 'done', { now: job.completedAt ?? Date.now() })
    }
    else if (job.status === 'cancelled') {
        endStatus(job.jobId, 'aborted', { now: job.completedAt ?? Date.now() })
    }
    else if (!isRevenantJobActive(job.status)) {
        endStatus(job.jobId, 'failed', {
            now: job.completedAt ?? Date.now(),
            error: job.error,
        })
    }
}

function updateMainRecoveryStatus(job: RecoverableGenerationJob, chatId: string): void {
    const action = mainRecoveryStatusAction(
        job.status,
        notifiedRecoveryJobs.has(job.jobId),
    )
    if (action === 'start') {
        startRecoveryStatus(job.jobId, 'main', chatId, job.createdAt)
        return
    }
    // Do not resurrect a toast for a request which already completed before
    // this page observed it. If this page did observe the live request, close
    // that existing status as soon as the provider job becomes terminal,
    // independently of slower Lua/postprocess work.
    if (action === 'none') return
    if (action === 'done') {
        endStatus(job.jobId, 'done', { now: job.completedAt ?? Date.now() })
    }
    else if (action === 'aborted') {
        endStatus(job.jobId, 'aborted', { now: job.completedAt ?? Date.now() })
    }
    else {
        endStatus(job.jobId, 'failed', {
            now: job.completedAt ?? Date.now(),
            error: job.finishReason,
        })
    }
}

function runDeferredRecovery(
    character: character,
    chat: Chat,
    options: RevenantChatRecoveryOptions,
): void {
    const recoveryKey = `${character.chaId}/${chat.id}`
    if (
        dependencies.isChatBusy()
        || recoveringGenerationChats.has(recoveryKey)
    ) {
        scheduleRecoveryFallback(character, chat, options)
        return
    }
    void recoverRevenantGenerationsForChat(character, chat, options)
        .then(recovered => {
            if (recovered > 0) options.onDeferredRecovered?.(recovered)
        })
        .catch(error => {
            console.warn('[GenerationJob] Deferred chat recovery unavailable:', error)
            scheduleRecoveryFallback(character, chat, options)
        })
}

function scheduleRecoveryFallback(
    character: character,
    chat: Chat,
    options: RevenantChatRecoveryOptions,
): void {
    const recoveryKey = `${character.chaId}/${chat.id}`
    if (recoveryFallbackTimers.has(recoveryKey)) return
    const timer = setTimeout(() => {
        recoveryFallbackTimers.delete(recoveryKey)
        runDeferredRecovery(character, chat, options)
    }, 5000)
    recoveryFallbackTimers.set(recoveryKey, timer)
}

async function restoreStoppedReroll(
    character: character,
    chat: Chat,
    context: RevenantWorkflowResumeContext,
): Promise<void> {
    const snapshot = context.rerollSnapshot
    if (!snapshot) return
    const chatIndex = character.chats.findIndex(item => item?.id === chat.id)
    if (chatIndex < 0) return
    const currentChat = character.chats[chatIndex]
    commitCancelledGenerationProjection(currentChat, {
        messageChatId: context.messageChatId,
        content: '',
        isContinuation: context.continue,
        rerollSnapshot: snapshot,
    })
    await saveChatToServer(character.chaId, chatIndex, currentChat.id, currentChat)
}

function scheduleRevenantAuxiliaryRecovery(character: character, chat: Chat): void {
    const recoveryKey = `${character.chaId}/${chat.id}`
    if (
        dependencies.isChatBusy()
        || recoveringAuxiliaryGenerationChats.has(recoveryKey)
    ) return
    recoveringAuxiliaryGenerationChats.add(recoveryKey)
    void (async () => {
        const jobs = (await listRecoverableAuxiliaryGenerations())
            .filter(job =>
                job.characterId === character.chaId
                && job.roomId === chat.id
                && !isRevenantGenerationLocallyObserved(job.jobId))
        if (dependencies.isChatBusy()) return
        jobs
            .filter(job => job.jobType !== 'translate')
            .forEach(job => updateAuxiliaryRecoveryStatus(job, chat.id))

        const recoveredLuaRuns = jobs.some(job => job.jobType === 'otherAx')
            ? await recoverRevenantLuaJobsForChat(character, chat)
            : 0
        if (recoveredLuaRuns > 0) character.reloadKeys += 1
        const recoveredSummaries = jobs.some(job => job.jobType === 'memory')
            ? await recoverHypaV3SummaryJobs(character, chat, {
                onJobUpdate: job => updateAuxiliaryRecoveryStatus(job, chat.id),
            })
            : 0
        if (recoveredSummaries > 0) character.reloadKeys += 1
    })().catch(error => {
        console.warn('[GenerationJob] Auxiliary chat recovery unavailable:', error)
    }).finally(() => {
        recoveringAuxiliaryGenerationChats.delete(recoveryKey)
    })
}

export async function recoverRevenantGenerationsForChat(
    character: character,
    chat: Chat,
    options: RevenantChatRecoveryOptions = {},
): Promise<number> {
    if (dependencies.isChatBusy() || !character?.chaId || !chat?.id || chat._placeholder) return 0
    const recoveryKey = `${character.chaId}/${chat.id}`
    if (recoveringGenerationChats.has(recoveryKey)) return 0
    const scheduledFallback = recoveryFallbackTimers.get(recoveryKey)
    if (scheduledFallback) {
        clearTimeout(scheduledFallback)
        recoveryFallbackTimers.delete(recoveryKey)
    }
    recoveringGenerationChats.add(recoveryKey)
    let recovered = 0
    try {
        let activeWorkflow = await getActiveRevenantWorkflow(character.chaId, chat.id)
        const hasWaitingClientStep = activeWorkflow?.steps.some(step =>
            step.status === 'waiting_client') === true
        const hypaMemoryCheckpoint = activeWorkflow?.steps
            .find(step => step.key === 'memory.hypav3' && step.status === 'completed')
            ?.metadata?.hypaMemory
        const applyHypaMemoryCheckpoint = (target: Chat) => {
            if (
                hypaMemoryCheckpoint
                && typeof hypaMemoryCheckpoint === 'object'
                && Array.isArray((hypaMemoryCheckpoint as { summaries?: unknown }).summaries)
            ) {
                target.hypaV3Data = safeStructuredClone(hypaMemoryCheckpoint) as Chat['hypaV3Data']
            }
        }
        applyHypaMemoryCheckpoint(chat)
        const mainJobs = await listRecoverableGenerations()
        if (dependencies.isChatBusy()) return 0
        const currentChatMainJobs = mainJobs.filter(job =>
            job.characterId === character.chaId
            && job.roomId === chat.id)
        if (
            activeWorkflow
            && currentChatMainJobs.length === 0
            && !hasWaitingClientStep
            && shouldWaitForMainJobRegistration(activeWorkflow.createdAt)
        ) {
            // Prompt construction is deliberately local-only. Wait only for
            // the originating page's adjacent main-job registration call.
            scheduleRecoveryFallback(character, chat, options)
            return 0
        }
        // A terminal server job cannot still have a live local observer
        // once the global chat process is idle. Let recovery finish a previous
        // materialization failure instead of filtering it forever.
        currentChatMainJobs
            .filter(job =>
                !isRevenantJobActive(job.status)
                && isRevenantGenerationLocallyObserved(job.jobId))
            .forEach(job => setRevenantGenerationLocallyObserved(job.jobId, false))
        const waitingClientRecoveryMode = clientActionRecoveryMode(
            hasWaitingClientStep,
            currentChatMainJobs.length,
        )
        if (waitingClientRecoveryMode !== 'none' && activeWorkflow) {
            const clientActionRecovery = serviceRevenantClientActions(activeWorkflow, character)
            if (waitingClientRecoveryMode === 'blocking') {
                await clientActionRecovery
                return 0
            }
            // A post-model Lua/client action may take much longer than the main
            // generation. Recover it concurrently so the completed/streaming
            // main projection below becomes visible immediately.
            void clientActionRecovery
                .catch(error => {
                    console.warn('[GenerationWorkflow] Client action recovery paused:', error)
                })
        }
        if (currentChatMainJobs.length === 0) {
            const detachedSubscription = [...recoveryStreamSubscriptions.values()].find(subscription =>
                subscription.characterId === character.chaId
                && subscription.roomId === chat.id)
            const terminalWorkflow = detachedSubscription?.workflowId
                ? await getRevenantWorkflow(detachedSubscription.workflowId).catch(() => undefined)
                : undefined
            const cancelled = terminalWorkflow?.status === 'cancelled'
            clearRevenantRecoveryForChat(character, chat, {
                preserveProjection: cancelled,
                cancelled,
            })
            if (activeWorkflow) {
                const messageWasMaterialized = activeWorkflow.steps.some(step =>
                    step.key === 'message.materialize' && step.status === 'completed')
                if (messageWasMaterialized) {
                    await updateRevenantWorkflowStep(activeWorkflow.workflowId, 'igp', 'skipped')
                    await updateRevenantWorkflowStep(activeWorkflow.workflowId, 'postprocess', 'skipped')
                    await finishRevenantWorkflow(activeWorkflow.workflowId, 'completed')
                }
                else {
                    // There is no durable provider job to recover. Never run
                    // another device's trigger, Lua, tokenization, or prompt
                    // assembly. Treat the abandoned submission boundary as a
                    // failed request and restore a reroll branch if necessary.
                    const resumeContext = getRevenantWorkflowResumeContext(activeWorkflow)
                    await updateRevenantWorkflowStep(
                        activeWorkflow.workflowId,
                        'model.main',
                        'failed',
                        { error: 'Main generation job was not registered' },
                    ).catch(() => {})
                    await finishRevenantWorkflow(activeWorkflow.workflowId, 'failed').catch(() => {})
                    if(resumeContext){
                        await restoreStoppedReroll(character, chat, resumeContext).catch(error => {
                            console.warn('[GenerationWorkflow] Failed to restore stopped reroll:', error)
                        })
                    }
                }
            }
        }
        const isDetachedJobForCurrentChat = (job: {
            jobId: string
            characterId?: string
            roomId?: string
        }) =>
            job.characterId === character.chaId
            && job.roomId === chat.id
            && !isRevenantGenerationLocallyObserved(job.jobId)

        const jobs = mainJobs
            .filter(isDetachedJobForCurrentChat)
            .sort((a, b) => a.createdAt - b.createdAt)
        jobs.forEach(job => updateMainRecoveryStatus(job, chat.id))
        for (const job of jobs) {
            const messageChatId = job.chatId
            if (Date.now() < (recoveryRetryAt.get(job.jobId) ?? 0)) break
            const isActiveGeneration = isRevenantJobActive(job.status)
            const existingMessage = chat.message.find(message => message?.chatId === messageChatId)
            const rerollSnapshot = job.rerollSnapshot
            let snapshotTarget: Message | undefined
            if (rerollSnapshot) {
                const snapshotId = rerollSnapshot.targetMessage.chatId
                snapshotTarget = snapshotId
                    ? chat.message.find(message => message?.chatId === snapshotId)
                    : chat.message[rerollSnapshot.targetIndex]
                snapshotTarget ??= chat.message[rerollSnapshot.targetIndex]
                if (!snapshotTarget) {
                    snapshotTarget = safeStructuredClone(rerollSnapshot.targetMessage)
                    chat.message.splice(
                        rerollSnapshot.targetIndex,
                        Math.max(0, chat.message.length - rerollSnapshot.targetIndex),
                        snapshotTarget,
                        ...safeStructuredClone(rerollSnapshot.trailingMessages),
                    )
                }
            }
            const continuationTarget = job.isContinuation
                ? chat.message.slice().reverse().find(message => message?.role === 'char')
                : undefined
            const targetMessage = continuationTarget ?? snapshotTarget ?? existingMessage
            const msgIndex = targetMessage
                ? chat.message.indexOf(targetMessage)
                : chat.message.length
            const message: Message = targetMessage ?? {
                role: 'char',
                data: '',
            }
            if (job.status === 'cancelled') {
                const recoveredContent = await readRecoverableGenerationContent(job)
                const projectedContent = job.isContinuation
                    && job.continuationPrefix
                    && !recoveredContent.startsWith(job.continuationPrefix)
                    ? job.continuationPrefix + recoveredContent
                    : recoveredContent
                commitCancelledGenerationProjection(chat, {
                    messageChatId,
                    content: projectedContent,
                    isContinuation: job.isContinuation === true,
                    targetMessage,
                    rerollSnapshot,
                })
                endStatus(job.jobId, 'aborted', { now: job.completedAt ?? Date.now() })
                invalidateRecoveredMessage(character, Math.max(0, msgIndex))
                recovered++
                continue
            }
            const hasLiveRecoveryStream = recoveryStreamSubscriptions.has(job.jobId)
            const previousRecoveryDisplay = message.recoveryDisplayData
            const wasRecovering = message.isRecovering === true
            chat.isStreaming = true
            message.isRecovering = true
            if (!hasLiveRecoveryStream) {
                if (job.projection?.content) {
                    message.recoveryDisplayData = job.projection.content
                }
                else {
                    delete message.recoveryDisplayData
                }
            }
            Object.assign(message, {
                saying: character.chaId,
                time: job.completedAt || job.updatedAt || Date.now(),
                generationInfo: job.generationInfo ?? {
                    generationId: messageChatId,
                    model: 'Recovered server generation',
                },
                promptInfo: job.promptInfo,
            })
            // A continuation/reroll displays its live projection over the old
            // message without replacing that message's durable identity. The
            // new generation id is committed only after successful completion.
            if (!continuationTarget && !snapshotTarget) message.chatId = messageChatId
            if (!targetMessage) chat.message.push(message)
            if (
                !wasRecovering
                || previousRecoveryDisplay !== message.recoveryDisplayData
                || !targetMessage
            ) {
                invalidateRecoveredMessage(character, msgIndex)
                await tick()
            }
            if (isActiveGeneration) {
                if (!recoveryStreamSubscriptions.has(job.jobId)) {
                    const unsubscribe = subscribeRecoverableGeneration(job, {
                        onContent: content => {
                            const displayContent = job.isContinuation
                                && job.continuationPrefix
                                && !content.startsWith(job.continuationPrefix)
                                ? job.continuationPrefix + content
                                : content
                            // Chat hydration/database invalidation can replace the
                            // objects captured when the socket was attached. Resolve
                            // the currently displayed objects for every event so the
                            // stream never keeps writing into a detached snapshot.
                            const currentTarget = resolveCurrentRecoveryTarget({
                                characterId: character.chaId,
                                roomId: chat.id,
                                messageChatId,
                                isContinuation: job.isContinuation,
                                rerollTargetChatId: rerollSnapshot?.targetMessage.chatId,
                                rerollTargetIndex: rerollSnapshot?.targetIndex,
                            })
                            const liveCharacter = currentTarget?.character ?? character
                            const liveChat = currentTarget?.chat ?? chat
                            const liveMessage = currentTarget?.message ?? message
                            const liveMessageIndex = currentTarget?.messageIndex ?? msgIndex
                            if (liveMessage.recoveryDisplayData === displayContent) return
                            liveMessage.recoveryDisplayData = displayContent
                            liveMessage.isRecovering = true
                            liveChat.isStreaming = true
                            // Chats.svelte is manually mounted and uses this store as
                            // its explicit render invalidation signal. Updating only
                            // character.reloadKeys leaves a reattached recovery stream
                            // invisible until the completed chat is materialized.
                            invalidateRecoveredMessage(liveCharacter, liveMessageIndex)
                        },
                        onDone: () => {
                            // Keep the subscription context until the database
                            // refresh classifies the workflow as completed or
                            // cancelled. Cancellation needs it to commit the
                            // last displayed recovery projection.
                            setTimeout(() => {
                                runDeferredRecovery(character, chat, options)
                            })
                        },
                        onError: error => {
                            recoveryStreamSubscriptions.delete(job.jobId)
                            console.warn('[GenerationJob] Live recovery stream unavailable; using database fallback:', error)
                            scheduleRecoveryFallback(character, chat, options)
                        },
                    })
                    recoveryStreamSubscriptions.set(job.jobId, {
                        unsubscribe,
                        characterId: character.chaId,
                        roomId: chat.id,
                        workflowId: job.workflowId,
                        messageChatId,
                        isContinuation: job.isContinuation === true,
                        rerollSnapshot,
                    })
                }
                break
            }
            const activeSubscription = recoveryStreamSubscriptions.get(job.jobId)
            if (activeSubscription) {
                activeSubscription.unsubscribe()
                recoveryStreamSubscriptions.delete(job.jobId)
            }
            // Terminal chat jobs are completed by the server postprocess worker.
            // Keep the raw preview until its database invalidation hydrates the
            // canonical materialized chat; the browser never re-runs scripts.
            recoveryRetryAt.set(job.jobId, Date.now() + 1000)
            break
        }
        if (jobs.length === 0 || recovered === jobs.length) {
            scheduleRevenantAuxiliaryRecovery(character, chat)
        }
        return recovered
    }
    finally {
        recoveringGenerationChats.delete(recoveryKey)
    }
}

type ParseMode = 'normal' | 'back' | 'pretranslate' | 'notrim'
type ParseMessageMarkdown = (data: string, mode: ParseMode) => Promise<string>

export interface RevenantChatTranslationRecoveryScope {
    characterId: string
    roomId: string
}

export interface RevenantChatTranslationRecoverySnapshot {
    pending: boolean
    cacheKey: string | null
    scope: RevenantChatTranslationRecoveryScope | null
    target: RevenantChatMessageTranslationTarget | null
}

export interface RevenantChatTranslationRecovery {
    readonly pending: boolean
    readonly inspectionReady: boolean
    capture: () => RevenantChatTranslationRecoverySnapshot
    shouldDisplayTranslation: (
        snapshot: RevenantChatTranslationRecoverySnapshot,
        options: {
            data: string
            translated: boolean
            streaming: boolean
            parseMarkdown: ParseMessageMarkdown
        },
    ) => Promise<boolean>
    waitForResult: (
        snapshot: RevenantChatTranslationRecoverySnapshot,
    ) => Promise<void>
    acknowledgeResolved: (
        snapshot: RevenantChatTranslationRecoverySnapshot,
    ) => Promise<void>
}

export interface RevenantChatTranslationRecoveryContext {
    trackSnapshot: () => void
}

export function createRevenantChatTranslationRecoveryContext(): RevenantChatTranslationRecoveryContext {
    const trackRecoverableTranslations = createSubscriber((update) =>
        subscribeRecoverableTranslations(update)
    )
    return { trackSnapshot: trackRecoverableTranslations }
}

export function createRevenantChatTranslationRecovery(options: {
    getTarget: () => RevenantChatMessageTranslationTarget | null
    translationCache: RevenantTranslationCache
    getContext?: () => RevenantChatTranslationRecoveryContext | undefined
    getScope?: () => RevenantChatTranslationRecoveryScope | null | undefined
}): RevenantChatTranslationRecovery {
    let fallbackContext: RevenantChatTranslationRecoveryContext | undefined
    let lastSnapshot: RevenantChatTranslationRecoverySnapshot | undefined

    function currentContext(): RevenantChatTranslationRecoveryContext {
        return options.getContext?.()
            ?? (fallbackContext ??= createRevenantChatTranslationRecoveryContext())
    }

    function currentScope(): RevenantChatTranslationRecoveryScope | null {
        const explicitScope = options.getScope?.()
        if (explicitScope !== undefined) return explicitScope
        const currentCharacter = DBState.db.characters[selIdState.selId]
        const currentChat = currentCharacter?.chats[currentCharacter.chatPage]
        return currentCharacter?.chaId && currentChat?.id
            ? {
                characterId: currentCharacter.chaId,
                roomId: currentChat.id,
            }
            : null
    }

    function capture(): RevenantChatTranslationRecoverySnapshot {
        currentContext().trackSnapshot()
        const scope = currentScope()
        const target = options.getTarget()
        const cacheKey = scope && target
            ? getRecoverableTranslationCacheKeyForTarget({ ...scope, target })
            : null
        const pending = cacheKey !== null
        if (
            lastSnapshot
            && lastSnapshot.pending === pending
            && lastSnapshot.cacheKey === cacheKey
            && lastSnapshot.scope?.characterId === scope?.characterId
            && lastSnapshot.scope?.roomId === scope?.roomId
            && lastSnapshot.target?.kind === target?.kind
            && lastSnapshot.target?.messageChatId === target?.messageChatId
            && lastSnapshot.target?.messageIndex === target?.messageIndex
            && lastSnapshot.target?.swipeId === target?.swipeId
        ) {
            return lastSnapshot
        }
        lastSnapshot = {
            pending,
            cacheKey,
            scope: scope ? { ...scope } : null,
            target: target ? { ...target } : null,
        }
        return lastSnapshot
    }

    async function shouldDisplayTranslation(
        snapshot: RevenantChatTranslationRecoverySnapshot,
        renderOptions: {
            data: string
            translated: boolean
            streaming: boolean
            parseMarkdown: ParseMessageMarkdown
        },
    ): Promise<boolean> {
        if (renderOptions.streaming) return false
        if (!renderOptions.data.trim()) return false
        if (snapshot.pending || renderOptions.translated) return true
        if (!DBState.db.autoTranslate) return false
        if (
            !DBState.db.autoTranslateCachedOnly
            || DBState.db.translatorType !== 'llm'
        ) return true

        const translationCacheKey = snapshot.cacheKey
            ?? (DBState.db.translateBeforeHTMLFormatting
                ? renderOptions.data
                : !DBState.db.legacyTranslation
                    ? await renderOptions.parseMarkdown(renderOptions.data, 'pretranslate')
                    : await renderOptions.parseMarkdown(renderOptions.data, 'notrim'))
        // The caller can reuse the key for the cached translation render. It
        // came either from the matching revenant job or from the one cache
        // lookup auto-translate already had to perform.
        snapshot.cacheKey = translationCacheKey
        const cached = await options.translationCache.get(translationCacheKey) !== null
        return cached
    }

    async function waitForResult(
        snapshot: RevenantChatTranslationRecoverySnapshot,
    ): Promise<void> {
        if (!snapshot.pending || !snapshot.cacheKey || !snapshot.scope) return
        await recoverRevenantTranslationJobs(options.translationCache, {
            force: true,
            scope: snapshot.scope,
            cacheKey: snapshot.cacheKey,
        })
    }

    async function acknowledgeResolved(
        snapshot: RevenantChatTranslationRecoverySnapshot,
    ): Promise<void> {
        if (
            !snapshot.pending
            || !snapshot.cacheKey
            || !snapshot.scope
            || await options.translationCache.get(snapshot.cacheKey) === null
        ) return
        acknowledgeRecoverableTranslation({
            cacheKey: snapshot.cacheKey,
            ...snapshot.scope,
        })
    }

    return {
        get pending() {
            return capture().pending
        },
        get inspectionReady() {
            currentContext().trackSnapshot()
            return DBState.db.translatorType !== 'llm'
                || currentScope() === null
                || isRecoverableTranslationSnapshotLoaded()
        },
        capture,
        shouldDisplayTranslation,
        waitForResult,
        acknowledgeResolved,
    }
}
