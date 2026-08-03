import { type HypaModel, type memoryVector, HypaProcesser, isBrowserLocalHypaModel, similarity, contextHash, getPersistedHypaVector, setPersistedHypaVector } from "./hypamemory";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { TaskRateLimiter } from "./taskRateLimiter";
import {
    type EmbeddingText,
    type EmbeddingResult,
    HypaProcessorV2,
} from "./hypamemoryv2";
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
    resolveChatMaxResponseTokens,
    resolveChatModelBinding,
} from "../request/modelPresetBinding";
import { compileModelPreset } from "src/ts/preset/runtime/compilePreset";
import { chatCompletion, unloadEngine } from "../webllm";
import { hypaV3ProgressStore } from "src/ts/stores.svelte";
import { type ChatTokenizer } from "src/ts/tokenizer";
import { inlayTokenRegex } from "src/ts/util/inlayTokens";
import {
    consumeRecoverableAuxiliaryGeneration,
    resolveRecoverableAuxiliaryGenerations,
} from "../revenantGeneration/auxiliary";
import { saveChatToServer } from "src/ts/storage/chatStorage";
import {
    createRevenantOperation,
    isRevenantHypaV3SummaryOperation,
} from "../revenantGeneration/types";
import { v4 as uuidv4 } from "uuid";
import {
    getRevenantHypaExecution,
    prepareRevenantHypaExecution,
    waitForRevenantHypaExecution,
} from "../revenantGeneration/workflow";

export interface HypaV3Preset {
    name: string;
    /** Optional preset-picker folder membership. */
    folderId?: string;
    settings: HypaV3Settings;
}

export interface HypaV3Settings {
    summarizationModel: string;
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
    // Experimental
    useExperimentalImpl: boolean;
    summarizationRequestsPerMinute: number;
    summarizationMaxConcurrent: number;
    embeddingRequestsPerMinute: number;
    embeddingMaxConcurrent: number;
    alwaysToggleOn: boolean;
    queryChatCount: number;
}

interface HypaV3Data {
    summaries: Summary[];
    categories?: { id: string; name: string }[];
    lastSelectedSummaries?: number[]; // legacy
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
    chatMemos: Set<string>;
    isImportant: boolean;
    categoryId?: string;
    tags?: string[];
}

export interface SerializableSummary extends Omit<Summary, "chatMemos"> {
    chatMemos: string[];
}

interface SummaryChunk {
    text: string;
    summary: Summary;
}

export interface HypaV3Result {
    currentTokens: number;
    chats: OpenAIChat[];
    error?: string;
    memory?: SerializableHypaV3Data;
}

export interface HypaV3ExecutionOptions {
    /** Called before a Hypa run that may require browser-only embedding work. */
    onClientEmbeddingRequired?: (model: HypaModel) => Promise<void>;
    workflowId?: string;
}

interface RevenantHypaSelectionResult {
    currentTokens: number;
    memory: SerializableHypaV3Data;
    chatSequence: Array<{
        inputIndex?: number;
        inputMemo?: string;
        chat?: OpenAIChat;
    }>;
}

const logPrefix = "[HypaV3]";
const memoryPromptTag = "Past Events Summary";
const summarySeparator = "\n\n";

async function markClientEmbeddingBoundary(
    options: HypaV3ExecutionOptions | undefined,
    model: HypaModel,
): Promise<void> {
    if (!options?.onClientEmbeddingRequired || !isBrowserLocalHypaModel(model)) return;
    await options.onClientEmbeddingRequired(model);
}

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

function getRemoteEmbeddingConfig(model: HypaModel): {
    model: HypaModel;
    apiKey: string;
    customUrl?: string;
    customModel?: string;
} | undefined {
    if (isBrowserLocalHypaModel(model)) return undefined;
    const db = getDatabase();
    if (model === 'custom') {
        const customUrl = db.hypaCustomSettings?.url?.trim();
        if (!customUrl) return undefined;
        return {
            model,
            apiKey: db.hypaCustomSettings?.key?.trim() || '',
            customUrl,
            customModel: db.hypaCustomSettings?.model?.trim() || undefined,
        };
    }
    if (['ada', 'openai3small', 'openai3large'].includes(model)) {
        return { model, apiKey: db.supaMemoryKey?.trim() || '' };
    }
    if (['voyage4large', 'voyageContext3', 'voyageContext4'].includes(model)) {
        return { model, apiKey: db.voyageApiKey?.trim() || '' };
    }
    return undefined;
}

async function executeDurableHypaBatch<T>(
    tasks: Array<(onRegistered: () => void) => Promise<T>>,
    onAllRegistered?: () => Promise<void>,
): Promise<{
    results: Array<{ success: boolean; data?: T; error?: Error }>;
    successCount: number;
    failureCount: number;
    allSucceeded: boolean;
}> {
    const running: Promise<{ success: boolean; data?: T; error?: Error }>[] = [];
    // Compile and register each provider envelope in order, but do not wait for
    // its provider response. Once registered, the durable server dispatcher
    // owns concurrency/rate limiting and the next envelope can be submitted.
    for (const task of tasks) {
        let registered = false;
        let releaseRegistration!: () => void;
        const registration = new Promise<void>(resolve => {
            releaseRegistration = resolve;
        });
        const markRegistered = () => {
            if (registered) return;
            registered = true;
            releaseRegistration();
        };
        const result = task(markRegistered).then(
            data => ({ success: true, data }),
            error => ({
                success: false,
                error: error instanceof Error ? error : new Error(String(error)),
            }),
        ).finally(markRegistered);
        running.push(result);
        await registration;
    }
    await onAllRegistered?.();
    const results = await Promise.all(running);
    const successCount = results.filter(result => result.success).length;
    const failureCount = results.length - successCount;
    return { results, successCount, failureCount, allSucceeded: failureCount === 0 };
}

function sameMemoSet(left: string[], right: string[]): boolean {
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
                context.characterId === char.chaId && context.roomId === room.id,
            matchesJob: job => !options.workflowId || job.workflowId === options.workflowId,
            force: options.force,
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

function splitBySeparator(text: string, separator: string): string[] {
    try {
        const regexMatch = separator.match(/^\/(.+)\/([gimuy]*)$/);
        if (regexMatch) {
            const [, pattern, flags] = regexMatch;
            return text.split(new RegExp(pattern, flags));
        }
        return text.split(new RegExp(separator));
    } catch {
        return text.split("\n\n");
    }
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
    if (options?.workflowId) {
        const existingExecution = await getRevenantHypaExecution<RevenantHypaSelectionResult>(
            options.workflowId,
        );
        if (existingExecution && existingExecution.error !== 'server_restart') {
            const remote = await waitForRevenantHypaExecution<RevenantHypaSelectionResult>(
                options.workflowId,
            );
            room.hypaV3Data = remote.memory;
            return {
                currentTokens: remote.currentTokens,
                chats: remote.chatSequence.map(item => item.chat ?? chats[item.inputIndex]),
                memory: remote.memory,
            };
        }
    }
    const settings = getCurrentHypaV3Preset().settings;
    if (settings.similarMemoryRatio > 0) {
        const model = getDatabase().hypaModel || "MiniLM";
        // Persist this boundary before waiting for detached summary jobs. If
        // the page disappears during that wait, the server may finish those
        // jobs but knows that embedding needs a browser before proceeding.
        await markClientEmbeddingBoundary(options, model);
    }
    await recoverHypaV3SummaryJobs(char, room);

    try {
        if (settings.useExperimentalImpl) {
            console.log(logPrefix, "Using experimental implementation.");

            return await hypaMemoryV3MainExp(
                chats,
                currentTokens,
                maxContextTokens,
                room,
                char,
                tokenizer,
                options,
            );
        }

        return await hypaMemoryV3Main(
            chats,
            currentTokens,
            maxContextTokens,
            room,
            char,
            tokenizer,
        );
    } catch (error) {
        if (error instanceof Error) {
            // Standard Error instance
            error.message = `${logPrefix} ${error.message}`;
            throw error;
        }

        // Fallback for non-Error object
        let errorMessage: string;

        try {
            errorMessage = JSON.stringify(error);
        } catch {
            errorMessage = String(error);
        }

        throw new Error(`${logPrefix} ${errorMessage}`);
    } finally {
        if (settings.summarizationModel !== "subModel") {
            try {
                await unloadEngine();
            } catch { }
        }
    }
}

async function hypaMemoryV3MainExp(
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character,
    tokenizer: ChatTokenizer,
    options?: HypaV3ExecutionOptions,
): Promise<HypaV3Result> {
    const db = getDatabase();
    const settings = getCurrentHypaV3Preset().settings;

    // Validate settings
    if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
        return {
            currentTokens,
            chats,
            error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
        };
    }

    // Initial token correction — must match the output-token reservation the
    // caller added (preset max-output for ModelPreset chats, else db.maxResponse).
    currentTokens -= resolveChatMaxResponseTokens(room);

    // Load existing hypa data if available
    const data: HypaV3Data = room.hypaV3Data
        ? toHypaV3Data(room.hypaV3Data)
        : {
            summaries: [],
        };

    // Clean orphaned summaries
    if (!settings.preserveOrphanedMemory) {
        cleanOrphanedSummary(chats, data);
    }

    // Determine starting index
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

    console.log(logPrefix, "Starting index:", startIdx);

    // Reserve memory tokens
    const emptyMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: wrapWithXml(memoryPromptTag, ""),
    });
    const memoryTokens = Math.floor(
        maxContextTokens * settings.memoryTokensRatio
    );
    const shouldReserveMemoryTokens =
        data.summaries.length > 0 || currentTokens > maxContextTokens;
    let availableMemoryTokens = shouldReserveMemoryTokens
        ? memoryTokens - emptyMemoryTokens
        : 0;

    if (shouldReserveMemoryTokens) {
        currentTokens += memoryTokens;
        console.log(logPrefix, "Reserved memory tokens:", memoryTokens);
    }

    // If summarization is needed
    const summarizationMode = currentTokens > maxContextTokens;
    const targetTokens =
        maxContextTokens * (1 - settings.extraSummarizationRatio);
    const toSummarizeArray: OpenAIChat[][] = [];

    while (summarizationMode) {
        if (currentTokens <= targetTokens) {
            break;
        }

        if (chats.length - startIdx <= settings.queryChatCount) {
            if (currentTokens <= maxContextTokens) {
                break;
            } else {
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
                    memory: toSerializableHypaV3Data(data),
                };
            }
        }

        const toSummarize: OpenAIChat[] = [];
        let toSummarizeTokens = 0;
        let currentIndex = startIdx;

        console.log(
            logPrefix,
            "Evaluating summarization batch:",
            "\nCurrent Tokens:",
            currentTokens,
            "\nMax Context Tokens:",
            maxContextTokens,
            "\nStart Index:",
            startIdx,
            "\nMax Chats Per Summary:",
            settings.maxChatsPerSummary
        );

        while (
            toSummarize.length < settings.maxChatsPerSummary &&
            currentIndex < chats.length - settings.queryChatCount
        ) {
            const chat = chats[currentIndex];
            const chatTokens = await tokenizer.tokenizeChat(chat);

            console.log(
                logPrefix,
                "Evaluating chat:",
                "\nIndex:",
                currentIndex,
                "\nRole:",
                chat.role,
                "\nContent:",
                "\n" + chat.content,
                "\nTokens:",
                chatTokens
            );

            toSummarizeTokens += chatTokens;

            let shouldSummarize = true;

            if (
                chat.name === "example_user" ||
                chat.name === "example_assistant" ||
                chat.memo === "NewChatExample"
            ) {
                console.log(
                    logPrefix,
                    `Skipping example chat at index ${currentIndex}`
                );
                shouldSummarize = false;
            }

            if (chat.memo === "NewChat") {
                console.log(logPrefix, `Skipping new chat at index ${currentIndex}`);
                shouldSummarize = false;
            }

            if (chat.content.trim().length === 0) {
                console.log(logPrefix, `Skipping empty chat at index ${currentIndex}`);
                shouldSummarize = false;
            }

            if (settings.doNotSummarizeUserMessage && chat.role === "user") {
                console.log(logPrefix, `Skipping user role at index ${currentIndex}`);
                shouldSummarize = false;
            }

            if (shouldSummarize) {
                toSummarize.push(chat);
            }

            currentIndex++;
        }

        // Stop summarization if further reduction would go below target tokens (unless we're over max tokens)
        if (
            currentTokens <= maxContextTokens &&
            currentTokens - toSummarizeTokens < targetTokens
        ) {
            console.log(
                logPrefix,
                "Stopping summarization:",
                `\ncurrentTokens(${currentTokens}) - toSummarizeTokens(${toSummarizeTokens}) < targetTokens(${targetTokens})`
            );
            break;
        }

        // Collect summarization batch
        if (toSummarize.length > 0) {
            console.log(
                logPrefix,
                "Collecting summarization batch:",
                "\nTarget:",
                toSummarize
            );

            toSummarizeArray.push([...toSummarize]);
        }

        currentTokens -= toSummarizeTokens;
        startIdx = currentIndex;
    }

    let remoteExecutionPrepared = false;
    const prepareRemoteSelection = async (
        batchId: string,
        operationIds: string[],
    ): Promise<void> => {
        const embeddingModel = db.hypaModel || 'MiniLM';
        const remoteEmbedding = getRemoteEmbeddingConfig(embeddingModel);
        const tokenizerSpec = tokenizer.getRevenantSpec();
        const serverTokenizers = new Set([
            'tik', 'mistral', 'novelai', 'claude', 'llama', 'llama3',
            'novellist', 'gemma', 'cohere', 'deepseek',
        ]);
        if (
            !options?.workflowId
            || !remoteEmbedding
            || !tokenizerSpec.tokenizer
            || !serverTokenizers.has(tokenizerSpec.tokenizer)
        ) return;
        try {
            await prepareRevenantHypaExecution(options.workflowId, {
                schemaVersion: 1,
                batchId,
                expectedOperationIds: operationIds,
                embedding: remoteEmbedding,
                tokenizer: tokenizerSpec,
                settings: {
                    recentMemoryRatio: settings.recentMemoryRatio,
                    similarMemoryRatio: settings.similarMemoryRatio,
                    queryChatCount: settings.queryChatCount,
                    summaryChunkSeparator: settings.summaryChunkSeparator,
                },
                memory: toSerializableHypaV3Data(data),
                chats: chats.map(chat => ({
                    role: chat.role,
                    content: chat.content,
                    ...(chat.name ? { name: chat.name } : {}),
                    ...(chat.memo ? { memo: chat.memo } : {}),
                })),
                startIdx,
                currentTokens,
                maxContextTokens,
                availableMemoryTokens,
                memoryTokens,
                shouldReserveMemoryTokens,
                randomSeed: batchId,
            });
            remoteExecutionPrepared = true;
        }
        catch (error) {
            console.warn(`${logPrefix} Server selection unavailable; using client:`, error);
        }
    };
    const consumeRemoteSelection = async (): Promise<HypaV3Result> => {
        const remote = await waitForRevenantHypaExecution<RevenantHypaSelectionResult>(
            options.workflowId,
        );
        room.hypaV3Data = remote.memory;
        return {
            currentTokens: remote.currentTokens,
            chats: remote.chatSequence.map(item => item.chat ?? chats[item.inputIndex]),
            memory: remote.memory,
        };
    };

    // Process all collected summarization tasks
    if (toSummarizeArray.length > 0) {
        // Initialize rate limiter
        // Local model must be processed sequentially
        const rateLimiter = new TaskRateLimiter({
            tasksPerMinute:
                settings.summarizationModel === "subModel"
                    ? settings.summarizationRequestsPerMinute
                    : 1000,
            maxConcurrentTasks:
                settings.summarizationModel === "subModel"
                    ? settings.summarizationMaxConcurrent
                    : 1,
        });

        rateLimiter.taskQueueChangeCallback = (queuedCount) => {
            hypaV3ProgressStore.set({
                open: true,
                miniMsg: `${rateLimiter.queuedTaskCount}`,
                msg: `${logPrefix} Summarizing...`,
                subMsg: `${rateLimiter.queuedTaskCount} queued`,
            });
        };

        const batchId = uuidv4();
        const useDurableDispatch = settings.summarizationModel === "subModel"
            && canUseDurableHypaDispatch(room);
        const operationIds = toSummarizeArray.map(() => uuidv4());
        const summarizationTasks = toSummarizeArray.map(
            (item, index) => (onRegistered?: () => void) => summarize(item, false, {
                characterId: char.chaId,
                roomId: room.id,
                batchId,
                operationId: operationIds[index],
                chatMemos: item.map(chat => chat.memo).filter((memo): memo is string => !!memo),
                dispatchPolicy: useDurableDispatch ? {
                    maxConcurrent: settings.summarizationMaxConcurrent,
                    requestsPerMinute: settings.summarizationRequestsPerMinute,
                } : undefined,
                onJobCreated: onRegistered,
            })
        );
        const prepareRemoteExecution = useDurableDispatch
            ? () => prepareRemoteSelection(batchId, operationIds)
            : undefined;

        // Start of performance measurement: summarize
        console.log(
            logPrefix,
            `Starting ${toSummarizeArray.length} summarization.`
        );
        const summarizeStartTime = performance.now();

        const batchResult = useDurableDispatch
            ? await executeDurableHypaBatch<string>(summarizationTasks, prepareRemoteExecution)
            : await rateLimiter.executeBatch<string>(
                summarizationTasks.map(task => () => task())
            );

        const summarizeEndTime = performance.now();
        console.debug(
            `${logPrefix} summarization completed in ${summarizeEndTime - summarizeStartTime
            }ms`
        );
        // End of performance measurement: summarize

        hypaV3ProgressStore.set({
            open: false,
            miniMsg: "",
            msg: "",
            subMsg: "",
        });

        if (remoteExecutionPrepared) {
            const failed = batchResult.results.find(result => !result.success || !result.data);
            if (failed) {
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Summarization failed: ${failed.error || 'Empty summary returned'}`,
                    memory: toSerializableHypaV3Data(data),
                };
            }
            return consumeRemoteSelection();
        }

        // Note:
        // We can't save some successful summaries to the DB temporarily
        // because don't know the actual summarization model name.
        // It is possible that the user can change the summarization model.
        for (let i = 0; i < batchResult.results.length; i++) {
            const result = batchResult.results[i];

            // Push consecutive successes
            if (!result.success || !result.data) {
                const errorMessage = !result.success
                    ? result.error
                    : "Empty summary returned";

                console.log(logPrefix, "Summarization failed:", `\n${errorMessage}`);

                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Summarization failed: ${errorMessage}`,
                    memory: toSerializableHypaV3Data(data),
                };
            }

            const summaryText = result.data;

            data.summaries.push({
                text: summaryText,
                chatMemos: new Set(toSummarizeArray[i].map((chat) => chat.memo)),
                isImportant: false,
                categoryId: undefined,
            });
        }
        room.hypaV3Data = toSerializableHypaV3Data(data);
        await recoverHypaV3SummaryJobs(char, room);
    }

    if (toSummarizeArray.length === 0 && data.summaries.length > 0) {
        await prepareRemoteSelection(uuidv4(), []);
        if (remoteExecutionPrepared) return consumeRemoteSelection();
    }

    console.log(
        logPrefix,
        `${summarizationMode ? "Completed" : "Skipped"} summarization phase:`,
        "\nCurrent Tokens:",
        currentTokens,
        "\nMax Context Tokens:",
        maxContextTokens,
        "\nAvailable Memory Tokens:",
        availableMemoryTokens
    );

    // Early return if no summaries
    if (data.summaries.length === 0) {
        const newChats: OpenAIChat[] = chats.slice(startIdx);

        console.log(
            logPrefix,
            "Exiting function:",
            "\nCurrent Tokens:",
            currentTokens,
            "\nAll chats, including memory prompt:",
            newChats,
            "\nMemory Data:",
            data
        );

        return {
            currentTokens,
            chats: newChats,
            memory: toSerializableHypaV3Data(data),
        };
    }

    const selectedSummaries: Summary[] = [];
    const randomMemoryRatio =
        1 - settings.recentMemoryRatio - settings.similarMemoryRatio;
    const selectedImportantSummaries: Summary[] = [];

    // Select important summaries
    {
        for (const summary of data.summaries) {
            if (summary.isImportant) {
                const summaryTokens = await tokenizer.tokenizeChat({
                    role: "system",
                    content: summary.text + summarySeparator,
                });

                if (summaryTokens > availableMemoryTokens) {
                    break;
                }

                selectedImportantSummaries.push(summary);

                availableMemoryTokens -= summaryTokens;
            }
        }

        selectedSummaries.push(...selectedImportantSummaries);

        console.log(
            logPrefix,
            "After important memory selection:",
            "\nSummary Count:",
            selectedImportantSummaries.length,
            "\nSummaries:",
            selectedImportantSummaries,
            "\nAvailable Memory Tokens:",
            availableMemoryTokens
        );
    }

    // Select recent summaries
    const reservedRecentMemoryTokens = Math.floor(
        availableMemoryTokens * settings.recentMemoryRatio
    );
    let consumedRecentMemoryTokens = 0;
    const selectedRecentSummaries: Summary[] = [];

    if (settings.recentMemoryRatio > 0) {
        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries.filter(
            (e) => !selectedSummaries.includes(e)
        );

        // Add one by one from the end
        for (let i = unusedSummaries.length - 1; i >= 0; i--) {
            const summary = unusedSummaries[i];
            const summaryTokens = await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            });

            if (
                summaryTokens + consumedRecentMemoryTokens >
                reservedRecentMemoryTokens
            ) {
                break;
            }

            selectedRecentSummaries.push(summary);
            consumedRecentMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedRecentSummaries);

        console.log(
            logPrefix,
            "After recent memory selection:",
            "\nSummary Count:",
            selectedRecentSummaries.length,
            "\nSummaries:",
            selectedRecentSummaries,
            "\nReserved Tokens:",
            reservedRecentMemoryTokens,
            "\nConsumed Tokens:",
            consumedRecentMemoryTokens
        );
    }

    // Select similar summaries
    let reservedSimilarMemoryTokens = Math.floor(
        availableMemoryTokens * settings.similarMemoryRatio
    );
    let consumedSimilarMemoryTokens = 0;
    const selectedSimilarSummaries: Summary[] = [];

    if (settings.similarMemoryRatio > 0) {
        // Utilize unused token space from recent selection
        if (randomMemoryRatio <= 0) {
            const unusedRecentTokens =
                reservedRecentMemoryTokens - consumedRecentMemoryTokens;

            reservedSimilarMemoryTokens += unusedRecentTokens;
            console.log(
                logPrefix,
                "Additional available token space for similar memory:",
                "\nFrom recent:",
                unusedRecentTokens
            );
        }

        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries.filter(
            (e) => !selectedSummaries.includes(e)
        );

        // Dynamically generate embedding texts
        const ebdTexts: EmbeddingText<Summary>[] = unusedSummaries.flatMap(
            (summary, summaryIndex) => {
                const splitted = splitBySeparator(summary.text, settings.summaryChunkSeparator)
                    .filter((e) => e.trim().length > 0);

                return splitted.map((chunk, chunkIndex) => ({
                    id: `${summaryIndex}-${chunkIndex}`,
                    content: chunk.trim(),
                    metadata: summary,
                }));
            }
        );

        // Initialize embedding processor
        const processor = new HypaProcessorV2<Summary>({
            rateLimiter: new TaskRateLimiter({
                tasksPerMinute: settings.embeddingRequestsPerMinute,
                maxConcurrentTasks: settings.embeddingMaxConcurrent,
            }),
        });

        processor.progressCallback = (queuedCount) => {
            hypaV3ProgressStore.set({
                open: true,
                miniMsg: `${queuedCount}`,
                msg: `${logPrefix} Similarity searching...`,
                subMsg: `${queuedCount} queued`,
            });
        };

        try {
            // Start of performance measurement: addTexts
            console.log(
                `${logPrefix} Starting addTexts with ${ebdTexts.length} chunks`
            );
            const addStartTime = performance.now();

            // Add EmbeddingTexts to processor for similarity search
            await processor.addTexts(ebdTexts);

            const addEndTime = performance.now();
            console.debug(
                `${logPrefix} addTexts completed in ${addEndTime - addStartTime}ms`
            );
            // End of performance measurement: addTexts
        } catch (error) {
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Similarity search failed: ${error}`,
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

        const recentChats = chats
            .slice(-settings.queryChatCount)
            .filter((chat) => chat.content.trim().length > 0);

        const queries = recentChats
            .map((chat, index) => {
                const subQueries = chat.content
                    .split("\n\n")
                    .filter((e) => e.trim().length > 0);
                const weight =
                    (index + 1) /
                    ((recentChats.length * (recentChats.length + 1)) / 2) /
                    subQueries.length;

                return subQueries.map((content) => ({
                    content,
                    weight,
                }));
            })
            .flat();

        if (queries.length > 0) {
            try {
                // Start of performance measurement: similarity search
                console.log(
                    `${logPrefix} Starting similarity search with ${recentChats.length} queries`
                );
                const searchStartTime = performance.now();

                const batchScoredResults = await processor.similaritySearchScoredBatch(
                    queries.map((query) => query.content)
                );

                /*
                // Hybrid search may be implemented in the future
                await keywordEngine.addDocuments(
                  Array.from(processor.vectors.values())
                );
        
                const batchkeywordResults = [];
                for (const query of queries) {
                  batchkeywordResults.push(await keywordEngine.search(query));
                }
        
                const batchHybridResults = [];
                for (let i = 0; i < queries.length; i++) {
                  const [semanticResults] = batchScoredResults[i];
                  const keywordResults = batchkeywordResults[i];
        
                  batchHybridResults.push(
                    simpleRRF<EmbeddingResult<Summary>>([
                      semanticResults,
                      keywordResults,
                    ])
                  );
                }
                */

                const searchEndTime = performance.now();
                console.debug(
                    `${logPrefix} Similarity search completed in ${searchEndTime - searchStartTime
                    }ms`
                );
                // End of performance measurement: similarity search

                const rankedChunks = simpleCC<EmbeddingResult<Summary>>(
                    batchScoredResults,
                    (listIndex) => queries[listIndex].weight
                );

                const rankedSummaries = childToParentRRF<
                    EmbeddingResult<Summary>,
                    Summary
                >(rankedChunks, (chunk) => chunk.metadata);

                while (rankedSummaries.length > 0) {
                    const summary = rankedSummaries.shift();
                    const summaryTokens = await tokenizer.tokenizeChat({
                        role: "system",
                        content: summary.text + summarySeparator,
                    });

                    if (
                        summaryTokens + consumedSimilarMemoryTokens >
                        reservedSimilarMemoryTokens
                    ) {
                        console.log(
                            logPrefix,
                            "Stopping similar memory selection:",
                            `\nconsumedSimilarMemoryTokens(${consumedSimilarMemoryTokens}) + summaryTokens(${summaryTokens}) > reservedSimilarMemoryTokens(${reservedSimilarMemoryTokens})`
                        );
                        break;
                    }

                    selectedSimilarSummaries.push(summary);
                    consumedSimilarMemoryTokens += summaryTokens;
                }

                selectedSummaries.push(...selectedSimilarSummaries);
            } catch (error) {
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Similarity search failed: ${error}`,
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
        }

        console.log(
            logPrefix,
            "After similar memory selection:",
            "\nSummary Count:",
            selectedSimilarSummaries.length,
            "\nSummaries:",
            selectedSimilarSummaries,
            "\nReserved Tokens:",
            reservedSimilarMemoryTokens,
            "\nConsumed Tokens:",
            consumedSimilarMemoryTokens
        );
    }

    // Select random summaries
    let reservedRandomMemoryTokens = Math.floor(
        availableMemoryTokens * randomMemoryRatio
    );
    let consumedRandomMemoryTokens = 0;
    const selectedRandomSummaries: Summary[] = [];

    if (randomMemoryRatio > 0) {
        // Utilize unused token space from recent and similar selection
        const unusedRecentTokens =
            reservedRecentMemoryTokens - consumedRecentMemoryTokens;
        const unusedSimilarTokens =
            reservedSimilarMemoryTokens - consumedSimilarMemoryTokens;

        reservedRandomMemoryTokens += unusedRecentTokens + unusedSimilarTokens;
        console.log(
            logPrefix,
            "Additional available token space for random memory:",
            "\nFrom recent:",
            unusedRecentTokens,
            "\nFrom similar:",
            unusedSimilarTokens,
            "\nTotal added:",
            unusedRecentTokens + unusedSimilarTokens
        );

        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries
            .filter((e) => !selectedSummaries.includes(e))
            .sort(() => Math.random() - 0.5); // Random shuffle

        for (const summary of unusedSummaries) {
            const summaryTokens = await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            });

            if (
                summaryTokens + consumedRandomMemoryTokens >
                reservedRandomMemoryTokens
            ) {
                // Trying to select more random memory
                continue;
            }

            selectedRandomSummaries.push(summary);
            consumedRandomMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedRandomSummaries);

        console.log(
            logPrefix,
            "After random memory selection:",
            "\nSummary Count:",
            selectedRandomSummaries.length,
            "\nSummaries:",
            selectedRandomSummaries,
            "\nReserved Tokens:",
            reservedRandomMemoryTokens,
            "\nConsumed Tokens:",
            consumedRandomMemoryTokens
        );
    }

    // Sort selected summaries chronologically (by index)
    selectedSummaries.sort(
        (a, b) => data.summaries.indexOf(a) - data.summaries.indexOf(b)
    );

    // Generate final memory prompt
    const memory = wrapWithXml(
        memoryPromptTag,
        selectedSummaries.map((e) => e.text).join(summarySeparator)
    );
    const realMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: memory,
    });

    // Release reserved memory tokens
    if (shouldReserveMemoryTokens) {
        currentTokens -= memoryTokens;
    }

    currentTokens += realMemoryTokens;

    console.log(
        logPrefix,
        "Final memory selection:",
        "\nSummary Count:",
        selectedSummaries.length,
        "\nSummaries:",
        selectedSummaries,
        "\nReal Memory Tokens:",
        realMemoryTokens,
        "\nAvailable Memory Tokens:",
        availableMemoryTokens
    );

    if (currentTokens > maxContextTokens) {
        throw new Error(
            `Unexpected error: input token count (${currentTokens}) exceeds max context size (${maxContextTokens})`
        );
    }

    // Save last selected summaries
    data.metrics = {
        lastImportantSummaries: selectedImportantSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected)
        ),
        lastRecentSummaries: selectedRecentSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected)
        ),
        lastSimilarSummaries: selectedSimilarSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected)
        ),
        lastRandomSummaries: selectedRandomSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected)
        ),
    };

    const newChats: OpenAIChat[] = [
        {
            role: "system",
            content: memory,
            memo: "supaMemory",
        },
        ...chats.slice(startIdx),
    ];

    console.log(
        logPrefix,
        "Exiting function:",
        "\nCurrent Tokens:",
        currentTokens,
        "\nAll chats, including memory prompt:",
        newChats,
        "\nMemory Data:",
        data
    );

    return {
        currentTokens,
        chats: newChats,
        memory: toSerializableHypaV3Data(data),
    };
}

async function hypaMemoryV3Main(
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character,
    tokenizer: ChatTokenizer,
): Promise<HypaV3Result> {
    const db = getDatabase();
    const settings = getCurrentHypaV3Preset().settings;

    // Validate settings
    if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
        return {
            currentTokens,
            chats,
            error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
        };
    }

    // Initial token correction — must match the output-token reservation the
    // caller added (preset max-output for ModelPreset chats, else db.maxResponse).
    currentTokens -= resolveChatMaxResponseTokens(room);

    // Load existing hypa data if available
    const data: HypaV3Data = room.hypaV3Data
        ? toHypaV3Data(room.hypaV3Data)
        : {
            summaries: [],
        };

    // Clean orphaned summaries
    if (!settings.preserveOrphanedMemory) {
        cleanOrphanedSummary(chats, data);
    }

    // Determine starting index
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

    console.log(logPrefix, "Starting index:", startIdx);

    // Reserve memory tokens
    const emptyMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: wrapWithXml(memoryPromptTag, ""),
    });
    const memoryTokens = Math.floor(
        maxContextTokens * settings.memoryTokensRatio
    );
    const shouldReserveEmptyMemoryTokens =
        data.summaries.length === 0 &&
        currentTokens + emptyMemoryTokens <= maxContextTokens;
    let availableMemoryTokens = shouldReserveEmptyMemoryTokens
        ? 0
        : memoryTokens - emptyMemoryTokens;

    if (shouldReserveEmptyMemoryTokens) {
        currentTokens += emptyMemoryTokens;
        console.log(logPrefix, "Reserved empty memory tokens:", emptyMemoryTokens);
    } else {
        currentTokens += memoryTokens;
        console.log(logPrefix, "Reserved max memory tokens:", memoryTokens);
    }

    // If summarization is needed
    const summarizationMode = currentTokens > maxContextTokens;
    const targetTokens =
        maxContextTokens * (1 - settings.extraSummarizationRatio);

    while (summarizationMode) {
        if (currentTokens <= targetTokens) {
            break;
        }

        if (chats.length - startIdx <= settings.queryChatCount) {
            if (currentTokens <= maxContextTokens) {
                break;
            } else {
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
                    memory: toSerializableHypaV3Data(data),
                };
            }
        }

        const toSummarize: OpenAIChat[] = [];
        const endIdx = Math.min(
            startIdx + settings.maxChatsPerSummary,
            chats.length - settings.queryChatCount
        );
        let toSummarizeTokens = 0;

        console.log(
            logPrefix,
            "Evaluating summarization batch:",
            "\nCurrent Tokens:",
            currentTokens,
            "\nMax Context Tokens:",
            maxContextTokens,
            "\nStart Index:",
            startIdx,
            "\nEnd Index:",
            endIdx,
            "\nChat Count:",
            endIdx - startIdx,
            "\nMax Chats Per Summary:",
            settings.maxChatsPerSummary
        );

        for (let i = startIdx; i < endIdx; i++) {
            const chat = chats[i];
            const chatTokens = await tokenizer.tokenizeChat(chat);

            console.log(
                logPrefix,
                "Evaluating chat:",
                "\nIndex:",
                i,
                "\nRole:",
                chat.role,
                "\nContent:",
                "\n" + chat.content,
                "\nTokens:",
                chatTokens
            );

            toSummarizeTokens += chatTokens;

            if (
                chat.name === "example_user" ||
                chat.name === "example_assistant" ||
                chat.memo === "NewChatExample"
            ) {
                console.log(logPrefix, `Skipping example chat at index ${i}`);
                continue;
            }

            if (chat.memo === "NewChat") {
                console.log(logPrefix, `Skipping new chat at index ${i}`);
                continue;
            }

            if (chat.content.trim().length === 0) {
                console.log(logPrefix, `Skipping empty chat at index ${i}`);
                continue;
            }

            if (settings.doNotSummarizeUserMessage && chat.role === "user") {
                console.log(logPrefix, `Skipping user role at index ${i}`);
                continue;
            }

            toSummarize.push(chat);
        }

        // Stop summarization if further reduction would go below target tokens (unless we're over max tokens)
        if (
            currentTokens <= maxContextTokens &&
            currentTokens - toSummarizeTokens < targetTokens
        ) {
            console.log(
                logPrefix,
                "Stopping summarization:",
                `\ncurrentTokens(${currentTokens}) - toSummarizeTokens(${toSummarizeTokens}) < targetTokens(${targetTokens})`
            );
            break;
        }

        // Attempt summarization
        if (toSummarize.length > 0) {
            console.log(
                logPrefix,
                "Attempting summarization:",
                "\nTarget:",
                toSummarize
            );

            try {
                const summarizeResult = await summarize(toSummarize, false, {
                    characterId: char.chaId,
                    roomId: room.id,
                    batchId: uuidv4(),
                    chatMemos: toSummarize.map(chat => chat.memo).filter((memo): memo is string => !!memo),
                });

                data.summaries.push({
                    text: summarizeResult,
                    chatMemos: new Set(toSummarize.map((chat) => chat.memo)),
                    isImportant: false,
                    categoryId: undefined,
                });
                room.hypaV3Data = toSerializableHypaV3Data(data);
                await recoverHypaV3SummaryJobs(char, room);
            } catch (error) {
                console.log(logPrefix, "Summarization failed:", `\n${error}`);

                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Summarization failed: ${error}`,
                    memory: toSerializableHypaV3Data(data),
                };
            }
        }

        currentTokens -= toSummarizeTokens;
        startIdx = endIdx;
    }

    console.log(
        logPrefix,
        `${summarizationMode ? "Completed" : "Skipped"} summarization phase:`,
        "\nCurrent Tokens:",
        currentTokens,
        "\nMax Context Tokens:",
        maxContextTokens,
        "\nAvailable Memory Tokens:",
        availableMemoryTokens
    );

    // Early return if no summaries
    if (data.summaries.length === 0) {
        // Generate final memory prompt
        const memory = wrapWithXml(memoryPromptTag, "");

        const newChats: OpenAIChat[] = [
            {
                role: "system",
                content: memory,
                memo: "supaMemory",
            },
            ...chats.slice(startIdx),
        ];

        console.log(
            logPrefix,
            "Exiting function:",
            "\nCurrent Tokens:",
            currentTokens,
            "\nAll chats, including memory prompt:",
            newChats,
            "\nMemory Data:",
            data
        );

        return {
            currentTokens,
            chats: newChats,
            memory: toSerializableHypaV3Data(data),
        };
    }

    const selectedSummaries: Summary[] = [];
    const randomMemoryRatio =
        1 - settings.recentMemoryRatio - settings.similarMemoryRatio;
    const selectedImportantSummaries: Summary[] = [];

    // Select important summaries
    {
        for (const summary of data.summaries) {
            if (summary.isImportant) {
                const summaryTokens = await tokenizer.tokenizeChat({
                    role: "system",
                    content: summary.text + summarySeparator,
                });

                if (summaryTokens > availableMemoryTokens) {
                    break;
                }

                selectedImportantSummaries.push(summary);

                availableMemoryTokens -= summaryTokens;
            }
        }

        selectedSummaries.push(...selectedImportantSummaries);

        console.log(
            logPrefix,
            "After important memory selection:",
            "\nSummary Count:",
            selectedImportantSummaries.length,
            "\nSummaries:",
            selectedImportantSummaries,
            "\nAvailable Memory Tokens:",
            availableMemoryTokens
        );
    }

    // Select recent summaries
    const reservedRecentMemoryTokens = Math.floor(
        availableMemoryTokens * settings.recentMemoryRatio
    );
    let consumedRecentMemoryTokens = 0;
    const selectedRecentSummaries: Summary[] = [];

    if (settings.recentMemoryRatio > 0) {
        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries.filter(
            (e) => !selectedSummaries.includes(e)
        );

        // Add one by one from the end
        for (let i = unusedSummaries.length - 1; i >= 0; i--) {
            const summary = unusedSummaries[i];
            const summaryTokens = await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            });

            if (
                summaryTokens + consumedRecentMemoryTokens >
                reservedRecentMemoryTokens
            ) {
                break;
            }

            selectedRecentSummaries.push(summary);
            consumedRecentMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedRecentSummaries);

        console.log(
            logPrefix,
            "After recent memory selection:",
            "\nSummary Count:",
            selectedRecentSummaries.length,
            "\nSummaries:",
            selectedRecentSummaries,
            "\nReserved Tokens:",
            reservedRecentMemoryTokens,
            "\nConsumed Tokens:",
            consumedRecentMemoryTokens
        );
    }

    // Select similar summaries
    let reservedSimilarMemoryTokens = Math.floor(
        availableMemoryTokens * settings.similarMemoryRatio
    );
    let consumedSimilarMemoryTokens = 0;
    const selectedSimilarSummaries: Summary[] = [];

    if (settings.similarMemoryRatio > 0) {
        // Utilize unused token space from recent selection
        if (randomMemoryRatio <= 0) {
            const unusedRecentTokens =
                reservedRecentMemoryTokens - consumedRecentMemoryTokens;

            reservedSimilarMemoryTokens += unusedRecentTokens;
            console.log(
                logPrefix,
                "Additional available token space for similar memory:",
                "\nFrom recent:",
                unusedRecentTokens
            );
        }

        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries.filter(
            (e) => !selectedSummaries.includes(e)
        );

        // Dynamically generate summary chunks
        const summaryChunks: SummaryChunk[] = [];

        unusedSummaries.forEach((summary) => {
            const splitted = splitBySeparator(summary.text, settings.summaryChunkSeparator)
                .filter((e) => e.trim().length > 0);

            summaryChunks.push(
                ...splitted.map((e) => ({
                    text: e.trim(),
                    summary,
                }))
            );
        });

        // Initialize embedding processor
        const processor = new HypaProcesserEx(db.hypaModel);
        processor.oaikey = db.supaMemoryKey;

        // Add summaryChunks to processor for similarity search
        try {
            await processor.addSummaryChunks(summaryChunks);
        } catch (error) {
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Similarity search failed: ${error}`,
                memory: toSerializableHypaV3Data(data),
            };
        }

        const recentChats = chats
            .slice(-settings.queryChatCount)
            .filter((chat) => chat.content.trim().length > 0);

        if (recentChats.length > 0) {
            // Raw recent chat search
            const queries = recentChats.map((chat) => chat.content);

            if (settings.enableSimilarityCorrection && recentChats.length > 1) {
                // Raw + Summarized recent chat search
                // Summarizing is meaningful when there are more than 2 recent chats

                // Attempt summarization
                console.log(
                    logPrefix,
                    "Attempting summarization for similarity search:",
                    "\nTarget:",
                    recentChats
                );

                try {
                    const summarizeResult = await summarize(recentChats);

                    queries.push(summarizeResult);
                } catch (error) {
                    console.log(logPrefix, "Summarization failed:", `\n${error}`);

                    return {
                        currentTokens,
                        chats,
                        error: `${logPrefix} Summarization failed: ${error}`,
                        memory: toSerializableHypaV3Data(data),
                    };
                }
            }

            try {
                const scoredLists: [SummaryChunk, number][][] = [];

                for (let i = 0; i < queries.length; i++) {
                    const query = queries[i];
                    const scoredChunks = await processor.similaritySearchScoredEx(query);

                    scoredLists.push(scoredChunks);
                }

                const rankedChunks = simpleCC<SummaryChunk>(
                    scoredLists,
                    (listIndex, totalLists) => {
                        return (listIndex + 1) / ((totalLists * (totalLists + 1)) / 2);
                    }
                );

                const rankedSummaries = childToParentRRF<SummaryChunk, Summary>(
                    rankedChunks,
                    (chunk) => chunk.summary
                );

                while (rankedSummaries.length > 0) {
                    const summary = rankedSummaries.shift();
                    const summaryTokens = await tokenizer.tokenizeChat({
                        role: "system",
                        content: summary.text + summarySeparator,
                    });

                    if (
                        summaryTokens + consumedSimilarMemoryTokens >
                        reservedSimilarMemoryTokens
                    ) {
                        console.log(
                            logPrefix,
                            "Stopping similar memory selection:",
                            `\nconsumedSimilarMemoryTokens(${consumedSimilarMemoryTokens}) + summaryTokens(${summaryTokens}) > reservedSimilarMemoryTokens(${reservedSimilarMemoryTokens})`
                        );
                        break;
                    }

                    selectedSimilarSummaries.push(summary);
                    consumedSimilarMemoryTokens += summaryTokens;
                }

                selectedSummaries.push(...selectedSimilarSummaries);
            } catch (error) {
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Similarity search failed: ${error}`,
                    memory: toSerializableHypaV3Data(data),
                };
            }
        }

        console.log(
            logPrefix,
            "After similar memory selection:",
            "\nSummary Count:",
            selectedSimilarSummaries.length,
            "\nSummaries:",
            selectedSimilarSummaries,
            "\nReserved Tokens:",
            reservedSimilarMemoryTokens,
            "\nConsumed Tokens:",
            consumedSimilarMemoryTokens
        );
    }

    // Select random summaries
    let reservedRandomMemoryTokens = Math.floor(
        availableMemoryTokens * randomMemoryRatio
    );
    let consumedRandomMemoryTokens = 0;
    const selectedRandomSummaries: Summary[] = [];

    if (randomMemoryRatio > 0) {
        // Utilize unused token space from recent and similar selection
        const unusedRecentTokens =
            reservedRecentMemoryTokens - consumedRecentMemoryTokens;
        const unusedSimilarTokens =
            reservedSimilarMemoryTokens - consumedSimilarMemoryTokens;

        reservedRandomMemoryTokens += unusedRecentTokens + unusedSimilarTokens;
        console.log(
            logPrefix,
            "Additional available token space for random memory:",
            "\nFrom recent:",
            unusedRecentTokens,
            "\nFrom similar:",
            unusedSimilarTokens,
            "\nTotal added:",
            unusedRecentTokens + unusedSimilarTokens
        );

        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries
            .filter((e) => !selectedSummaries.includes(e))
            .sort(() => Math.random() - 0.5); // Random shuffle

        for (const summary of unusedSummaries) {
            const summaryTokens = await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            });

            if (
                summaryTokens + consumedRandomMemoryTokens >
                reservedRandomMemoryTokens
            ) {
                // Trying to select more random memory
                continue;
            }

            selectedRandomSummaries.push(summary);
            consumedRandomMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedRandomSummaries);

        console.log(
            logPrefix,
            "After random memory selection:",
            "\nSummary Count:",
            selectedRandomSummaries.length,
            "\nSummaries:",
            selectedRandomSummaries,
            "\nReserved Tokens:",
            reservedRandomMemoryTokens,
            "\nConsumed Tokens:",
            consumedRandomMemoryTokens
        );
    }

    // Sort selected summaries chronologically (by index)
    selectedSummaries.sort(
        (a, b) => data.summaries.indexOf(a) - data.summaries.indexOf(b)
    );

    // Generate final memory prompt
    const memory = wrapWithXml(
        memoryPromptTag,
        selectedSummaries.map((e) => e.text).join(summarySeparator)
    );
    const realMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: memory,
    });

    // Release reserved memory tokens
    if (shouldReserveEmptyMemoryTokens) {
        currentTokens -= emptyMemoryTokens;
    } else {
        currentTokens -= memoryTokens;
    }

    currentTokens += realMemoryTokens;

    console.log(
        logPrefix,
        "Final memory selection:",
        "\nSummary Count:",
        selectedSummaries.length,
        "\nSummaries:",
        selectedSummaries,
        "\nReal Memory Tokens:",
        realMemoryTokens,
        "\nAvailable Memory Tokens:",
        availableMemoryTokens
    );

    if (currentTokens > maxContextTokens) {
        throw new Error(
            `Unexpected error: input token count (${currentTokens}) exceeds max context size (${maxContextTokens})`
        );
    }

    // Save last selected summaries
    data.metrics = {
        lastImportantSummaries: selectedImportantSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected)
        ),
        lastRecentSummaries: selectedRecentSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected)
        ),
        lastSimilarSummaries: selectedSimilarSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected)
        ),
        lastRandomSummaries: selectedRandomSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected)
        ),
    };

    const newChats: OpenAIChat[] = [
        {
            role: "system",
            content: memory,
            memo: "supaMemory",
        },
        ...chats.slice(startIdx),
    ];

    console.log(
        logPrefix,
        "Exiting function:",
        "\nCurrent Tokens:",
        currentTokens,
        "\nAll chats, including memory prompt:",
        newChats,
        "\nMemory Data:",
        data
    );

    return {
        currentTokens,
        chats: newChats,
        memory: toSerializableHypaV3Data(data),
    };
}

function toHypaV3Data(serialData: SerializableHypaV3Data): HypaV3Data {
    // Remove legacy property
    const { lastSelectedSummaries, ...restData } = serialData;

    return {
        ...restData,
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
            chatMemos: [...summary.chatMemos],
        })),
    };
}

function cleanOrphanedSummary(chats: OpenAIChat[], data: HypaV3Data): void {
    // Collect all memos from current chats
    const currentChatMemos = new Set(chats.map((chat) => chat.memo));
    const originalLength = data.summaries.length;

    // Filter summaries - keep only those whose chatMemos are subset of current chat memos
    data.summaries = data.summaries.filter((summary) => {
        return isSubset(summary.chatMemos, currentChatMemos);
    });

    const removedCount = originalLength - data.summaries.length;

    if (removedCount > 0) {
        console.log(logPrefix, `Cleaned ${removedCount} orphaned summaries.`);
    }
}

function isSubset(subset: Set<string>, superset: Set<string>): boolean {
    for (const elem of subset) {
        if (!superset.has(elem)) {
            return false;
        }
    }

    return true;
}

function wrapWithXml(tag: string, content: string): string {
    return `<${tag}>\n${content}\n</${tag}>`;
}

function sanitizeSummaryContent(content: string): string {
    return content.replace(inlayTokenRegex, "[Image]");
}

export async function summarize(
    oaiMessages: OpenAIChat[],
    isResummarize: boolean = false,
    revenantTarget?: {
        characterId: string;
        roomId: string;
        batchId: string;
        operationId?: string;
        chatMemos: string[];
        dispatchPolicy?: { maxConcurrent: number; requestsPerMinute: number };
        onJobCreated?: () => void;
    },
): Promise<string> {
    const db = getDatabase();
    const settings = getCurrentHypaV3Preset().settings;

    const strMessages = oaiMessages
        .map((chat) => `${chat.role}: ${sanitizeSummaryContent(chat.content)}`)
        .join("\n");

    const summarizationPrompt = isResummarize
        ? (settings.reSummarizationPrompt.trim() === "" ? "Re-summarize this summaries." : settings.reSummarizationPrompt)
        : settings.summarizationPrompt.trim() === ""
            ? "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]"
            : settings.summarizationPrompt;

    const formated: OpenAIChat[] = parseChatML(
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

    // API
    if (settings.summarizationModel === "subModel") {
        console.log(logPrefix, `Using ax model ${db.subModel} for summarization.`);

        // Match requestChatDataMain's model resolution: when seperateModelsForAxModels
        // is on, the 'memory' slot overrides db.subModel for this request.
        const actualModel = (db.seperateModelsForAxModels && db.seperateModels?.memory)
            ? db.seperateModels.memory
            : db.subModel;
        let subModelUrl = '';
        if (actualModel === 'reverse_proxy') {
            subModelUrl = db.forceReplaceUrl ?? '';
        } else if (actualModel?.startsWith('xcustom:::')) {
            subModelUrl = db.customModels?.find(m => m.id === actualModel)?.url ?? '';
        }

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
            },
            "memory"
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

        // Remove thoughts content for API
        const thoughtsRegex = /<Thoughts>[\s\S]*?<\/Thoughts>/g;
        const result = response.result.replace(thoughtsRegex, "").trim();

        if (result.length === 0) {
            throw new Error("Empty summary after removing thoughts content");
        }

        return result;
    }

    // Local — ensure system message comes first for WebLLM models
    const firstSystemIndex = formated.findIndex(m => m.role === 'system');
    if (firstSystemIndex > 0) {
        const [system] = formated.splice(firstSystemIndex, 1);
        formated.unshift(system);
    }

    const content = await chatCompletion(formated, settings.summarizationModel, {
        max_tokens: 8192,
        temperature: 0,
        extra_body: {
            enable_thinking: false,
        },
    });

    if (!content || content.trim().length === 0) {
        throw new Error("Empty summary returned");
    }

    // Remove think content
    const thinkRegex = /<think>[\s\S]*?<\/think>/g;
    const result = content.replace(thinkRegex, "").trim();

    if (result.length === 0) {
        throw new Error("Empty summary after removing think content");
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
        summarizationModel: "subModel",
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
        // Experimental
        useExperimentalImpl: false,
        summarizationRequestsPerMinute: 20,
        summarizationMaxConcurrent: 1,
        embeddingRequestsPerMinute: 100,
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

    // HypaMemory V3 summaries always use the configured auxiliary model.
    settings.summarizationModel = "subModel";

    return {
        name,
        settings,
    };
}

function simpleCC<T>(
    scoredLists: [T, number][][],
    weightFunc?: (listIndex: number, totalLists: number) => number
): T[] {
    const scores = new Map<T, number>();

    for (let listIndex = 0; listIndex < scoredLists.length; listIndex++) {
        const list = scoredLists[listIndex];
        const weight = weightFunc
            ? weightFunc(listIndex, scoredLists.length)
            : 1 / scoredLists.length;

        for (const [item, score] of list) {
            scores.set(item, (scores.get(item) || 0) + score * weight);
        }
    }

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([item]) => item);
}

function simpleRRF<T>(rankedLists: T[][], k: number = 60): T[] {
    const scores = new Map<T, number>();

    for (let listIndex = 0; listIndex < rankedLists.length; listIndex++) {
        const list = rankedLists[listIndex];

        for (let itemIndex = 0; itemIndex < list.length; itemIndex++) {
            const item = list[itemIndex];
            const rank = itemIndex + 1;
            const rrfTerm = 1 / (k + rank);

            scores.set(item, (scores.get(item) || 0) + rrfTerm);
        }
    }

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([item]) => item);
}

function childToParentRRF<C, P>(
    rankedChildren: C[],
    parentFunc: (child: C) => P,
    k: number = 60
): P[] {
    const scores = new Map<P, number>();

    for (let childIndex = 0; childIndex < rankedChildren.length; childIndex++) {
        const child = rankedChildren[childIndex];
        const parent = parentFunc(child);
        const rank = childIndex + 1;
        const rrfTerm = 1 / (k + rank);

        scores.set(parent, (scores.get(parent) || 0) + rrfTerm);
    }

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([parent]) => parent);
}

function normalizeScores<T>(scoredList: [T, number][]): [T, number][] {
    if (scoredList.length === 0) {
        return [];
    }

    const scores = scoredList.map(([, score]) => score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);

    if (minScore === maxScore) {
        if (minScore === 0) {
            return scoredList.map(([item]) => [item, 0]);
        }

        return scoredList.map(([item]) => [item, 1]);
    }

    return scoredList.map(([item, score]) => {
        const normalizedScore = (score - minScore) / (maxScore - minScore);
        return [item, normalizedScore];
    });
}

interface SummaryChunkVector {
    chunk: SummaryChunk;
    vector: memoryVector;
}

class HypaProcesserEx extends HypaProcesser {
    // Maintain references to SummaryChunks and their associated memoryVectors
    summaryChunkVectors: SummaryChunkVector[] = [];

    async addSummaryChunks(chunks: SummaryChunk[]): Promise<void> {
        if (isContextModel(this.model)) {
            await this.addSummaryChunksContextual(chunks);
            return;
        }

        const texts = chunks.map((chunk) => chunk.text);
        await this.addText(texts);

        const newSummaryChunkVectors: SummaryChunkVector[] = [];
        for (const chunk of chunks) {
            const vector = this.vectors.find((v) => v.content === chunk.text);
            if (!vector) {
                throw new Error(
                    `Failed to create vector for summary chunk:\n${chunk.text}`
                );
            }
            newSummaryChunkVectors.push({ chunk, vector });
        }

        this.summaryChunkVectors.push(...newSummaryChunkVectors);
    }

    private async addSummaryChunksContextual(chunks: SummaryChunk[]): Promise<void> {
        const provider = getContextProvider(this.model);

        const cacheKeyFor = (text: string, groupTexts: string[]) => {
            return `${text}${provider.getCacheKeySuffix(groupTexts)}`;
        };

        const summaryGroups = new Map<Summary, SummaryChunk[]>();
        for (const chunk of chunks) {
            const group = summaryGroups.get(chunk.summary) || [];
            group.push(chunk);
            summaryGroups.set(chunk.summary, group);
        }

        const groupsToEmbed: SummaryChunk[][] = [];
        const cachedVectors = new Map<string, memoryVector>();

        for (const [, group] of summaryGroups) {
            const groupTexts = group.map(c => c.text);
            let allCached = true;
            const groupCache = new Map<string, memoryVector>();

            for (const chunk of group) {
                const cached: memoryVector = await getPersistedHypaVector(cacheKeyFor(chunk.text, groupTexts));
                if (cached) {
                    groupCache.set(chunk.text, cached);
                } else {
                    allCached = false;
                }
            }

            if (allCached) {
                for (const [text, vector] of groupCache) {
                    cachedVectors.set(text, vector);
                }
            } else {
                groupsToEmbed.push(group);
            }
        }

        if (groupsToEmbed.length > 0) {
            const groups = groupsToEmbed.map(group =>
                group.map(chunk => chunk.text)
            );

            const results = await provider.embedDocumentGroups(groups);

            for (let i = 0; i < groupsToEmbed.length; i++) {
                const group = groupsToEmbed[i];
                const groupTexts = group.map(c => c.text);
                const embeddings = results[i];

                for (let j = 0; j < group.length; j++) {
                    const chunk = group[j];
                    const embedding = embeddings[j];
                    const vector: memoryVector = {
                        content: chunk.text,
                        embedding
                    };

                    await setPersistedHypaVector(cacheKeyFor(chunk.text, groupTexts), vector);
                    cachedVectors.set(chunk.text, vector);
                }
            }
        }

        for (const chunk of chunks) {
            const vector = cachedVectors.get(chunk.text);
            if (!vector) {
                throw new Error(
                    `Failed to create vector for summary chunk:\n${chunk.text}`
                );
            }

            this.vectors.push(vector);
            this.summaryChunkVectors.push({ chunk, vector });
        }
    }

    async similaritySearchScoredEx(
        query: string
    ): Promise<[SummaryChunk, number][]> {
        const queryVector = (await this.getEmbeds(query))[0];

        return this.summaryChunkVectors
            .map((scv) => ({
                chunk: scv.chunk,
                similarity: similarity(queryVector, scv.vector.embedding),
            }))
            .sort((a, b) => b.similarity - a.similarity)
            .map((result) => [result.chunk, result.similarity]);
    }
}
