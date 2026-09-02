<script lang="ts">
    import { XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { safeStructuredClone } from 'src/ts/polyfill'
    import {
        doingChat,
        previewBody,
        previewFormated,
        sendChat,
        type OpenAIChat,
    } from 'src/ts/process/index.svelte'
    import { formatChatML } from 'src/ts/process/templates/chatTemplate'
    import IconButton from 'src/lib/UI/GUI/IconButton.svelte'
    import ShChoiceGroup from 'src/lib/UI/GUI/ShChoiceGroup.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'

    interface Props {
        open?: boolean
    }

    type PreviewMode = 'chat' | 'chatml' | 'json'

    let { open = $bindable(false) }: Props = $props()
    let previewMode = $state<PreviewMode>('chat')
    let displayedMode = $state<PreviewMode>('chat')
    let loading = $state(false)
    let error = $state('')
    let messages = $state<OpenAIChat[] | null>(null)
    let chatml = $state<string | null>(null)
    let requestJson = $state<string | null>(null)

    const typeOptions = [
        { value: 'chat', label: language.devToolPromptPreview.chat },
        { value: 'chatml', label: language.devToolPromptPreview.chatml },
        { value: 'json', label: 'JSON' },
    ]
    function prettyRequestBody(body: string): string {
        try {
            const request = JSON.parse(body)
            if (request && typeof request === 'object' && typeof request.body === 'string') {
                try {
                    request.body = JSON.parse(request.body)
                } catch {
                    // Some providers intentionally use a non-JSON request body.
                }
            }
            return JSON.stringify(request, null, 2)
        } catch {
            return JSON.stringify({ body }, null, 2)
        }
    }

    async function generatePreview(mode: PreviewMode) {
        if (loading || $doingChat) return
        if (mode === 'json' ? requestJson !== null : messages !== null) {
            error = ''
            displayedMode = mode
            return
        }

        loading = true
        error = ''

        try {
            const showActualRequest = mode === 'json'
            const success = await sendChat(-1, {
                preview: !showActualRequest,
                previewPrompt: showActualRequest,
            })
            if (!success) return

            if (showActualRequest) {
                requestJson = prettyRequestBody(previewBody)
                displayedMode = mode
                return
            }

            messages = safeStructuredClone(previewFormated)
            chatml = formatChatML(messages)
            displayedMode = mode
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            doingChat.set(false)
            loading = false
        }
    }

    $effect(() => {
        if (!open) return
        const mode = previewMode
        queueMicrotask(() => void generatePreview(mode))
    })
</script>

<ShDialog
    bind:open
    size="xl"
    closable={false}
    contentClass="gap-0 p-0"
    bodyClass="min-h-0 flex flex-col"
    ariaLabel={language.devToolPreview.request}
>
    <div class="flex flex-wrap items-center gap-3 border-b border-darkborderc px-4 py-3">
        <h2 class="shrink-0 text-lg font-semibold text-maintext">{language.devToolPreview.request}</h2>

        <span class="text-xs text-subtext">{language.promptDiff.viewMode}</span>
        <ShChoiceGroup
            variant="pill"
            name="request-preview-type"
            bind:value={previewMode}
            options={typeOptions}
            disabled={loading}
        />

        <IconButton className="ml-auto" onclick={() => open = false} title={language.close} aria-label={language.close}>
            <XIcon size={20} />
        </IconButton>
    </div>

    <div class="relative min-h-80 flex-1 overflow-y-auto px-3 py-4">
        {#if loading}
            <div class="absolute inset-0 z-10 flex min-h-72 items-center justify-center bg-darkbg/60 text-sm text-subtext backdrop-blur-[1px]">
                {language.devToolTokens.loading}
            </div>
        {/if}
        {#if error}
            <div class="rounded-md border border-danger/50 bg-danger/10 p-3 text-sm text-danger">{error}</div>
        {:else if displayedMode === 'json' && requestJson !== null}
            <pre class="max-w-full overflow-auto whitespace-pre-wrap rounded-xl border border-darkborderc bg-lightbg p-3 text-sm text-maintext"><code>{requestJson}</code></pre>
        {:else if displayedMode === 'chatml' && chatml !== null}
            <pre class="max-w-full overflow-auto whitespace-pre-wrap rounded-xl border border-darkborderc bg-lightbg p-3 text-sm text-maintext"><code>{chatml}</code></pre>
        {:else if displayedMode === 'chat' && messages !== null}
            <div class="grid gap-3">
                {#each messages as message, index (index)}
                    <article class="rounded-xl border border-darkborderc bg-lightbg p-3">
                        <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-subtext">
                            <span class="rounded-md bg-darkbg px-2 py-1 font-medium uppercase">{message.role}</span>
                            {#if message.multimodals?.length}
                                <span>{message.multimodals.length} non-text</span>
                            {/if}
                            {#if message.thoughts?.length}
                                <span>{message.thoughts.length} thought</span>
                            {/if}
                        </div>
                        <pre class="max-w-full overflow-auto whitespace-pre-wrap text-sm text-maintext"><code>{message.content}</code></pre>
                    </article>
                    {#if message.cachePoint}
                        <div class="rounded-xl border border-dashed border-darkborderc bg-darkbg/40 px-3 py-2 text-xs font-medium text-subtext">
                            {language.cachePoint}
                        </div>
                    {/if}
                {/each}
            </div>
        {:else}
            <div class="flex min-h-72 items-center justify-center text-sm text-subtext">
                {language.devToolPreview.request}
            </div>
        {/if}
    </div>
</ShDialog>
