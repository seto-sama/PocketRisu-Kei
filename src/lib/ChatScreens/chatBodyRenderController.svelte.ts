import { createSubscriber } from 'svelte/reactivity'
import { DBState } from '../../ts/stores.svelte'
import {
    ParseMarkdown,
    postTranslationParse,
    type CbsConditions,
    type simpleCharacterArgument,
} from '../../ts/parser/parser.svelte'
import {
    getLLMCache,
    subscribeLLMTranslationCache,
    translateHTML,
} from '../../ts/translator/translator'
import { sleep } from '../../ts/util'

type ParseMode = 'normal' | 'back' | 'pretranslate' | 'notrim'
type ParseMessageMarkdown = (data: string, mode: ParseMode) => Promise<string>

export const translationLoadingHTML = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`

export function createChatBodyRenderController(
    onTranslationTaskChange: (delta: 1 | -1) => void,
    onTranslationCancelAvailabilityChange: (cancel: (() => void) | null) => void = () => {},
) {
    let activeTranslationTasks = $state(0)
    let cacheRefresh = 0
    let lastCacheRefresh = 0
    let currentCacheKey: string | null = null
    let lastStreamingDisplay: boolean | null = null
    let lastTranslationPending: boolean | null = null
    let disposed = false
    const renderAbortController = new AbortController()
    const translationAbortControllers = new Map<AbortController, {
        persistOnDispose: boolean
    }>()

    function cancelTranslations(includePersistent = true) {
        for (const [controller, task] of translationAbortControllers) {
            if (!includePersistent && task.persistOnDispose) continue
            controller.abort()
        }
    }

    function updateTranslationCanceller() {
        onTranslationCancelAvailabilityChange(
            translationAbortControllers.size > 0
                ? cancelTranslations
                : null,
        )
    }

    const trackLLMTranslationCache = createSubscriber((update) =>
        subscribeLLMTranslationCache((key) => {
            if (
                activeTranslationTasks === 0
                && (key === null || key === currentCacheKey)
            ) {
                cacheRefresh += 1
                update()
            }
        })
    )

    function beginRender(options: {
        streaming: boolean
        translationPending: boolean
    }) {
        trackLLMTranslationCache()
        const invalidated = cacheRefresh !== lastCacheRefresh
            || lastStreamingDisplay !== options.streaming
            || lastTranslationPending !== options.translationPending
        lastCacheRefresh = cacheRefresh
        lastStreamingDisplay = options.streaming
        lastTranslationPending = options.translationPending

        // A render already in flight must keep the mode it started with.
        const inlineThoughts = options.streaming
        return {
            invalidated,
            parseMarkdown(
                data: string,
                charArg: string | simpleCharacterArgument | null,
                mode: ParseMode,
                chatId: number,
                cbsConditions: CbsConditions,
            ) {
                return ParseMarkdown(
                    data,
                    charArg,
                    mode,
                    chatId,
                    cbsConditions,
                    { inlineThoughts },
                )
            },
        }
    }

    async function runTranslationTask<T>(
        task: (signal: AbortSignal) => Promise<T>,
        cacheKey: string | null,
        regenerate: boolean,
    ): Promise<T> {
        // Translation rendering is derived asynchronously. Always cross an
        // await boundary before mutating task state.
        await Promise.resolve()
        currentCacheKey = cacheKey
        const needsTranslation = DBState.db.translatorType !== 'llm'
            || regenerate
            || cacheKey === null
            || await getLLMCache(cacheKey) === null
        if (!needsTranslation) {
            renderAbortController.signal.throwIfAborted()
            return await task(renderAbortController.signal)
        }

        // Do not start new work after the body has gone away. LLM requests
        // which were already started are handled separately in dispose() so
        // they can finish and populate the translation cache.
        if (disposed) renderAbortController.signal.throwIfAborted()
        const abortController = new AbortController()
        translationAbortControllers.set(abortController, {
            persistOnDispose: DBState.db.translatorType === 'llm',
        })
        updateTranslationCanceller()
        activeTranslationTasks += 1
        onTranslationTaskChange(1)
        try {
            const result = await task(abortController.signal)
            // A persistent LLM request may finish after its chat body has been
            // disposed so translateHTML can store the result. Stop before any
            // detached Markdown/DOM rendering continues.
            if (disposed) renderAbortController.signal.throwIfAborted()
            return result
        }
        finally {
            translationAbortControllers.delete(abortController)
            updateTranslationCanceller()
            // dispose() already released every task reported to the parent.
            if (!disposed) {
                activeTranslationTasks = Math.max(0, activeTranslationTasks - 1)
                onTranslationTaskChange(-1)
            }
        }
    }

    function dispose() {
        if (disposed) return
        disposed = true
        renderAbortController.abort()
        // Navigating away should not turn an already-issued LLM translation
        // into "Generation job aborted". Detached revenant jobs finish in the
        // background and populate the cache; explicit user cancellation still
        // calls cancelTranslations() with persistent tasks included.
        cancelTranslations(false)
        translationAbortControllers.clear()
        updateTranslationCanceller()
        while (activeTranslationTasks > 0) {
            activeTranslationTasks -= 1
            onTranslationTaskChange(-1)
        }
    }

    async function renderTranslation(options: {
        data: string
        charArg: string | simpleCharacterArgument | null
        chatId: number
        retranslate: boolean
        translationCacheKey: string | null
        parseMarkdown: ParseMessageMarkdown
    }): Promise<string> {
        let html: string
        if (
            DBState.db.translatorType === 'llm'
            && DBState.db.translateBeforeHTMLFormatting
        ) {
            await sleep(100)
            const cacheKey = options.translationCacheKey ?? options.data
            const translatedData = await runTranslationTask(
                (signal) => translateHTML(
                    options.data,
                    false,
                    options.charArg,
                    options.chatId,
                    options.retranslate,
                    signal,
                ),
                cacheKey,
                options.retranslate,
            )
            html = await options.parseMarkdown(translatedData, 'notrim')
        }
        else if (!DBState.db.legacyTranslation) {
            const marked = options.translationCacheKey
                ?? await options.parseMarkdown(options.data, 'pretranslate')
            const cacheKey = DBState.db.translatorType === 'llm' ? marked : null
            html = await runTranslationTask(
                async (signal) => postTranslationParse(await translateHTML(
                    marked,
                    false,
                    options.charArg,
                    options.chatId,
                    options.retranslate,
                    signal,
                )),
                cacheKey,
                options.retranslate,
            )
        }
        else {
            const marked = options.translationCacheKey
                ?? await options.parseMarkdown(options.data, 'notrim')
            const cacheKey = DBState.db.translatorType === 'llm' ? marked : null
            html = await runTranslationTask(
                (signal) => translateHTML(
                    marked,
                    false,
                    options.charArg,
                    options.chatId,
                    options.retranslate,
                    signal,
                ),
                cacheKey,
                options.retranslate,
            )
        }

        return html
    }

    function isTranslationBusy(
        translationPending: boolean,
        retranslate: boolean,
    ): boolean {
        return activeTranslationTasks > 0
            || translationPending
            || retranslate
    }

    return {
        beginRender,
        dispose,
        isDisposed: () => disposed,
        isTranslationBusy,
        renderTranslation,
    }
}
