import { tick } from 'svelte'
import { createSubscriber } from 'svelte/reactivity'
import { safeStructuredClone } from '../../polyfill'
import {
    normalizeChat,
    type Chat,
    type Message,
    type character,
} from '../../storage/database.svelte'
import { DBState, ReloadChatPointer, selIdState } from '../../stores.svelte'
import { saveChatToServer } from '../../storage/chatStorage'
import { abortStatusesForChat, endStatus, startStatus, type RequestKind } from '../../status/requestStatus'
import { recoverHypaV3SummaryJobs } from '../memory/hypav3'
import { runInlayScreen } from '../inlayScreen'
import { processScriptFull } from '../scripts'
import { recoverRevenantLuaJobsForChat } from '../scriptings'
import { runTrigger } from '../triggers'
import {
    acknowledgeRecoverableTranslation,
    hasRecoverableTranslation,
    isRecoverableTranslationSnapshotLoaded,
    listRecoverableAuxiliaryGenerations,
    subscribeRecoverableTranslations,
} from './auxiliary'
import {
    isRevenantGenerationLocallyOwned,
    listRecoverableGenerations,
    materializeRecoveredGeneration,
    setRevenantGenerationLocallyOwned,
} from './client'
import {
    readRecoverableGenerationContent,
    subscribeRecoverableGeneration,
} from './stream'
import {
    isRevenantJobActive,
    type RecoverableAuxiliaryJob,
    type RevenantRerollSnapshot,
    type RevenantWorkflow,
} from './types'
import {
    recoverRevenantTranslationJobs,
    type RevenantTranslationCache,
} from './translationRecovery'
import {
    finishRevenantWorkflow,
    claimRevenantWorkflow,
    getActiveRevenantWorkflow,
    getRevenantWorkflow,
    getRevenantWorkflowResumeContext,
    RevenantWorkflowOwnedError,
    type RevenantWorkflowResumeContext,
    updateRevenantWorkflowStep,
} from './workflow'
import { commitCancelledGenerationProjection } from './chatCancellation'

interface ChatRecoveryDependencies {
    isChatBusy: () => boolean
    resumeWorkflow: (
        workflow: RevenantWorkflow,
        context: RevenantWorkflowResumeContext,
    ) => Promise<boolean>
}

export interface RevenantChatRecoveryOptions {
    onDeferredRecovered?: (count: number) => void
}

let dependencies: ChatRecoveryDependencies = {
    isChatBusy: () => false,
    resumeWorkflow: async () => false,
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

type PreModelWorkflowRecoveryResult = 'resumed' | 'deferred' | 'paused' | 'stopped'

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

async function executePreModelWorkflowRecovery(
    activeWorkflow: RevenantWorkflow,
    character: character,
    chat: Chat,
): Promise<PreModelWorkflowRecoveryResult> {
    let claimedWorkflow: RevenantWorkflow
    try {
        claimedWorkflow = await claimRevenantWorkflow(activeWorkflow.workflowId)
    }
    catch (error) {
        if (error instanceof RevenantWorkflowOwnedError) return 'deferred'
        console.warn('[GenerationWorkflow] Failed to claim pre-model workflow:', error)
        return 'paused'
    }

    const resumeContext = getRevenantWorkflowResumeContext(claimedWorkflow)
    if (!resumeContext) {
        await updateRevenantWorkflowStep(
            claimedWorkflow.workflowId,
            'prompt.build',
            'failed',
        ).catch(() => {})
        await finishRevenantWorkflow(claimedWorkflow.workflowId, 'failed').catch(() => {})
        return 'stopped'
    }

    const hypaStep = claimedWorkflow.steps.find(step => step.key === 'memory.hypav3')
    if (hypaStep?.status !== 'skipped') {
        try {
            // Finish or consume provider jobs that the detached page already
            // submitted. Terminal failure (especially server interruption)
            // stops here instead of issuing the paid request again.
            await recoverHypaV3SummaryJobs(character, chat, {
                workflowId: claimedWorkflow.workflowId,
                rejectFailed: true,
                force: true,
                onJobUpdate: job => updateAuxiliaryRecoveryStatus(job, chat.id),
            })
        }
        catch (error) {
            console.warn('[GenerationWorkflow] HypaV3 recovery stopped:', error)
            await updateRevenantWorkflowStep(
                claimedWorkflow.workflowId,
                'memory.hypav3',
                'failed',
            ).catch(() => {})
            await finishRevenantWorkflow(claimedWorkflow.workflowId, 'failed').catch(() => {})
            await restoreStoppedReroll(character, chat, resumeContext).catch(error => {
                console.warn('[GenerationWorkflow] Failed to restore stopped reroll:', error)
            })
            return 'stopped'
        }
    }

    try {
        const resumed = await dependencies.resumeWorkflow(claimedWorkflow, resumeContext)
        if (resumed) return 'resumed'
        await restoreStoppedReroll(character, chat, resumeContext).catch(error => {
            console.warn('[GenerationWorkflow] Failed to restore stopped reroll:', error)
        })
        return 'stopped'
    }
    catch (error) {
        // If the main provider job was created before this client-side failure,
        // the ordinary main journal recovery path owns the next attempt.
        console.warn('[GenerationWorkflow] Pre-model executor paused:', error)
        return 'paused'
    }
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
                && !isRevenantGenerationLocallyOwned(job.jobId))
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
    recoveringGenerationChats.add(recoveryKey)
    let recovered = 0
    let deferAuxiliaryRecovery = false
    try {
        const activeWorkflow = await getActiveRevenantWorkflow(character.chaId, chat.id)
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
        // A terminal server job cannot still be owned by a live local request
        // once the global chat process is idle. Let recovery finish a previous
        // materialization failure instead of filtering it forever.
        currentChatMainJobs
            .filter(job =>
                !isRevenantJobActive(job.status)
                && isRevenantGenerationLocallyOwned(job.jobId))
            .forEach(job => setRevenantGenerationLocallyOwned(job.jobId, false))
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
                    const executorResult = await executePreModelWorkflowRecovery(
                        activeWorkflow,
                        character,
                        chat,
                    )
                    if (executorResult === 'resumed') recovered += 1
                    if (executorResult === 'deferred' || executorResult === 'paused') {
                        deferAuxiliaryRecovery = true
                    }
                    if (executorResult === 'deferred' || executorResult === 'paused') {
                        scheduleRecoveryFallback(character, chat, options)
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
            && !isRevenantGenerationLocallyOwned(job.jobId)

        const jobs = mainJobs
            .filter(isDetachedJobForCurrentChat)
            .sort((a, b) => a.createdAt - b.createdAt)
        jobs.forEach(job => startRecoveryStatus(job.jobId, 'main', chat.id))
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
            const recoveredContent = await readRecoverableGenerationContent(job)
            const projectedContent = job.isContinuation
                && job.continuationPrefix
                && !recoveredContent.startsWith(job.continuationPrefix)
                ? job.continuationPrefix + recoveredContent
                : recoveredContent
            if (job.workflowId) {
                await updateRevenantWorkflowStep(job.workflowId, 'output.transform', 'running')
            }
            const processedContent = (await processScriptFull(
                character,
                projectedContent.trim(),
                'editoutput',
                msgIndex,
            )).data
            if (job.workflowId) {
                await updateRevenantWorkflowStep(job.workflowId, 'output.transform', 'completed')
                await updateRevenantWorkflowStep(job.workflowId, 'trigger.output', 'running')
            }
            // Hydration can replace the chat while output processing awaits.
            // Apply the completed response and run Lua against the live room.
            const terminalTarget = resolveCurrentRecoveryTarget({
                characterId: character.chaId,
                roomId: chat.id,
                messageChatId,
                isContinuation: job.isContinuation,
                rerollTargetChatId: rerollSnapshot?.targetMessage.chatId,
                rerollTargetIndex: rerollSnapshot?.targetIndex,
            })
            const recoveryCharacter = terminalTarget?.character ?? character
            let recoveredChat = terminalTarget?.chat ?? chat
            applyHypaMemoryCheckpoint(recoveredChat)
            const recoveredMessage = terminalTarget?.message ?? message
            const recoveredMessageIndex = terminalTarget?.messageIndex ?? msgIndex
            const inlay = runInlayScreen(recoveryCharacter, processedContent)
            Object.assign(recoveredMessage, {
                data: inlay.text,
                saying: recoveryCharacter.chaId,
                time: job.completedAt || job.updatedAt || Date.now(),
                chatId: messageChatId,
                generationInfo: job.generationInfo ?? {
                    generationId: messageChatId,
                    model: 'Recovered server generation',
                },
                promptInfo: job.promptInfo,
            })
            if (inlay.promise) {
                recoveredMessage.data = await inlay.promise
            }
            const transientRecoveryDisplay = recoveredMessage.recoveryDisplayData
            const completedMessageData = recoveredMessage.data
            delete recoveredMessage.recoveryDisplayData
            const triggerResult = await runTrigger(recoveryCharacter, 'output', { chat: recoveredChat })
            if (triggerResult?.chat) {
                recoveredChat = normalizeChat(triggerResult.chat)
                const chatIndex = recoveryCharacter.chats.findIndex(item => item?.id === chat.id)
                if (chatIndex >= 0) recoveryCharacter.chats[chatIndex] = recoveredChat
            }
            if (job.workflowId) {
                await updateRevenantWorkflowStep(job.workflowId, 'trigger.output', 'completed')
            }
            const finalMessage = recoveredChat.message.find(item => item?.chatId === messageChatId)
                ?? recoveredMessage
            if (
                transientRecoveryDisplay !== undefined
                && finalMessage.data === transientRecoveryDisplay
            ) {
                finalMessage.data = completedMessageData
            }
            delete finalMessage.isRecovering
            delete finalMessage.recoveryDisplayData
            recoveredChat.isStreaming = false
            invalidateRecoveredMessage(recoveryCharacter, recoveredMessageIndex)
            try {
                const materialized = await materializeRecoveredGeneration(
                    job.jobId,
                    finalMessage,
                    recoveredChat,
                )
                if (materialized.chat) {
                    const canonicalChat = normalizeChat(materialized.chat)
                    Object.assign(recoveredChat, canonicalChat)
                    const chatIndex = recoveryCharacter.chats.findIndex(item => item?.id === chat.id)
                    if (chatIndex >= 0) recoveryCharacter.chats[chatIndex] = recoveredChat
                }
                recoveryRetryAt.delete(job.jobId)
                recovered++
                endStatus(job.jobId, 'done', { now: Date.now() })
                if (job.workflowId) {
                    // The existing recovery path intentionally restores the
                    // durable response/trigger/message boundary only. IGP and
                    // visual foreground effects are not silently replayed.
                    await updateRevenantWorkflowStep(job.workflowId, 'igp', 'skipped')
                    await updateRevenantWorkflowStep(job.workflowId, 'postprocess', 'skipped')
                    await finishRevenantWorkflow(job.workflowId, 'completed')
                }
            }
            catch (error) {
                recoveryRetryAt.set(job.jobId, Date.now() + 5000)
                const message = error instanceof Error ? error.message : String(error)
                console.error(`[GenerationJob] Failed to materialize recovered message: ${message}`, error)
                scheduleRecoveryFallback(character, chat, options)
                break
            }
        }
        if (!deferAuxiliaryRecovery && (jobs.length === 0 || recovered === jobs.length)) {
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

export function createRevenantChatTranslationRecovery(options: {
    getSource: () => string
    getCacheKey: (source: string) => Promise<string>
    translationCache: RevenantTranslationCache
}): RevenantChatTranslationRecovery {
    let cacheKey = $state<string | null>(null)
    let cacheKeySource = $state<string | null>(null)
    let cacheKeyReady = $state(false)
    let scope = $state<RevenantChatTranslationRecoveryScope | null>(null)
    let scopeReady = $state(false)
    const source = $derived(options.getSource())
    const currentCacheKey = $derived(
        cacheKeySource === source ? cacheKey : null
    )
    const currentCacheKeyReady = $derived(
        cacheKeySource === source && cacheKeyReady
    )

    const trackRecoverableTranslations = createSubscriber((update) =>
        subscribeRecoverableTranslations(update)
    )
    const snapshotReady = $derived.by(() => {
        trackRecoverableTranslations()
        return isRecoverableTranslationSnapshotLoaded()
    })
    const inspectionReady = $derived(
        DBState.db.translatorType !== 'llm'
        || (scopeReady && scope === null)
        || (snapshotReady && currentCacheKeyReady)
    )
    const pending = $derived.by(() => {
        trackRecoverableTranslations()
        if (!currentCacheKey || !scope) return false
        return hasRecoverableTranslation({ cacheKey: currentCacheKey, ...scope })
    })

    $effect(() => {
        const translatorType = DBState.db.translatorType
        const currentCharacter = DBState.db.characters[selIdState.selId]
        const currentChat = currentCharacter?.chats[currentCharacter.chatPage]
        const nextScope = currentCharacter?.chaId && currentChat?.id
            ? {
                characterId: currentCharacter.chaId,
                roomId: currentChat.id,
            }
            : null

        scope = nextScope
        scopeReady = true
        cacheKey = null
        cacheKeySource = source
        cacheKeyReady = false
        if (!nextScope || translatorType !== 'llm') {
            cacheKeyReady = true
            return
        }

        let active = true
        void options.getCacheKey(source).then(nextCacheKey => {
            if (!active) return
            cacheKey = nextCacheKey
            cacheKeyReady = true
        }).catch(error => {
            console.error('[Translation] Failed to calculate revenant translation cache key:', error)
            if (active) cacheKeyReady = true
        })
        void listRecoverableAuxiliaryGenerations().catch(error => {
            console.error('[Translation] Failed to inspect pending revenant translations:', error)
        })
        return () => {
            active = false
        }
    })

    function capture(): RevenantChatTranslationRecoverySnapshot {
        return {
            pending,
            cacheKey: currentCacheKey,
            scope: scope ? { ...scope } : null,
        }
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
        return await options.translationCache.get(translationCacheKey) !== null
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
            return pending
        },
        get inspectionReady() {
            return inspectionReady
        },
        capture,
        shouldDisplayTranslation,
        waitForResult,
        acknowledgeResolved,
    }
}
