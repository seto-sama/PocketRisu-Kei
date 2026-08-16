import { tick } from 'svelte'
import { safeStructuredClone } from '../../../polyfill'
import {
    type Chat,
    type Message,
    type character,
} from '../../../storage/database.svelte'
import { DBState, ReloadChatPointer } from '../../../stores.svelte'
import {
    awaitChatGenerationCanonical,
    beginChatGenerationProjection,
} from '../../../storage/chatWorkingCopy'
import { abortStatusesForChat, endStatus, hasRequestStatus, requestStatusIdForJob, startStatus, type RequestKind } from '../../../status/requestStatus'
import { recoverHypaV3SummaryJobs } from '../../memory/hypav3'
import { recoverRevenantLuaJobsForChat } from '../../scriptings'
import {
    listRecoverableAuxiliaryGenerations,
} from '../auxiliary'
import {
    isRevenantGenerationLocallyObserved,
    listRecoverableGenerations,
    setRevenantGenerationLocallyObserved,
} from '../transport/client'
import {
    readRecoverableGenerationContent,
    subscribeRecoverableGeneration,
} from '../transport/stream'
import {
    isRevenantJobActive,
    type RecoverableAuxiliaryJob,
    type RecoverableGenerationJob,
    type RevenantRerollSnapshot,
    type RevenantWorkflow,
} from '../types'
import {
    finishRevenantWorkflow,
    getActiveRevenantWorkflow,
    getRevenantWorkflow,
    getRevenantWorkflowResumeContext,
    type RevenantWorkflowResumeContext,
    updateRevenantWorkflowStep,
} from '../workflow/workflow'
import { commitCancelledGenerationProjection } from './chatCancellation'
import { serviceRevenantClientActions } from '../workflow/clientActions.svelte'
import {
    clientActionRecoveryMode,
    recoveryStatusAction,
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
    awaitChatGenerationCanonical(character.chaId, chat.id)
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
        endStatus(
            subscription.messageChatId,
            options.cancelled ? 'aborted' : 'done',
            { now: Date.now() },
        )
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
    statusId = jobId,
): void {
    if (notifiedRecoveryJobs.has(jobId)) return
    notifiedRecoveryJobs.add(jobId)
    // Recovery has a server job id in addition to the originating message's
    // generation id. Reuse a live original status instead of creating a
    // second toast for the same response.
    if (hasRequestStatus(statusId)) return
    startStatus(statusId, {
        kind,
        label: '',
        chatId,
        phase: 'connecting',
        now: startedAt,
    })
}

export function updateRevenantAuxiliaryRecoveryStatus(
    job: RecoverableAuxiliaryJob,
    chatId: string,
): void {
    const statusId = requestStatusIdForJob(job)
    const action = recoveryStatusAction(
        job.status,
        notifiedRecoveryJobs.has(job.jobId) || hasRequestStatus(statusId),
        { startQueued: false },
    )
    if (action === 'none') return
    if (action === 'start') {
        startRecoveryStatus(
            job.jobId,
            auxiliaryRequestKind(job.jobType),
            chatId,
            job.dispatchedAt ?? Date.now(),
            statusId,
        )
    }
    else if (action === 'done') {
        endStatus(statusId, 'done', { now: job.completedAt ?? Date.now() })
    }
    else if (action === 'aborted') {
        endStatus(statusId, 'aborted', { now: job.completedAt ?? Date.now() })
    }
    else {
        endStatus(statusId, 'failed', {
            now: job.completedAt ?? Date.now(),
            error: job.error,
        })
    }
}

function updateMainRecoveryStatus(job: RecoverableGenerationJob, chatId: string): void {
    const statusId = requestStatusIdForJob(job)
    const action = recoveryStatusAction(
        job.status,
        notifiedRecoveryJobs.has(job.jobId) || hasRequestStatus(statusId),
    )
    if (action === 'start') {
        startRecoveryStatus(job.jobId, 'main', chatId, job.createdAt, statusId)
        return
    }
    // Do not resurrect a toast for a request which already completed before
    // this page observed it. If this page did observe the live request, close
    // that existing status as soon as the provider job becomes terminal,
    // independently of slower Lua/postprocess work.
    if (action === 'none') return
    if (action === 'done') {
        endStatus(statusId, 'done', { now: job.completedAt ?? Date.now() })
    }
    else if (action === 'aborted') {
        endStatus(statusId, 'aborted', { now: job.completedAt ?? Date.now() })
    }
    else {
        endStatus(statusId, 'failed', {
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
    // The durable workflow input already contains the pre-reroll chat. Keep
    // this local restoration projection-owned until canonical sync arrives.
    awaitChatGenerationCanonical(character.chaId, currentChat.id)
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
            .forEach(job => updateRevenantAuxiliaryRecoveryStatus(job, chat.id))

        const recoveredLuaRuns = jobs.some(job => job.jobType === 'otherAx')
            ? await recoverRevenantLuaJobsForChat(character, chat)
            : 0
        if (recoveredLuaRuns > 0) character.reloadKeys += 1
        const recoveredSummaries = jobs.some(job => job.jobType === 'memory')
            ? await recoverHypaV3SummaryJobs(character, chat, {
                onJobUpdate: job => updateRevenantAuxiliaryRecoveryStatus(job, chat.id),
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
            // The workflow becomes terminal before its provider job and local
            // recovery projection finish shutting down. Active-only lookup can
            // therefore legitimately return null here. Recover ownership from
            // the job's durable workflow instead of letting those UI mutations
            // fall through as an ordinary client edit.
            const ownershipWorkflow = activeWorkflow?.workflowId === job.workflowId
                ? activeWorkflow
                : await getRevenantWorkflow(job.workflowId).catch(() => undefined)
            const workflowBaseChat = ownershipWorkflow?.context?.inputCommit?.chat
            if (
                workflowBaseChat?.id === chat.id
                && Array.isArray(workflowBaseChat.message)
            ) {
                beginChatGenerationProjection(character.chaId, workflowBaseChat, {
                    messageChatId,
                    isContinuation: job.isContinuation,
                    rerollSnapshot: job.rerollSnapshot,
                })
                if (!isActiveGeneration) {
                    awaitChatGenerationCanonical(character.chaId, chat.id)
                }
            }
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
                endStatus(requestStatusIdForJob(job), 'aborted', { now: job.completedAt ?? Date.now() })
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
