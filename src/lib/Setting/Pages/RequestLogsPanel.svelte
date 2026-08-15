<script lang="ts">
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte'
    import { Collapsible, Tooltip } from 'bits-ui'
    import {
        CopyIcon,
        Trash2Icon,
        ChevronDownIcon,
        MonitorIcon,
        SmartphoneIcon,
        ScrollTextIcon,
    } from '@lucide/svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import {
        clearFetchLogs,
        clearServerFetchLogs,
        deleteFetchLog,
        deleteServerFetchLog,
        getServerFetchLogs,
        type FetchLog,
    } from 'src/ts/globalApi.svelte'
    import { language } from 'src/lang'
    import { formatRequestBody, formatResponseBody, getResponseBodyDetails } from 'src/ts/requestLogFormat'

    const LIST_LIMIT = 100

    let requestExpanded = $state<Record<string, boolean>>({})
    let serverRequestLogs = $state<FetchLog[]>([])
    let requestLogsLoading = $state(false)
    let requestLogsError = $state<string | null>(null)
    let requestSearch = $state('')
    const requestLogs = $derived(serverRequestLogs)
    const filteredRequestLogs = $derived.by(() => {
        const needle = requestSearch.trim().toLowerCase()
        if (!needle) return requestLogs
        return requestLogs.filter(log => [
            log.url,
            log.body,
            log.header,
            formatResponseBody(log),
            log.status,
            log.success,
            log.clientId,
            log.platform,
            log.chatId,
        ].join(' ').toLowerCase().includes(needle))
    })
    const displayedRequestLogs = $derived(filteredRequestLogs.slice(0, LIST_LIMIT))

    function formatAbsolute(ts: number): string {
        const d = new Date(ts)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    function parseRequestHeaders(header: string): Array<[string, string]> {
        try {
            const parsed = JSON.parse(header)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
            return Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
        } catch {
            return []
        }
    }

    function formatRequestLogTime(log: { timestamp?: number; date: string }): string {
        if (!log.timestamp) return log.date
        return formatAbsolute(log.timestamp)
    }

    function requestDeviceLabel(log: { platform?: string; clientId?: string }): string {
        return `${log.platform ?? 'Desktop'}${log.clientId ? ` #${log.clientId}` : ''}`
    }

    function requestDeviceKind(log: { platform?: string }): 'mobile' | 'desktop' {
        return (log.platform ?? '').toLowerCase().includes('mobile') ? 'mobile' : 'desktop'
    }

    async function loadServerRequestLogs() {
        requestLogsLoading = true
        requestLogsError = null
        try {
            serverRequestLogs = await getServerFetchLogs()
        } catch (err) {
            requestLogsError = err instanceof Error ? err.message : String(err)
        } finally {
            requestLogsLoading = false
        }
    }

    async function handleClearRequestLogs() {
        const ok = await alertConfirm(language.requestLogsClearConfirm)
        if (!ok) return
        try {
            clearFetchLogs()
            await clearServerFetchLogs()
            serverRequestLogs = []
            requestExpanded = {}
        } catch (err) {
            notifyError(language.systemLogsFailedLoad, {
                description: err instanceof Error ? err.message : String(err),
                source: 'request-logs-page',
            })
        }
    }

    function formatRequestLog(log: FetchLog): string {
        return [
            `${formatRequestLogTime(log)} — ${log.url}`,
            `success: ${log.success}${log.status !== undefined ? ` · status: ${log.status}` : ''}`,
            '',
            'Request Header',
            log.header,
            '',
            'Request Body',
            log.body,
            '',
            'Response Body',
            formatResponseBody(log),
        ].join('\n')
    }

    async function copyRequestLog(log: FetchLog) {
        try {
            await navigator.clipboard.writeText(formatRequestLog(log))
            notifySuccess(language.systemLogsCopied)
        } catch (err) {
            notifyError(String(err))
        }
    }

    async function deleteRequestLog(log: FetchLog) {
        const ok = await alertConfirm(language.systemLogsDeleteConfirm)
        if (!ok) return
        try {
            await deleteServerFetchLog(log.id)
            deleteFetchLog(log.id)
            serverRequestLogs = serverRequestLogs.filter(entry => entry.id !== log.id)
            const { [log.id]: _, ...rest } = requestExpanded
            requestExpanded = rest
        } catch (err) {
            await loadServerRequestLogs()
            notifyError(language.systemLogsFailedLoad, {
                description: err instanceof Error ? err.message : String(err),
                source: 'request-logs-page',
            })
        }
    }

    $effect(() => {
        loadServerRequestLogs()
    })
</script>

<div class="flex flex-col gap-3 mb-4">
    <p class="text-textcolor2 text-sm m-0">{language.requestLogsDesc}</p>
    <SettingLayout variant="search">
        <ShInput bind:value={requestSearch} placeholder={language.requestLogsSearchPlaceholder} />
        {#snippet control()}
        <ShButton variant="destructive" size="default" onclick={handleClearRequestLogs}>
            <Trash2Icon />
            <span class="hidden sm:inline">{language.systemLogsClearAll}</span>
        </ShButton>
        {/snippet}
    </SettingLayout>
</div>

<SettingLayout variant="status" shownCount={displayedRequestLogs.length} totalCount={filteredRequestLogs.length}
    loading={requestLogsLoading} error={requestLogsError ? `${language.systemLogsFailedLoad}: ${requestLogsError}` : null} />

{#if displayedRequestLogs.length === 0}
    <div class="flex flex-col items-center justify-center text-center py-16 border border-darkborderc rounded-md bg-darkbg/30">
        <ScrollTextIcon size={48} class="text-textcolor2 mb-3 opacity-50" />
        <div class="text-textcolor font-medium mb-1">{language.noRequestLogs}</div>
        <div class="text-textcolor2 text-sm">{language.requestLogsEmptyDesc}</div>
    </div>
{:else}
    <Tooltip.Provider delayDuration={300}>
        <SettingLayout variant="list" scrollable>
            {#each displayedRequestLogs as log (log.id)}
                <Collapsible.Root
                    open={requestExpanded[log.id] === true}
                    onOpenChange={(v) => { requestExpanded = { ...requestExpanded, [log.id]: v } }}
                >
                    <Collapsible.Trigger class="w-full text-left group">
                        <SettingLayout variant="item" className="gap-2 risu-interactive-surface group-focus-visible:bg-selected/30">
                        <span class="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium font-mono shrink-0 {log.success ? 'bg-success/20 text-success border-success/40' : 'bg-draculared/20 text-draculared border-draculared/40'}">
                            {log.status ?? (log.success ? 'OK' : 'ERR')}
                        </span>
                        <Tooltip.Root>
                            <Tooltip.Trigger>
                                {#snippet child({ props })}
                                    <span {...props} class="text-textcolor2 text-xs shrink-0 tabular-nums cursor-help">
                                        {log.date}
                                    </span>
                                {/snippet}
                            </Tooltip.Trigger>
                            <Tooltip.Content
                                class="bg-darkbg border border-darkborderc rounded-md px-2 py-1 text-xs text-textcolor shadow-lg z-50"
                                sideOffset={4}
                            >
                                {formatRequestLogTime(log)}
                            </Tooltip.Content>
                        </Tooltip.Root>
                        <span class="flex-1 min-w-0 truncate text-sm text-textcolor font-mono">{log.url}</span>
                        <ShBadge variant="default" className="shrink-0">
                            {#if requestDeviceKind(log) === 'mobile'}<SmartphoneIcon size={12} />
                            {:else}<MonitorIcon size={12} />{/if}
                            <span class="hidden md:inline text-[10px]">{requestDeviceLabel(log)}</span>
                        </ShBadge>
                        <ChevronDownIcon size={16} class="shrink-0 text-textcolor2 transition-transform group-data-[state=open]:rotate-180" />
                        </SettingLayout>
                    </Collapsible.Trigger>

                    <Collapsible.Content class="bg-darkbg/60">
                        {@const headers = parseRequestHeaders(log.header)}
                        {@const requestBody = formatRequestBody(log.body)}
                        {@const responseDetails = getResponseBodyDetails(log)}
                        <div class="p-3 text-xs text-textcolor2 space-y-4">
                            <div class="flex flex-wrap gap-x-4 gap-y-1">
                                <span><span class="text-textcolor2/70">timestamp:</span> {formatRequestLogTime(log)}</span>
                                <span><span class="text-textcolor2/70">device:</span> {requestDeviceLabel(log)}</span>
                                <span><span class="text-textcolor2/70">success:</span> {log.success ? 'true' : 'false'}</span>
                                {#if log.status !== undefined}<span><span class="text-textcolor2/70">status:</span> {log.status}</span>{/if}
                                {#if log.responseType}<span><span class="text-textcolor2/70">response-type:</span> {log.responseType}</span>{/if}
                                {#if log.chatId}<span><span class="text-textcolor2/70">chat:</span> {log.chatId}</span>{/if}
                            </div>
                            <div>
                                <div class="text-textcolor text-sm font-semibold mb-2">URL</div>
                                <div class="break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 text-textcolor font-mono">{log.url}</div>
                            </div>
                            <div>
                                <div class="text-textcolor text-sm font-semibold mb-2">Request Header</div>
                                {#if headers.length === 0}
                                    <div class="break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 text-textcolor font-mono">{log.header}</div>
                                {:else}
                                    <div class="bg-bgcolor/50 border border-darkborderc/50 rounded p-2 text-textcolor">
                                        <div class="flex flex-wrap gap-x-4 gap-y-1">
                                            {#each headers as [key, value]}
                                                <span class="break-all"><span class="text-textcolor2/70">{key}:</span> {value}</span>
                                            {/each}
                                        </div>
                                    </div>
                                {/if}
                            </div>
                            <div>
                                <div class="text-textcolor text-sm font-semibold mb-2">Request Body</div>
                                <pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 text-textcolor font-mono ">{requestBody}</pre>
                            </div>
                            <div>
                                <div class="text-textcolor text-sm font-semibold mb-2">Response Body</div>
                                {#if responseDetails}
                                    <div class="space-y-2">
                                        {#each responseDetails.groups as group (group.event)}
                                            <details class="bg-bgcolor/50 border border-darkborderc/50 rounded text-textcolor">
                                                <summary class="cursor-pointer select-none p-2 font-mono">
                                                    {group.summary}
                                                </summary>
                                                <pre class="whitespace-pre-wrap break-all border-t border-darkborderc/50 p-2 font-mono max-h-64 overflow-auto">{group.readable}</pre>
                                                <details class="border-t border-darkborderc/50">
                                                    <summary class="cursor-pointer select-none p-2 font-mono text-textcolor2">Raw</summary>
                                                    <pre class="whitespace-pre-wrap break-all border-t border-darkborderc/50 p-2 font-mono max-h-64 overflow-auto">{group.raw}</pre>
                                                </details>
                                            </details>
                                        {/each}
                                    </div>
                                    {#if responseDetails.remainder}
                                        <pre class="mt-2 whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 text-textcolor font-mono">{responseDetails.remainder}</pre>
                                        <details class="mt-2 bg-bgcolor/50 border border-darkborderc/50 rounded text-textcolor2">
                                            <summary class="cursor-pointer select-none p-2 font-mono">Raw remaining events</summary>
                                            <pre class="whitespace-pre-wrap break-all border-t border-darkborderc/50 p-2 font-mono max-h-64 overflow-auto">{responseDetails.rawRemainder}</pre>
                                        </details>
                                    {/if}
                                {:else}
                                    <pre class="whitespace-pre-wrap break-all bg-bgcolor/50 border border-darkborderc/50 rounded p-2 text-textcolor font-mono">{formatResponseBody(log)}</pre>
                                {/if}
                            </div>
                            <div class="pt-1 flex gap-2">
                                <ShButton variant="outline" size="sm" onclick={() => copyRequestLog(log)}>
                                    <CopyIcon />
                                    <span>{language.systemLogsCopyEntry}</span>
                                </ShButton>
                                <ShButton variant="destructive" size="sm" onclick={() => deleteRequestLog(log)}>
                                    <Trash2Icon />
                                    <span>{language.systemLogsDeleteEntry}</span>
                                </ShButton>
                            </div>
                        </div>
                    </Collapsible.Content>
                </Collapsible.Root>
            {/each}
        </SettingLayout>
    </Tooltip.Provider>
{/if}
