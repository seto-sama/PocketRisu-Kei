<script lang="ts">
    import {
        ActivityIcon,
        BracesIcon,
        Clock3Icon,
        FileTextIcon,
        GaugeIcon,
        InfoIcon,
        RefreshCwIcon,
        ScrollTextIcon,
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import RequestLogDetail from 'src/lib/UI/RequestLogDetail.svelte'
    import SettingTabs from 'src/lib/UI/GUI/SettingTabs.svelte'
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import type { AlertGenerationInfoStoreData } from 'src/ts/alert'
    import { aiLawApplies, getFetchData } from 'src/ts/globalApi.svelte'
    import { resolveRequestDiagnosticContext } from 'src/ts/requestDiagnostics'
    import { DBState, selectedCharID } from 'src/ts/stores.svelte'
    import type { FetchLog } from 'src/ts/requestLogStore'
    import { tokenize } from 'src/ts/tokenizer'

    let {
        open = $bindable(false),
        info,
        onOpenChange,
    }: {
        open?: boolean
        info: AlertGenerationInfoStoreData | null
        onOpenChange?: (open: boolean) => void
    } = $props()

    let selectedTab = $state(0)
    let requestLog = $state<FetchLog | null>(null)
    let requestLogLoading = $state(false)
    let requestLogError = $state<string | null>(null)
    let loadedRequestKey = $state('')
    let loadRevision = 0

    const tabs = $derived([
        { label: language.requestDiagnostics.overview, value: 0 },
        { label: language.requestDiagnostics.requestLog, value: 1 },
        { label: language.requestDiagnostics.prompt, value: 2 },
    ])

    const message = $derived.by(() => {
        if (!info || info.idx < 0) return undefined
        const character = DBState.db.characters?.[$selectedCharID]
        return character?.chats?.[character.chatPage]?.message?.[info.idx]
    })
    const diagnosticContext = $derived(resolveRequestDiagnosticContext(message, info?.genInfo))
    const generationInfo = $derived(diagnosticContext.generationInfo)
    const promptInfo = $derived(diagnosticContext.promptInfo)
    const requestKey = $derived(diagnosticContext.requestKey)
    const inputTokens = $derived(Math.max(0, generationInfo.inputTokens ?? 0))
    const maxContext = $derived(Math.max(0, generationInfo.maxContext ?? 0))
    const remainingTokens = $derived(Math.max(0, maxContext - inputTokens))
    const inputPercent = $derived(maxContext > 0 ? Math.min(100, inputTokens / maxContext * 100) : 0)
    const timingStages = $derived([
        generationInfo.stageTiming?.stage1 ?? 0,
        generationInfo.stageTiming?.stage2 ?? 0,
        generationInfo.stageTiming?.stage3 ?? 0,
        generationInfo.stageTiming?.stage4 ?? 0,
    ])
    const totalTiming = $derived(timingStages.reduce((sum, value) => sum + value, 0))
    const timingDetails = $derived([
        {
            label: language.requestDiagnostics.promptPreparation,
            duration: timingStages[0],
        },
        {
            label: language.requestDiagnostics.memoryProcessing,
            duration: timingStages[1],
        },
        {
            label: language.requestDiagnostics.responseGeneration,
            duration: timingStages[2],
        },
        {
            label: language.requestDiagnostics.finalization,
            duration: timingStages[3],
        },
    ])

    function formatBytes(value: string | undefined): string {
        const bytes = new TextEncoder().encode(value ?? '').byteLength
        return `${bytes.toLocaleString()} Byte`
    }

    function formatDuration(milliseconds: number): string {
        return `${(milliseconds / 1000).toFixed(1)}s`
    }

    function formatPromptContent(content: unknown): string {
        if (typeof content === 'string') return content
        try {
            return JSON.stringify(content, null, 2)
        } catch {
            return String(content ?? '')
        }
    }

    async function loadRequestLog(force = false) {
        if (!requestKey) {
            loadRevision += 1
            requestLog = null
            requestLogError = null
            requestLogLoading = false
            loadedRequestKey = ''
            return
        }
        if (!force && loadedRequestKey === requestKey) return

        const revision = ++loadRevision
        const key = requestKey
        requestLogLoading = true
        requestLogError = null
        requestLog = null
        try {
            const result = await getFetchData(key)
            if (revision !== loadRevision) return
            requestLog = result
            loadedRequestKey = key
        } catch (error) {
            if (revision !== loadRevision) return
            requestLogError = error instanceof Error ? error.message : String(error)
            loadedRequestKey = key
        } finally {
            if (revision === loadRevision) requestLogLoading = false
        }
    }

    $effect(() => {
        if (open && selectedTab === 1) void loadRequestLog()
    })

    $effect(() => {
        if (!open) {
            selectedTab = 0
            loadRevision += 1
            requestLog = null
            requestLogError = null
            requestLogLoading = false
            loadedRequestKey = ''
        }
    })
</script>

<ShDialog
    bind:open
    size="xl"
    tier="alert"
    closeOnEscape={true}
    closeOnOutsideClick={true}
    contentClass="overflow-hidden"
    bodyClass="min-h-0"
    {onOpenChange}
>
    {#snippet title()}
        {language.requestDiagnostics.title}
    {/snippet}

    <SettingTabs tabs={tabs} bind:selected={selectedTab} className="mb-3" />

    <div class="max-h-[65vh] min-h-80 overflow-y-auto pr-1">
        {#if selectedTab === 0}
            <div class="flex flex-col gap-4">
                <section>
                    <h2 class="mb-2 mt-0 flex items-center gap-2 text-sm font-semibold text-textcolor">
                        <InfoIcon size={16} />
                        {language.requestDiagnostics.metadata}
                    </h2>
                    <dl class="m-0 overflow-hidden rounded-md border border-darkborderc bg-bgcolor/30 py-0.5">
                        {#each [
                            [language.requestDiagnostics.messageIndex, String(info?.idx ?? '—')],
                            [language.requestDiagnostics.model, generationInfo.model ?? '—'],
                            [language.requestDiagnostics.requestId, requestKey || '—'],
                            [language.requestDiagnostics.size, formatBytes(message?.data)],
                            [language.requestDiagnostics.createdAt, diagnosticContext.time
                                ? new Date(diagnosticContext.time).toLocaleString()
                                : '—'],
                        ] as item}
                            <div class="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] items-start gap-4 px-3 py-1.5 text-sm">
                                <dt class="text-left text-textcolor2">{item[0]}</dt>
                                <dd class="m-0 break-all text-right font-mono text-textcolor">{item[1]}</dd>
                            </div>
                        {/each}
                        <div class="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] items-start gap-4 px-3 py-1.5 text-sm">
                            <dt class="text-left text-textcolor2">{language.requestDiagnostics.contentTokens}</dt>
                            <dd class="m-0 text-right font-mono text-textcolor">
                                {#if message}
                                    {#await tokenize(message.data)}…{:then count}{count.toLocaleString()}{:catch}—{/await}
                                {:else}—{/if}
                            </dd>
                        </div>
                    </dl>
                </section>

                <section>
                    <div class="mb-3 flex items-center justify-between gap-3">
                        <h2 class="m-0 flex items-center gap-2 text-sm font-semibold text-textcolor">
                            <GaugeIcon size={16} />
                            {language.requestDiagnostics.contextUsage}
                        </h2>
                        <span class="text-xs tabular-nums text-textcolor2">
                            {language.requestDiagnostics.responseLimit}: {generationInfo.outputTokens?.toLocaleString() ?? '?'}
                        </span>
                    </div>
                    <div class="flex h-3 overflow-hidden rounded-full bg-selected/40" aria-label={language.requestDiagnostics.contextUsage}>
                        <span class="bg-primary" style:width={`${inputPercent}%`}></span>
                    </div>
                    <div class="mt-4 grid gap-2 sm:grid-cols-3">
                        <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-3">
                            <div class="text-xs text-textcolor2">{language.maxContextSize}</div>
                            <div class="mt-1 text-xl font-semibold tabular-nums text-textcolor">{generationInfo.maxContext?.toLocaleString() ?? '?'}</div>
                        </div>
                        <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-3">
                            <div class="text-xs text-textcolor2">{language.inputTokens}</div>
                            <div class="mt-1 text-xl font-semibold tabular-nums text-textcolor">{generationInfo.inputTokens?.toLocaleString() ?? '?'}</div>
                        </div>
                        <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-3">
                            <div class="text-xs text-textcolor2">{language.requestDiagnostics.availableContext}</div>
                            <div class="mt-1 text-xl font-semibold tabular-nums text-textcolor">{maxContext ? remainingTokens.toLocaleString() : '?'}</div>
                        </div>
                    </div>
                </section>

                <ShAlert variant="info">
                    {#snippet icon()}<InfoIcon />{/snippet}
                    {language.tokenWarning}
                </ShAlert>

                {#if totalTiming > 0}
                    <section>
                        <div class="mb-3 flex items-center justify-between gap-3">
                            <h2 class="m-0 flex items-center gap-2 text-sm font-semibold text-textcolor"><Clock3Icon size={16} />{language.requestDiagnostics.timing}</h2>
                            <span class="text-xs tabular-nums text-textcolor2">{formatDuration(totalTiming)}</span>
                        </div>
                        <div class="grid gap-2 sm:grid-cols-4">
                            {#each timingDetails as stage}
                                <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-3 text-center">
                                    <div class="text-xs text-textcolor2">{stage.label}</div>
                                    <div class="mt-1 font-mono text-textcolor">{formatDuration(stage.duration)}</div>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            </div>
        {:else if selectedTab === 1}
            {#if requestLogLoading}
                <div class="flex min-h-64 items-center justify-center gap-2 text-sm text-textcolor2">
                    <RefreshCwIcon size={16} class="animate-spin" />
                    {language.systemLogsLoading}
                </div>
            {:else if requestLogError}
                <ShAlert variant="destructive">
                    {#snippet icon()}<ActivityIcon />{/snippet}
                    {#snippet title()}{language.requestDiagnostics.requestLogLoadFailed}{/snippet}
                    {#snippet action()}<ShButton variant="outline" size="sm" onclick={() => loadRequestLog(true)}><RefreshCwIcon />{language.requestDiagnostics.retry}</ShButton>{/snippet}
                    {requestLogError}
                </ShAlert>
            {:else if !requestKey}
                <div class="flex min-h-64 flex-col items-center justify-center rounded-md border border-dashed border-darkborderc bg-bgcolor/20 px-6 text-center">
                    <ScrollTextIcon size={40} class="mb-3 text-textcolor2 opacity-60" />
                    <div class="font-medium text-textcolor">{language.requestDiagnostics.unlinkedRequestLog}</div>
                    <div class="mt-1 max-w-md text-sm text-textcolor2">{language.requestDiagnostics.unlinkedRequestLogDesc}</div>
                </div>
            {:else if requestLog}
                <RequestLogDetail log={requestLog} />
            {:else}
                <div class="flex min-h-64 flex-col items-center justify-center rounded-md border border-dashed border-darkborderc bg-bgcolor/20 px-6 text-center">
                    <ScrollTextIcon size={40} class="mb-3 text-textcolor2 opacity-60" />
                    <div class="font-medium text-textcolor">{language.requestDiagnostics.noRequestLog}</div>
                    <div class="mt-1 max-w-md text-sm text-textcolor2">{language.requestDiagnostics.noRequestLogDesc}</div>
                </div>
            {/if}
        {:else if selectedTab === 2}
            {#if !promptInfo || Object.keys(promptInfo).length === 0}
                <div class="flex min-h-64 flex-col items-center justify-center rounded-md border border-dashed border-darkborderc bg-bgcolor/20 px-6 text-center">
                    <FileTextIcon size={40} class="mb-3 text-textcolor2 opacity-60" />
                    <div class="font-medium text-textcolor">{language.promptInfoEmptyMessage}</div>
                </div>
            {:else}
                <div class="flex flex-col gap-4">
                    <section class="rounded-md border border-darkborderc bg-bgcolor/30 p-4">
                        <div class="text-xs text-textcolor2">{language.requestDiagnostics.presetName}</div>
                        <div class="mt-1 font-medium text-textcolor">{promptInfo.promptName ?? '—'}</div>
                    </section>

                    <section>
                        <h2 class="mb-2 mt-0 flex items-center gap-2 text-sm font-semibold text-textcolor"><BracesIcon size={16} />{language.requestDiagnostics.customToggles}</h2>
                        {#if (promptInfo.promptToggles?.length ?? 0) === 0}
                            <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-4 text-sm text-textcolor2">{language.promptInfoEmptyToggle}</div>
                        {:else}
                            <div class="flex flex-wrap gap-2 rounded-md border border-darkborderc bg-bgcolor/30 p-3">
                                {#each promptInfo.promptToggles ?? [] as toggle}
                                    <ShBadge variant="secondary" size="md" className="gap-3">
                                        <span class="font-medium text-textcolor">{toggle.key}</span>
                                        <span>{toggle.value}</span>
                                    </ShBadge>
                                {/each}
                            </div>
                        {/if}
                    </section>

                    <section>
                        <h2 class="mb-2 mt-0 flex items-center gap-2 text-sm font-semibold text-textcolor"><FileTextIcon size={16} />{language.requestDiagnostics.promptMessages}</h2>
                        {#if (promptInfo.promptText?.length ?? 0) === 0}
                            <div class="rounded-md border border-darkborderc bg-bgcolor/30 p-4 text-sm text-textcolor2">{language.promptInfoEmptyText}</div>
                        {:else}
                            <div class="flex flex-col gap-2">
                                {#each promptInfo.promptText ?? [] as block, index}
                                    <article class="overflow-hidden rounded-md border border-darkborderc bg-bgcolor/30">
                                        <header class="border-b border-darkborderc/60 px-3 py-2 text-xs font-semibold uppercase text-textcolor2">{block.role} · {index + 1}</header>
                                        <pre class="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 text-sm text-textcolor">{formatPromptContent(block.content)}</pre>
                                    </article>
                                {/each}
                            </div>
                        {/if}
                    </section>
                </div>
            {/if}
        {/if}

        {#if aiLawApplies()}
            <div class="mt-4 text-sm italic text-textcolor2">{language.generatedByAIDisclaimer}</div>
        {/if}
    </div>
</ShDialog>
