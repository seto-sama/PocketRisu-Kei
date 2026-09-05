<script lang="ts">
    import Button from '../../UI/components/Button.svelte'
    import Input from '../../UI/components/Input.svelte'
    import Tooltip from '../../UI/components/Tooltip.svelte'
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte'
    import { Collapsible } from 'bits-ui'
    import {
        CopyIcon,
        Trash2Icon,
        ChevronDownIcon,
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
    import { language, getCurrentLocale } from 'src/lang'
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
            log.provider,
            log.model,
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

    function number(value?: number): string {
        return value === undefined ? '—' : value.toLocaleString(getCurrentLocale())
    }

    function requestModel(log: FetchLogSummary): string {
        return log.model ?? log.provider ?? language.usageUnknownModel
    }

    function formatDuration(durationMs?: number | null): string {
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '—'
        if (durationMs < 1_000) return `${durationMs} ms`
        if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(2)} s`
        if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`
        const minutes = Math.floor(durationMs / 60_000)
        const seconds = Math.floor(durationMs % 60_000 / 1_000)
        return `${minutes}m ${seconds}s`
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
    <p class="text-subtext text-sm m-0">{language.requestLogsDesc}</p>
    <SettingLayout variant="search">
        <Input bind:value={requestSearch} placeholder={language.requestLogsSearchPlaceholder} />
        {#snippet control()}
        <Button variant="destructive" size="default" onclick={handleClearRequestLogs}>
            <Trash2Icon />
            <span class="hidden sm:inline">{language.systemLogsClearAll}</span>
        </Button>
        {/snippet}
    </SettingLayout>
</div>

<SettingLayout variant="status" shownCount={displayedRequestLogs.length} totalCount={requestLogsTotal}
    loading={requestLogsLoading} error={requestLogsError ? `${language.systemLogsFailedLoad}: ${requestLogsError}` : null} />

{#if displayedRequestLogs.length === 0}
    <div class="flex flex-col items-center justify-center text-center py-16 border border-darkborderc rounded-md bg-darkbg/30">
        <ScrollTextIcon size={48} class="text-subtext mb-3 opacity-50" />
        <div class="text-maintext font-medium mb-1">{language.noRequestLogs}</div>
        <div class="text-subtext text-sm">{language.requestLogsEmptyDesc}</div>
    </div>
{:else}
    <SettingLayout variant="list">
            {#each displayedRequestLogs as log (log.id)}
                <Collapsible.Root
                    open={requestExpanded[log.id] === true}
                    onOpenChange={(v) => handleRequestLogOpen(log.id, v)}
                >
                    <Collapsible.Trigger class="w-full text-left group">
                        <SettingLayout variant="item" className="risu-interactive-surface group-focus-visible:bg-selected/30">
                        <div class="grid w-full min-w-0 grid-cols-[2.75rem_5rem_minmax(0,1fr)_1rem] items-center gap-2 sm:grid-cols-[2.75rem_5rem_minmax(0,1fr)_4rem_7rem_1rem]">
                            <span class="inline-flex justify-self-start items-center rounded-md border px-1.5 py-0.5 text-xs font-medium font-mono {log.success ? 'bg-success/20 text-success border-success/40' : 'bg-danger/20 text-danger border-danger/40'}">
                                {log.status ?? (log.success ? 'OK' : 'ERR')}
                            </span>
                            <Tooltip className="max-w-none max-h-none overflow-visible break-normal px-2 py-1 leading-normal">
                                {#snippet trigger(props)}
                                    <span {...props} class="min-w-0 truncate whitespace-nowrap text-xs text-subtext tabular-nums cursor-help">
                                        {log.date}
                                    </span>
                                {/snippet}
                                {formatRequestLogTime(log)}
                            </Tooltip>
                            <span class="flex min-w-0 items-center gap-2">
                                <span class="min-w-0 truncate text-sm text-maintext font-medium">{requestModel(log)}</span>
                                {#if log.model && log.provider}
                                    <span class="shrink-0 hidden sm:inline text-xs text-subtext">{log.provider}</span>
                                {/if}
                            </span>
                            <span class="hidden whitespace-nowrap text-right text-xs text-subtext tabular-nums sm:block">
                                {formatDuration(log.responseDurationMs)}
                            </span>
                            <span
                                class="hidden grid-cols-2 gap-2 whitespace-nowrap text-right text-xs text-subtext tabular-nums sm:grid"
                                aria-label={`${language.usageInputTokens} ${number(log.promptTokens)}, ${language.usageOutputTokens} ${number(log.completionTokens)}`}
                            >
                                <span>{number(log.promptTokens)}</span>
                                <span>{number(log.completionTokens)}</span>
                            </span>
                            <ChevronDownIcon size={16} class="justify-self-end text-subtext transition-transform group-data-[state=open]:rotate-180" />
                        </div>
                        </SettingLayout>
                    </Collapsible.Trigger>

                    <Collapsible.Content class="bg-darkbg/60">
                        {@const detail = requestLogDetails[log.id]}
                        {#if requestDetailLoading[log.id]}
                            <div class="p-4 text-sm text-subtext">{language.systemLogsLoading}</div>
                        {:else if requestDetailErrors[log.id]}
                            <div class="p-4 text-sm text-danger">
                                {language.systemLogsFailedLoad}: {requestDetailErrors[log.id]}
                            </div>
                        {:else if detail}
                        <div class="p-3 text-xs text-subtext space-y-4">
                            <RequestLogDetail log={detail} />
                            <div class="pt-1 flex gap-2">
                                <Button variant="outline" size="sm" onclick={() => copyRequestLog(detail)}>
                                    <CopyIcon />
                                    <span>{language.systemLogsCopyEntry}</span>
                                </Button>
                                <Button variant="destructive" size="sm" onclick={() => deleteRequestLog(log)}>
                                    <Trash2Icon />
                                    <span>{language.systemLogsDeleteEntry}</span>
                                </Button>
                            </div>
                        </div>
                        {/if}
                    </Collapsible.Content>
                </Collapsible.Root>
            {/each}
    </SettingLayout>
{/if}

{#if requestLogsHasMore}
    <div class="flex justify-center mt-3">
        <Button variant="outline" size="sm" disabled={requestLogsLoadingMore} onclick={loadMoreServerRequestLogs}>
            {requestLogsLoadingMore ? language.systemLogsLoading : language.systemLogsLoadMore}
        </Button>
    </div>
{/if}
