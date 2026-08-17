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
        getServerFetchLogById,
        getServerFetchLogs,
        type FetchLog,
        type FetchLogSummary,
    } from 'src/ts/globalApi.svelte'
    import { language } from 'src/lang'
    import { formatResponseBody } from 'src/ts/requestLogFormat'
    import RequestLogDetail from 'src/lib/UI/RequestLogDetail.svelte'

    const LIST_LIMIT = 100

    let requestExpanded = $state<Record<string, boolean>>({})
    let serverRequestLogs = $state<FetchLogSummary[]>([])
    let requestLogsTotal = $state(0)
    let requestLogDetails = $state<Record<string, FetchLog>>({})
    let requestDetailLoading = $state<Record<string, boolean>>({})
    let requestDetailErrors = $state<Record<string, string>>({})
    let requestLogsLoading = $state(false)
    let requestLogsLoadingMore = $state(false)
    let requestLogsHasMore = $state(false)
    let requestLogsError = $state<string | null>(null)
    let requestSearch = $state('')
    const requestLogs = $derived(serverRequestLogs)
    const filteredRequestLogs = $derived.by(() => {
        const needle = requestSearch.trim().toLowerCase()
        if (!needle) return requestLogs
        return requestLogs.filter(log => [
            log.url,
            log.status,
            log.success,
            log.clientId,
            log.platform,
            log.chatId,
            log.responseType,
            log.date,
        ].join(' ').toLowerCase().includes(needle))
    })
    const displayedRequestLogs = $derived(filteredRequestLogs)

    function formatAbsolute(ts: number): string {
        const d = new Date(ts)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
            const page = await getServerFetchLogs({ limit: LIST_LIMIT })
            serverRequestLogs = page.content
            requestLogsTotal = page.total
            requestLogsHasMore = page.content.length > 0 && page.content.length < page.total
            requestExpanded = {}
            requestLogDetails = {}
            requestDetailLoading = {}
            requestDetailErrors = {}
        } catch (err) {
            requestLogsError = err instanceof Error ? err.message : String(err)
        } finally {
            requestLogsLoading = false
        }
    }

    async function loadMoreServerRequestLogs() {
        if (requestLogsLoadingMore || !requestLogsHasMore || serverRequestLogs.length === 0) return
        requestLogsLoadingMore = true
        requestLogsError = null
        try {
            const page = await getServerFetchLogs({
                limit: LIST_LIMIT,
                beforeId: serverRequestLogs[serverRequestLogs.length - 1].id,
            })
            const existing = new Set(serverRequestLogs.map(log => log.id))
            const fresh = page.content.filter(log => !existing.has(log.id))
            serverRequestLogs = [...serverRequestLogs, ...fresh]
            requestLogsTotal = page.total
            requestLogsHasMore = fresh.length > 0 && serverRequestLogs.length < page.total
        } catch (err) {
            requestLogsError = err instanceof Error ? err.message : String(err)
        } finally {
            requestLogsLoadingMore = false
        }
    }

    async function loadRequestLogDetails(id: string) {
        if (requestLogDetails[id] || requestDetailLoading[id]) return
        requestDetailLoading = { ...requestDetailLoading, [id]: true }
        const { [id]: _, ...remainingErrors } = requestDetailErrors
        requestDetailErrors = remainingErrors
        try {
            const detail = await getServerFetchLogById(id)
            requestLogDetails = { ...requestLogDetails, [id]: detail }
        } catch (err) {
            requestDetailErrors = {
                ...requestDetailErrors,
                [id]: err instanceof Error ? err.message : String(err),
            }
        } finally {
            const { [id]: _, ...remainingLoading } = requestDetailLoading
            requestDetailLoading = remainingLoading
        }
    }

    function handleRequestLogOpen(id: string, open: boolean) {
        requestExpanded = { ...requestExpanded, [id]: open }
        if (open) void loadRequestLogDetails(id)
    }

    async function handleClearRequestLogs() {
        const ok = await alertConfirm(language.requestLogsClearConfirm)
        if (!ok) return
        try {
            clearFetchLogs()
            await clearServerFetchLogs()
            serverRequestLogs = []
            requestLogsTotal = 0
            requestLogsHasMore = false
            requestExpanded = {}
            requestLogDetails = {}
            requestDetailLoading = {}
            requestDetailErrors = {}
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

    async function deleteRequestLog(log: FetchLogSummary) {
        const ok = await alertConfirm(language.systemLogsDeleteConfirm)
        if (!ok) return
        try {
            await deleteServerFetchLog(log.id)
            deleteFetchLog(log.id)
            serverRequestLogs = serverRequestLogs.filter(entry => entry.id !== log.id)
            requestLogsTotal = Math.max(0, requestLogsTotal - 1)
            requestLogsHasMore = serverRequestLogs.length < requestLogsTotal
            const { [log.id]: _, ...rest } = requestExpanded
            requestExpanded = rest
            const { [log.id]: _detail, ...remainingDetails } = requestLogDetails
            requestLogDetails = remainingDetails
            const { [log.id]: _loading, ...remainingLoading } = requestDetailLoading
            requestDetailLoading = remainingLoading
            const { [log.id]: _error, ...remainingErrors } = requestDetailErrors
            requestDetailErrors = remainingErrors
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

<SettingLayout variant="status" shownCount={displayedRequestLogs.length} totalCount={requestLogsTotal}
    loading={requestLogsLoading} error={requestLogsError ? `${language.systemLogsFailedLoad}: ${requestLogsError}` : null} />

{#if displayedRequestLogs.length === 0}
    <div class="flex flex-col items-center justify-center text-center py-16 border border-darkborderc rounded-md bg-darkbg/30">
        <ScrollTextIcon size={48} class="text-textcolor2 mb-3 opacity-50" />
        <div class="text-textcolor font-medium mb-1">{language.noRequestLogs}</div>
        <div class="text-textcolor2 text-sm">{language.requestLogsEmptyDesc}</div>
    </div>
{:else}
    <Tooltip.Provider delayDuration={300}>
        <SettingLayout variant="list" scrollable className="max-h-[75vh]">
            {#each displayedRequestLogs as log (log.id)}
                <Collapsible.Root
                    open={requestExpanded[log.id] === true}
                    onOpenChange={(v) => handleRequestLogOpen(log.id, v)}
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
                        {@const detail = requestLogDetails[log.id]}
                        {#if requestDetailLoading[log.id]}
                            <div class="p-4 text-sm text-textcolor2">{language.systemLogsLoading}</div>
                        {:else if requestDetailErrors[log.id]}
                            <div class="p-4 text-sm text-draculared">
                                {language.systemLogsFailedLoad}: {requestDetailErrors[log.id]}
                            </div>
                        {:else if detail}
                        <div class="p-3 text-xs text-textcolor2 space-y-4">
                            <RequestLogDetail log={detail} />
                            <div class="pt-1 flex gap-2">
                                <ShButton variant="outline" size="sm" onclick={() => copyRequestLog(detail)}>
                                    <CopyIcon />
                                    <span>{language.systemLogsCopyEntry}</span>
                                </ShButton>
                                <ShButton variant="destructive" size="sm" onclick={() => deleteRequestLog(log)}>
                                    <Trash2Icon />
                                    <span>{language.systemLogsDeleteEntry}</span>
                                </ShButton>
                            </div>
                        </div>
                        {/if}
                    </Collapsible.Content>
                </Collapsible.Root>
            {/each}
        </SettingLayout>
    </Tooltip.Provider>
{/if}

{#if requestLogsHasMore}
    <div class="flex justify-center mt-3">
        <ShButton variant="outline" size="default" disabled={requestLogsLoadingMore} onclick={loadMoreServerRequestLogs}>
            {requestLogsLoadingMore ? language.systemLogsLoading : language.systemLogsLoadMore}
        </ShButton>
    </div>
{/if}
