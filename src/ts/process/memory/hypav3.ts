import { type HypaModel, DEFAULT_HYPA_MODEL } from "./hypamemory";
import { TaskConcurrencyLimiter } from "./taskConcurrencyLimiter";
import { createClientHypaEmbedder } from "./hypaSelectionEmbedder";
import {
    getRecentHypaQueryChats,
    selectHypaSummaries,
    wrapHypaMemoryPrompt,
} from "../../../../shared/hypaSelection.mjs";
import { type DisplayMode as ModalDisplayMode } from "src/lib/Others/HypaV3Modal/types";
import { parseChatML } from "src/ts/parser/chatML";
import {
    type Chat,
    type character,
    getCurrentCharacter,
    getDatabase,
} from "src/ts/storage/database.svelte";
import { type OpenAIChat } from "../index.svelte";
import { requestChatData } from "../request/request";
import {
    resolveChatModelBinding,
} from "../request/modelPresetBinding";
import { compileModelPreset } from "src/ts/preset/runtime/compilePreset";
import { hypaV3ProgressStore } from "src/ts/stores.svelte";
import { type ChatTokenizer } from "src/ts/tokenizer";
import { inlayTokenRegex } from "src/ts/util/inlayTokens";
import {
    consumeRecoverableAuxiliaryGeneration,
    resolveRecoverableAuxiliaryGenerations,
} from "../revenant/auxiliary";
import { saveChatToServer } from "src/ts/storage/chatStorage";
import {
    createRevenantOperation,
    isRevenantHypaV3SummaryOperation,
    type RecoverableAuxiliaryJob,
} from "../revenant";
import { createEntityId } from 'src/ts/id';
import type { PresetTagFields } from "src/ts/preset/tags";
import type { ModelPreset } from "src/ts/preset/types";

export interface HypaV3Preset extends PresetTagFields {
    id: string;
    name: string;
    settings: HypaV3Settings;
}

export interface HypaV3Settings {
    summarizationPrompt: string;
    reSummarizationPrompt: string;
    memoryTokensRatio: number;
    extraSummarizationRatio: number;
    maxChatsPerSummary: number;
    recentMemoryRatio: number;
    similarMemoryRatio: number;
    enableSimilarityCorrection: boolean;
    preserveOrphanedMemory: boolean;
    processRegexScript: boolean;
    doNotSummarizeUserMessage: boolean;
    summaryChunkSeparator: string;
    useExperimentalImpl: boolean;
    summarizationMaxConcurrent: number;
    embeddingMaxConcurrent: number;
    alwaysToggleOn: boolean;
    queryChatCount: number;
}

interface HypaV3Data {
    summaries: Summary[];
    categories?: { id: string; name: string }[];
    metrics?: {
        lastImportantSummaries: number[];
        lastRecentSummaries: number[];
        lastSimilarSummaries: number[];
        lastRandomSummaries: number[];
    };
    modalSettings?: {
        displayMode: ModalDisplayMode;
        displayRangeFrom: number;
        displayRangeTo: number;
        displayRecentCount: number;
        displayImportant: boolean;
        displaySelected: boolean;
    };
}

export interface SerializableHypaV3Data extends Omit<HypaV3Data, "summaries"> {
    summaries: SerializableSummary[];
}

interface Summary {
    text: string;
    chatMemos: Set<string | undefined>;
    isImportant: boolean;
    categoryId?: string;
    tags?: string[];
}

export interface SerializableSummary extends Omit<Summary, "chatMemos"> {
    chatMemos: (string | null)[];
}

export interface HypaV3Result {
    currentTokens: number;
    chats: OpenAIChat[];
    error?: string;
    memory?: SerializableHypaV3Data;
    deferredRemoteSelection?: boolean;
    serverExecution?: Record<string, unknown>;
}

export interface HypaV3ExecutionOptions {
    /** Placeholder used to pre-register main while server-side selection runs. */
    deferredMemoryPrompt?: string;
    planServerExecution?: boolean;
    signal?: AbortSignal;
}

const logPrefix = "[HypaV3]";
export const HYPA_CONCURRENT_REQUEST_MIN = 1;
export const HYPA_CONCURRENT_REQUEST_MAX = 12;
export const HYPA_CHAT_COUNT_MIN = 1;
export const HYPA_CHAT_COUNT_MAX = 12;

function canUseDurableHypaDispatch(room: Chat): boolean {
    try {
        const binding = resolveChatModelBinding(room, 'memory');
        return binding.kind === 'modelPreset'
            && compileModelPreset(binding.preset).backend === 'http';
    }
    catch {
        return false;
    }
}

function getRemoteEmbeddingConfig(): {
    model: HypaModel;
    apiKey: string;
    customUrl?: string;
    customModel?: string;
} {
    const db = getDatabase();
    const model = db.hypaModel || DEFAULT_HYPA_MODEL;
    if (model === 'custom') {
        return {
            model,
            apiKey: db.hypaCustomSettings?.key?.trim() || '',
            customUrl: db.hypaCustomSettings?.url?.trim() || '',
            customModel: db.hypaCustomSettings?.model?.trim() || undefined,
        };
    }
    if (model === 'voyage4large' || model === 'voyageContext3' || model === 'voyageContext4') {
        return { model, apiKey: db.voyageApiKey?.trim() || '' };
    }
    return { model, apiKey: db.supaMemoryKey?.trim() || '' };
}

function getHypaSelectionSettings(settings: HypaV3Settings) {
    return {
        recentMemoryRatio: settings.recentMemoryRatio,
        similarMemoryRatio: settings.similarMemoryRatio,
        queryChatCount: settings.queryChatCount,
        summaryChunkSeparator: settings.summaryChunkSeparator,
        queryMode: settings.useExperimentalImpl ? 'paragraph' as const : 'chat' as const,
    };
}

/**
 * Returns the memory preset the server can dispatch summaries through. Plugin
 * providers only exist in the browser, and Claude batch requests are not
 * server-dispatchable, so those keep the whole Hypa turn on the client.
 */
function getServerHypaSummaryProvider(options: HypaV3ExecutionOptions | undefined, room: Chat): ModelPreset | undefined {
    if (!options?.planServerExecution || !options.deferredMemoryPrompt) return undefined;
    const binding = resolveChatModelBinding(room, 'memory');
    if (binding.kind !== 'modelPreset' || binding.preset.claudeBatching) return undefined;
    return compileModelPreset(binding.preset).backend === 'plugin' ? undefined : binding.preset;
}

function planServerHypaSelection(input: {
    deferredMemoryPrompt: string; summaryProvider: ModelPreset; tokenizer: ChatTokenizer;
    settings: HypaV3Settings; chats: OpenAIChat[]; data: HypaV3Data;
    batches: OpenAIChat[][]; startIdx: number; currentTokens: number;
    maxContextTokens: number; availableMemoryTokens: number; reservedMemoryTokens: number;
}): HypaV3Result {
    const { tokenizer, settings, chats, data, batches } = input;
    const batchId = createEntityId();
    const summaryRequests = batches.map(batch => ({
        operationId: createEntityId(),
        chatMemos: batch.map(chat => chat.memo ?? null),
        prompt: buildHypaSummaryPrompt(batch, settings),
        purpose: 'memory',
    }));
    const recentChats = getRecentHypaQueryChats(chats, settings.queryChatCount);
    if (usesSimilarityCorrection(settings, recentChats)
        && (data.summaries.length > 0 || batches.length > 0)) {
        summaryRequests.push({
            operationId: createEntityId(), chatMemos: [], purpose: 'query',
            prompt: buildHypaSummaryPrompt(recentChats, settings),
        });
    }
    const memory = toSerializableHypaV3Data(data);
    return {
        currentTokens: input.currentTokens,
        chats: [
            { role: 'system', content: input.deferredMemoryPrompt, memo: 'supaMemory' },
            ...chats.slice(input.startIdx),
        ],
        memory,
        deferredRemoteSelection: true,
        serverExecution: {
            schemaVersion: 1, batchId,
            expectedOperationIds: summaryRequests.map(request => request.operationId),
            summaryRequests,
            summaryProvider: structuredClone(input.summaryProvider),
            summaryDispatch: {
                maxConcurrent: settings.summarizationMaxConcurrent,
            },
            embedding: getRemoteEmbeddingConfig(),
            tokenizer: tokenizer.getRevenantSpec(),
            settings: {
                ...getHypaSelectionSettings(settings),
                embeddingMaxConcurrent: settings.embeddingMaxConcurrent,
            },
            memory,
            chats: chats.map(chat => ({ role: chat.role, content: chat.content,
                ...(chat.name ? { name: chat.name } : {}), ...(chat.memo ? { memo: chat.memo } : {}) })),
            startIdx: input.startIdx, currentTokens: input.currentTokens,
            maxContextTokens: input.maxContextTokens, availableMemoryTokens: input.availableMemoryTokens,
            memoryTokens: input.reservedMemoryTokens, shouldReserveMemoryTokens: true,
            randomSeed: batchId,
        },
    };
}

async function executeDurableHypaBatch<T>(
    tasks: Array<(onRegistered: () => void) => Promise<T>>,
): Promise<{
    results: Array<{ success: boolean; data?: T; error?: Error }>;
}> {
    const running: Promise<{ success: boolean; data?: T; error?: Error }>[] = [];
    // Compile and register each provider envelope in order, but do not wait for
    // its provider response. Once registered, the durable server dispatcher
    // owns concurrency limiting and the next envelope can be submitted.
    for (const task of tasks) {
        let registrationReleased = false;
        let releaseRegistration!: () => void;
        const registration = new Promise<void>(resolve => {
            releaseRegistration = resolve;
        });
        const markRegistered = () => {
            if (registrationReleased) return;
            registrationReleased = true;
            releaseRegistration();
        };
        const result = task(markRegistered).then(
            data => ({ success: true, data }),
            error => ({
                success: false,
                error: error instanceof Error ? error : new Error(String(error)),
            }),
        ).finally(() => {
            if (registrationReleased) return;
            registrationReleased = true;
            releaseRegistration();
        });
        running.push(result);
        await registration;
    }
    const results = await Promise.all(running);
    return { results };
}

async function executeHypaSummaryBatches(
    batches: OpenAIChat[][],
    settings: HypaV3Settings,
    char: character,
    room: Chat,
): Promise<string[]> {
    if (batches.length === 0) return [];

    const concurrencyLimiter = new TaskConcurrencyLimiter({
        maxConcurrentTasks: settings.summarizationMaxConcurrent,
    });
    concurrencyLimiter.taskQueueChangeCallback = () => {
        hypaV3ProgressStore.set({
            open: true,
            miniMsg: `${concurrencyLimiter.queuedTaskCount}`,
            msg: `${logPrefix} Summarizing...`,
            subMsg: `${concurrencyLimiter.queuedTaskCount} queued`,
        });
    };

    const batchId = createEntityId();
    const useDurableDispatch = canUseDurableHypaDispatch(room);
    const operationIds = batches.map(() => createEntityId());
    const tasks = batches.map(
        (batch, index) => (onRegistered?: () => void) => summarize(batch, false, {
            revenantTarget: {
                characterId: char.chaId,
                roomId: room.id,
                batchId,
                operationId: operationIds[index],
                chatMemos: batch.map(chat => chat.memo ?? null),
                dispatchPolicy: useDurableDispatch ? {
                    maxConcurrent: settings.summarizationMaxConcurrent,
                } : undefined,
                onJobCreated: onRegistered,
            },
        })
    );

    if (import.meta.env.DEV) {
        console.log(logPrefix, `Starting ${batches.length} summarization.`);
    }
    const startedAt = import.meta.env.DEV ? performance.now() : 0;
    try {
        const batchResult = useDurableDispatch
            ? await executeDurableHypaBatch<string>(tasks)
            : await concurrencyLimiter.executeBatch<string>(
                tasks.map(task => () => task())
            );
        if (import.meta.env.DEV) {
            console.debug(
                `${logPrefix} summarization completed in ${performance.now() - startedAt}ms`
            );
        }
        return batchResult.results.map(result => {
            if (!result.success) throw result.error;
            if (!result.data) throw new Error("Empty summary returned");
            return result.data;
        });
    } finally {
        hypaV3ProgressStore.set({
            open: false,
            miniMsg: "",
            msg: "",
            subMsg: "",
        });
    }
}

function sameMemoSet(left: (string | null)[], right: (string | null)[]): boolean {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every(memo => rightSet.has(memo));
}

const hypaRecoveryCheckedAt = new Map<string, number>();
const hypaRecoveryInFlight = new Map<string, Promise<number>>();

export interface HypaV3RecoveryOptions {
    workflowId?: string;
    rejectFailed?: boolean;
    force?: boolean;
    onJobUpdate?: (job: RecoverableAuxiliaryJob) => void;
}

export async function recoverHypaV3SummaryJobs(
    char: character,
    room: Chat,
    options: HypaV3RecoveryOptions = {},
): Promise<number> {
    if (!char?.chaId || !room?.id) return 0;
    const recoveryKey = `${char.chaId}/${room.id}/${options.workflowId ?? ''}/${options.rejectFailed ? 'strict' : 'normal'}`;
    const existing = hypaRecoveryInFlight.get(recoveryKey);
    if (existing) return existing;
    if (!options.force && Date.now() - (hypaRecoveryCheckedAt.get(recoveryKey) ?? 0) < 2000) return 0;
    hypaRecoveryCheckedAt.set(recoveryKey, Date.now());

    const recovery = (async () => {
        const jobs = await resolveRecoverableAuxiliaryGenerations({
            jobType: 'memory',
            isContext: isRevenantHypaV3SummaryOperation,
            matchesContext: context =>
                context.purpose !== 'query'
                && context.characterId === char.chaId && context.roomId === room.id,
            matchesJob: job => !options.workflowId || job.workflowId === options.workflowId,
            force: options.force,
            onJobUpdate: options.onJobUpdate,
        });
        const consumedJobIds: string[] = [];
        let shouldPersist = false;
        let recovered = 0;
        let failedJob: typeof jobs[number] | undefined;
        for (const job of jobs) {
            const context = job.operationContext;

            const projectedContent = job.projection?.content ?? '';
            if (job.status === 'generated' && projectedContent.trim()) {
                const serialData: SerializableHypaV3Data = room.hypaV3Data ?? { summaries: [] };
                const alreadyApplied = serialData.summaries.some(summary =>
                    sameMemoSet(summary.chatMemos, context.chatMemos));
                if (!alreadyApplied) {
                    const text = projectedContent
                        .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '')
                        .trim();
                    if (text) {
                        serialData.summaries.push({
                            text,
                            chatMemos: [...context.chatMemos],
                            isImportant: false,
                            categoryId: undefined,
                        });
                        room.hypaV3Data = serialData;
                        recovered += 1;
                    }
                }
                // Persist even when already applied: a previous attempt may
                // have saved the chat but crashed before consuming the job.
                shouldPersist = true;
            }
            else if (options.rejectFailed) {
                failedJob ??= job;
            }
            consumedJobIds.push(job.jobId);
        }
        if (shouldPersist) {
            const chatIndex = char.chats.findIndex(chat => chat?.id === room.id);
            if (chatIndex < 0) throw new Error(`HypaV3 recovery target chat not found: ${room.id}`);
            await saveChatToServer(char.chaId, chatIndex, room.id, room);
        }
        for (const jobId of consumedJobIds) {
            await consumeRecoverableAuxiliaryGeneration(jobId);
        }
        if (failedJob) {
            throw new Error(
                `HypaV3 provider job ${failedJob.jobId} ended as ${failedJob.status}; automatic retry is disabled.`,
            );
        }
        return recovered;
    })().finally(() => {
        hypaRecoveryInFlight.delete(recoveryKey);
    });
    hypaRecoveryInFlight.set(recoveryKey, recovery);
    return recovery;
}

export async function hypaMemoryV3(
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character,
    tokenizer: ChatTokenizer,
    options?: HypaV3ExecutionOptions,
): Promise<HypaV3Result> {
    const settings = getCurrentHypaV3Preset().settings;
    await recoverHypaV3SummaryJobs(char, room);

    try {
        return await hypaMemoryV3Main(
            chats,
            currentTokens,
            maxContextTokens,
            room,
            char,
            tokenizer,
            settings,
            options,
        );
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        if (error instanceof Error) {
            error.message = `${logPrefix} ${error.message}`;
            throw error;
        }

        let errorMessage: string;

        try {
            errorMessage = JSON.stringify(error);
        } catch {
            errorMessage = String(error);
        }

        throw new Error(`${logPrefix} ${errorMessage}`);
    }
}

function shouldSummarizeChat(chat: OpenAIChat, settings: HypaV3Settings): boolean {
    if (
        chat.name === "example_user" ||
        chat.name === "example_assistant" ||
        chat.memo === "NewChatExample" ||
        chat.memo === "NewChat"
    ) {
        return false;
    }
    if (chat.content.trim().length === 0) {
        return false;
    }
    return !(settings.doNotSummarizeUserMessage && chat.role === "user");
}

function usesSimilarityCorrection(settings: HypaV3Settings, recentChats: OpenAIChat[]): boolean {
    return !settings.useExperimentalImpl
        && settings.enableSimilarityCorrection
        && settings.similarMemoryRatio > 0
        && recentChats.length > 1;
}

async function hypaMemoryV3Main(
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character,
    tokenizer: ChatTokenizer,
    settings: HypaV3Settings,
    options?: HypaV3ExecutionOptions,
): Promise<HypaV3Result> {
    // The experimental implementation reserves memory only once it is needed,
    // fills each batch with summarizable chats, omits the empty memory prompt
    // and splits similarity queries by paragraph.
    const experimental = settings.useExperimentalImpl;

    if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
        return {
            currentTokens,
            chats,
            error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
        };
    }

    const data: HypaV3Data = room.hypaV3Data
        ? toHypaV3Data(room.hypaV3Data)
        : {
            summaries: [],
        };

    if (!settings.preserveOrphanedMemory) {
        cleanOrphanedSummary(chats, data);
    }

    let startIdx = 0;

    if (data.summaries.length > 0) {
        const lastSummary = data.summaries.at(-1);
        const lastChatIndex = chats.findIndex(
            (chat) => chat.memo === [...lastSummary.chatMemos].at(-1)
        );

        if (lastChatIndex !== -1) {
            startIdx = lastChatIndex + 1;

            // Exclude tokens from summarized chats
            const summarizedChats = chats.slice(0, lastChatIndex + 1);
            for (const chat of summarizedChats) {
                currentTokens -= await tokenizer.tokenizeChat(chat);
            }
        }
    }

    const emptyMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: wrapHypaMemoryPrompt(""),
    });
    const memoryTokens = Math.floor(
        maxContextTokens * settings.memoryTokensRatio
    );
    let reservedMemoryTokens: number;
    let availableMemoryTokens: number;

    if (experimental) {
        const shouldReserveMemoryTokens =
            data.summaries.length > 0 || currentTokens > maxContextTokens;
        reservedMemoryTokens = shouldReserveMemoryTokens ? memoryTokens : 0;
        availableMemoryTokens = shouldReserveMemoryTokens
            ? memoryTokens - emptyMemoryTokens
            : 0;
    } else {
        const shouldReserveEmptyMemoryTokens =
            data.summaries.length === 0 &&
            currentTokens + emptyMemoryTokens <= maxContextTokens;
        reservedMemoryTokens = shouldReserveEmptyMemoryTokens
            ? emptyMemoryTokens
            : memoryTokens;
        availableMemoryTokens = shouldReserveEmptyMemoryTokens
            ? 0
            : memoryTokens - emptyMemoryTokens;
    }
    currentTokens += reservedMemoryTokens;

    if (import.meta.env.DEV) {
        console.log(
            logPrefix,
            "Starting index:",
            startIdx,
            "\nReserved memory tokens:",
            reservedMemoryTokens
        );
    }

    const summarizationMode = currentTokens > maxContextTokens;
    const targetTokens =
        maxContextTokens * (1 - settings.extraSummarizationRatio);
    const summarizationBatches: OpenAIChat[][] = [];

    while (summarizationMode && currentTokens > targetTokens) {
        if (chats.length - startIdx <= settings.queryChatCount) {
            if (currentTokens <= maxContextTokens) {
                break;
            }
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
                memory: toSerializableHypaV3Data(data),
            };
        }

        const batchLimit = chats.length - settings.queryChatCount;
        const windowEnd = Math.min(startIdx + settings.maxChatsPerSummary, batchLimit);
        const toSummarize: OpenAIChat[] = [];
        let toSummarizeTokens = 0;
        let index = startIdx;

        while (
            experimental
                ? toSummarize.length < settings.maxChatsPerSummary && index < batchLimit
                : index < windowEnd
        ) {
            const chat = chats[index++];
            toSummarizeTokens += await tokenizer.tokenizeChat(chat);
            if (shouldSummarizeChat(chat, settings)) {
                toSummarize.push(chat);
            }
        }

        // Stop summarization if further reduction would go below target tokens (unless we're over max tokens)
        if (
            currentTokens <= maxContextTokens &&
            currentTokens - toSummarizeTokens < targetTokens
        ) {
            break;
        }

        if (toSummarize.length > 0) {
            if (import.meta.env.DEV) {
                console.log(logPrefix, "Collecting summarization batch:", "\nTarget:", toSummarize);
            }
            summarizationBatches.push(toSummarize);
        }

        currentTokens -= toSummarizeTokens;
        startIdx = index;
    }

    const summaryProvider = getServerHypaSummaryProvider(options, room);
    if (summaryProvider) {
        return planServerHypaSelection({
            deferredMemoryPrompt: options.deferredMemoryPrompt, summaryProvider,
            tokenizer, settings, chats, data, batches: summarizationBatches,
            startIdx, currentTokens, maxContextTokens, availableMemoryTokens,
            reservedMemoryTokens,
        });
    }

    if (summarizationBatches.length > 0) {
        try {
            const summaryTexts = await executeHypaSummaryBatches(
                summarizationBatches, settings, char, room
            );
            for (let i = 0; i < summaryTexts.length; i++) {
                data.summaries.push({
                    text: summaryTexts[i],
                    chatMemos: new Set(summarizationBatches[i].map(chat => chat.memo)),
                    isImportant: false,
                    categoryId: undefined,
                });
            }
            room.hypaV3Data = toSerializableHypaV3Data(data);
            await recoverHypaV3SummaryJobs(char, room);
        } catch (error) {
            if (import.meta.env.DEV) {
                console.log(logPrefix, "Summarization failed:", `\n${error}`);
            }
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Summarization failed: ${error}`,
                memory: toSerializableHypaV3Data(data),
            };
        }
    }

    if (data.summaries.length === 0) {
        return {
            currentTokens,
            chats: experimental
                ? chats.slice(startIdx)
                : [
                    {
                        role: "system",
                        content: wrapHypaMemoryPrompt(""),
                        memo: "supaMemory",
                    },
                    ...chats.slice(startIdx),
                ],
            memory: toSerializableHypaV3Data(data),
        };
    }

    let querySummary: string | undefined;
    const recentChats = getRecentHypaQueryChats(chats, settings.queryChatCount);

    if (usesSimilarityCorrection(settings, recentChats)) {
        try {
            querySummary = await summarize(recentChats);
        } catch (error) {
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Summarization failed: ${error}`,
                memory: toSerializableHypaV3Data(data),
            };
        }
    }

    const embeddingLimiter = new TaskConcurrencyLimiter({
        maxConcurrentTasks: settings.embeddingMaxConcurrent,
    });
    embeddingLimiter.taskQueueChangeCallback = (queuedCount) => {
        hypaV3ProgressStore.set({
            open: true,
            miniMsg: `${queuedCount}`,
            msg: `${logPrefix} Similarity searching...`,
            subMsg: `${queuedCount} queued`,
        });
    };

    let selection: Awaited<ReturnType<typeof selectHypaSummaries>>;
    try {
        selection = await selectHypaSummaries(
            {
                settings: getHypaSelectionSettings(settings),
                chats,
                querySummary,
                availableMemoryTokens,
                currentTokens,
                memoryTokens: reservedMemoryTokens,
                shouldReserveMemoryTokens: true,
                maxContextTokens,
                randomSeed: createEntityId(),
            },
            data.summaries,
            {
                tokenize: (content) => tokenizer.tokenizeChat({ role: "system", content }),
                embedder: createClientHypaEmbedder(embeddingLimiter),
            }
        );
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return {
            currentTokens,
            chats,
            error: `${logPrefix} Memory selection failed: ${error}`,
            memory: toSerializableHypaV3Data(data),
        };
    } finally {
        hypaV3ProgressStore.set({
            open: false,
            miniMsg: "",
            msg: "",
            subMsg: "",
        });
    }

    data.metrics = selection.metrics;

    return {
        currentTokens: selection.currentTokens,
        chats: [
            {
                role: "system",
                content: selection.memoryText,
                memo: "supaMemory",
            },
            ...chats.slice(startIdx),
        ],
        memory: toSerializableHypaV3Data(data),
    };
}

function toHypaV3Data(serialData: SerializableHypaV3Data): HypaV3Data {
    return {
        ...serialData,
        summaries: serialData.summaries.map((summary) => ({
            ...summary,
            // Convert null back to undefined (JSON serialization converts undefined to null)
            chatMemos: new Set(
                summary.chatMemos.map((memo) => (memo === null ? undefined : memo))
            ),
        })),
    };
}

function toSerializableHypaV3Data(data: HypaV3Data): SerializableHypaV3Data {
    return {
        ...data,
        summaries: data.summaries.map((summary) => ({
            ...summary,
            chatMemos: [...summary.chatMemos].map(memo => memo ?? null),
        })),
    };
}

function cleanOrphanedSummary(chats: OpenAIChat[], data: HypaV3Data): void {
    const currentChatMemos = new Set(chats.map((chat) => chat.memo));
    const originalLength = data.summaries.length;

    data.summaries = data.summaries.filter((summary) => {
        return isSubset(summary.chatMemos, currentChatMemos);
    });

    if (import.meta.env.DEV) {
        const removedCount = originalLength - data.summaries.length;
        if (removedCount > 0) {
            console.log(logPrefix, `Cleaned ${removedCount} orphaned summaries.`);
        }
    }
}

function isSubset(subset: Set<string | undefined>, superset: Set<string | undefined>): boolean {
    for (const elem of subset) {
        if (!superset.has(elem)) {
            return false;
        }
    }

    return true;
}

function sanitizeSummaryContent(content: string): string {
    return content.replace(inlayTokenRegex, "[Image]");
}

export interface HypaV3SummarizeOptions {
    revenantTarget?: {
        characterId: string;
        roomId: string;
        batchId: string;
        operationId?: string;
        chatMemos: (string | null)[];
        dispatchPolicy?: { maxConcurrent: number };
        onJobCreated?: () => void;
    };
    signal?: AbortSignal;
    onRequestStatusActivate?: () => void;
}

function buildHypaSummaryPrompt(oaiMessages: OpenAIChat[], settings: HypaV3Settings, isResummarize = false): OpenAIChat[] {
    const strMessages = oaiMessages
        .map((chat) => `${chat.role}: ${sanitizeSummaryContent(chat.content)}`)
        .join("\n");

    const summarizationPrompt = isResummarize
        ? (settings.reSummarizationPrompt.trim() === "" ? "Re-summarize this summaries." : settings.reSummarizationPrompt)
        : settings.summarizationPrompt.trim() === ""
            ? "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]"
            : settings.summarizationPrompt;

    return parseChatML(
        summarizationPrompt.replaceAll("{{slot}}", strMessages)
    ) ?? [
            {
                role: "user",
                content: strMessages,
            },
            {
                role: "system",
                content: summarizationPrompt,
            },
        ];

}

export async function summarize(
    oaiMessages: OpenAIChat[],
    isResummarize: boolean = false,
    options: HypaV3SummarizeOptions = {},
): Promise<string> {
    const settings = getCurrentHypaV3Preset().settings;
    const { revenantTarget, signal, onRequestStatusActivate } = options;

    const formated = buildHypaSummaryPrompt(oaiMessages, settings, isResummarize);

    const response = await requestChatData(
        {
            formated,
            bias: {},
            currentChar: getCurrentCharacter(),
            useStreaming: false,
            noMultiGen: true,
            revenantOperationContext: revenantTarget ? createRevenantOperation({
                kind: 'hypav3-summary',
                operationId: revenantTarget.operationId,
                characterId: revenantTarget.characterId,
                roomId: revenantTarget.roomId,
                batchId: revenantTarget.batchId,
                chatMemos: revenantTarget.chatMemos,
            }) : undefined,
            revenantDispatchPolicy: revenantTarget?.dispatchPolicy,
            onRevenantJobCreated: revenantTarget?.onJobCreated,
            onRequestStatusActivate,
        },
        "memory",
        signal
    );

    if (response.type === "streaming" || response.type === "multiline") {
        throw new Error("Unexpected response type");
    }

    if (response.type === "fail") {
        throw new Error(response.result);
    }

    if (!response.result || response.result.trim().length === 0) {
        throw new Error("Empty summary returned");
    }

    const thoughtsRegex = /<Thoughts>[\s\S]*?<\/Thoughts>/g;
    const result = response.result.replace(thoughtsRegex, "").trim();

    if (result.length === 0) {
        throw new Error("Empty summary after removing thoughts content");
    }

    return result;
}

export function getCurrentHypaV3Preset(): HypaV3Preset {
    const db = getDatabase();
    const preset = db.hypaV3Presets?.[db.hypaV3PresetId];

    if (!preset) {
        throw new Error("Preset not found. Please select a valid preset.");
    }

    return preset;
}

export function createHypaV3Preset(
    name = "New Preset",
    existingSettings = {}
): HypaV3Preset {
    const settings: HypaV3Settings = {
        summarizationPrompt: "",
        reSummarizationPrompt: "",
        memoryTokensRatio: 0.2,
        extraSummarizationRatio: 0,
        maxChatsPerSummary: 6,
        recentMemoryRatio: 0.4,
        similarMemoryRatio: 0.4,
        enableSimilarityCorrection: false,
        preserveOrphanedMemory: false,
        processRegexScript: false,
        doNotSummarizeUserMessage: false,
        summaryChunkSeparator: "\\n\\n",
        useExperimentalImpl: false,
        summarizationMaxConcurrent: 1,
        embeddingMaxConcurrent: 1,
        alwaysToggleOn: false,
        queryChatCount: 3,
    };

    if (
        existingSettings &&
        typeof existingSettings === "object" &&
        !Array.isArray(existingSettings)
    ) {
        for (const [key, value] of Object.entries(existingSettings)) {
            if (key in settings && typeof value === typeof settings[key]) {
                settings[key] = value;
            }
        }
    }

    return {
        id: createEntityId(),
        name,
        settings,
    };
}
