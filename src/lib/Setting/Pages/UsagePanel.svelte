<script lang="ts">
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte'
    import ShSelect from 'src/lib/UI/GUI/ShSelect.svelte'
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
    import Help from 'src/lib/Others/Help.svelte'
    import { Tooltip } from 'bits-ui'
    import { Trash2Icon, ChartNoAxesColumnIcon, SearchIcon } from '@lucide/svelte'
    import { alertConfirm, alertMd, notifyError } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { getSyncClientId } from 'src/ts/storage/nodeStorage'
    import { language, getCurrentLocale } from 'src/lang'
    import { DBState } from 'src/ts/stores.svelte'
    import { getModelsDevCatalog } from 'src/ts/preset/registry/remote'
    import { estimateModelsDevUsageCost } from 'src/ts/model/usagePricing'

    type UsagePeriod = 'day' | 'week' | 'month' | 'custom'

    const LIST_LIMIT = 100

    interface UsageEntry {
        jobId: string
        timestamp: number
        chatId?: string
        provider?: string
        model?: string
        promptTokens?: number
        completionTokens?: number
        totalTokens?: number
        cachedTokens?: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
        reasoningTokens?: number
        serviceTier?: string
        gatewayCost?: number
        estimatedCostUsd?: number
    }

    interface UsageTotals {
        requests: number
        promptTokens: number
        completionTokens: number
        totalTokens: number
        cachedTokens: number
        cacheReadTokens: number
        cacheCreationTokens: number
        reasoningTokens: number
    }

    interface UsageBucket {
        key: string
        label: string
        title: string
        promptTokens: number
        completionTokens: number
        cachedTokens: number
        reasoningTokens: number
        estimatedCostUsd: number
    }

    const emptyTotals = (): UsageTotals => ({
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
    })

    let entries = $state<UsageEntry[]>([])
    let loading = $state(false)
    let loadError = $state<string | null>(null)
    let entrySearch = $state('')
    let period = $state<UsagePeriod>('week')
    let filtersOpen = $state(false)

    function showCumulativeActivity() {
        let mdTable = "| Type | Value |\n| --- | --- |\n"
        const statistics = DBState.db.statics
        for (const key in statistics) {
            mdTable += `| ${key} | ${statistics[key]} |\n`
        }
        mdTable += `\n\n<small>${language.staticsDisclaimer}</small>`
        alertMd(mdTable, { closeOnly: true })
    }

    function toDateTimeInput(timestamp: number): string {
        const date = new Date(timestamp)
        const local = new Date(timestamp - date.getTimezoneOffset() * 60_000)
        return local.toISOString().slice(0, 16)
    }

    function startOfLocalDay(timestamp: number): number {
        const date = new Date(timestamp)
        date.setHours(0, 0, 0, 0)
        return date.getTime()
    }

    function localDaysAgo(timestamp: number, days: number): number {
        const date = new Date(startOfLocalDay(timestamp))
        date.setDate(date.getDate() - days)
        return date.getTime()
    }

    function localDayOrdinal(timestamp: number): number {
        const date = new Date(timestamp)
        return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
    }

    const initialEnd = Date.now() + 60_000
    let rangeStart = $state(toDateTimeInput(localDaysAgo(initialEnd, 6)))
    let rangeEnd = $state(toDateTimeInput(initialEnd))

    function setPeriod(next: Exclude<UsagePeriod, 'custom'>) {
        const end = Date.now() + 60_000
        const start = next === 'day'
            ? end - 86_400_000
            : localDaysAgo(end, next === 'week' ? 6 : 29)
        period = next
        rangeStart = toDateTimeInput(start)
        rangeEnd = toDateTimeInput(end)
    }

    const range = $derived.by(() => {
        const start = new Date(rangeStart).getTime()
        const end = new Date(rangeEnd).getTime()
        return {
            start: Number.isFinite(start) ? start : 0,
            end: Number.isFinite(end) ? end : 0,
        }
    })

    const rangeEntries = $derived.by(() => {
        if (range.end < range.start) return []
        return entries.filter(entry => entry.timestamp >= range.start && entry.timestamp <= range.end)
    })

    const filteredEntries = $derived.by(() => {
        const needle = entrySearch.trim().toLowerCase()
        if (!needle) return rangeEntries
        return rangeEntries.filter(entry => [
            entry.provider,
            entry.model,
            entry.jobId,
        ].join(' ').toLowerCase().includes(needle))
    })
    const displayedEntries = $derived(filteredEntries.slice(0, LIST_LIMIT))

    const totals = $derived.by(() => {
        const result = emptyTotals()
        for (const entry of rangeEntries) {
            result.requests += 1
            result.promptTokens += entry.promptTokens ?? 0
            result.completionTokens += entry.completionTokens ?? 0
            result.totalTokens += entry.totalTokens ?? (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0)
            result.cachedTokens += entry.cachedTokens ?? 0
            result.cacheReadTokens += entry.cacheReadTokens ?? 0
            result.cacheCreationTokens += entry.cacheCreationTokens ?? 0
            result.reasoningTokens += entry.reasoningTokens ?? 0
        }
        return result
    })

    const chartBuckets = $derived.by(() => {
        const locale = getCurrentLocale()
        const duration = Math.max(0, range.end - range.start)
        const hourly = duration <= 2 * 86_400_000
        const unitMs = hourly ? 3_600_000 : 86_400_000
        const bucketStart = hourly
            ? Math.floor(range.start / unitMs) * unitMs
            : startOfLocalDay(range.start)
        const count = hourly
            ? Math.max(1, Math.ceil((range.end - bucketStart) / unitMs))
            : Math.max(1, localDayOrdinal(range.end) - localDayOrdinal(bucketStart) + 1)
        const buckets: UsageBucket[] = []

        for (let index = 0; index < count; index++) {
            const date = new Date(bucketStart)
            if (hourly) date.setTime(bucketStart + index * unitMs)
            else date.setDate(date.getDate() + index)
            const showLabel = hourly
                ? index % 3 === 0
                : count <= 7 || index === 0 || (index + 1) % 5 === 0
            buckets.push({
                key: String(date.getTime()),
                label: showLabel
                    ? hourly
                        ? `${String(date.getHours()).padStart(2, '0')}:00`
                        : `${date.getMonth() + 1}/${date.getDate()}`
                    : '',
                title: hourly
                    ? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric' })
                    : date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }),
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                reasoningTokens: 0,
                estimatedCostUsd: 0,
            })
        }

        for (const entry of rangeEntries) {
            const index = hourly
                ? Math.floor((entry.timestamp - bucketStart) / unitMs)
                : localDayOrdinal(entry.timestamp) - localDayOrdinal(bucketStart)
            if (index < 0 || index >= buckets.length) continue
            buckets[index].promptTokens += entry.promptTokens ?? 0
            buckets[index].completionTokens += entry.completionTokens ?? 0
            buckets[index].cachedTokens += (entry.cachedTokens ?? 0) + (entry.cacheReadTokens ?? 0)
            buckets[index].reasoningTokens += entry.reasoningTokens ?? 0
            buckets[index].estimatedCostUsd += entry.estimatedCostUsd ?? 0
        }
        return buckets
    })

    const chartTokenMax = $derived(Math.max(0, ...chartBuckets.map(bucket =>
        bucket.promptTokens + bucket.completionTokens
    )))
    const chartMax = $derived(Math.max(
        chartTokenMax,
        ...chartBuckets.map(bucket => bucket.estimatedCostUsd * 100_000),
    ))
    const chartCostPoints = $derived(chartBuckets.map((bucket, index) => {
        const x = chartBuckets.length > 0 ? (index + 0.5) / chartBuckets.length * 100 : 0
        const y = chartMax > 0 ? 100 - bucket.estimatedCostUsd * 100_000 / chartMax * 100 : 100
        return { x, y }
    }))
    const chartCostPolyline = $derived(chartCostPoints.map(point => `${point.x},${point.y}`).join(' '))
    const chartScrollable = $derived(chartBuckets.length > 30)

    function number(value?: number): string {
        return (value ?? 0).toLocaleString(getCurrentLocale())
    }

    function formatTime(timestamp: number): string {
        return new Date(timestamp).toLocaleString(getCurrentLocale())
    }

    function formatCost(value?: number): string {
        if (value === undefined || value === null) return ''
        const roundedUp = Math.ceil(value * 100_000) / 100_000
        return `$${roundedUp.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}`
    }

    async function loadUsage() {
        loading = true
        loadError = null
        try {
            const auth = await forageStorage.createAuth()
            const response = await fetch(`/api/usage?ts=${Date.now()}`, {
                headers: { 'risu-auth': auth },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            const catalog = await getModelsDevCatalog()
            entries = (json.content ?? []).map((entry: UsageEntry) => ({
                ...entry,
                estimatedCostUsd: estimateModelsDevUsageCost(catalog, entry),
            }))
        } catch (error) {
            loadError = error instanceof Error ? error.message : String(error)
        } finally {
            loading = false
        }
    }

    async function clearUsage() {
        if (!await alertConfirm(language.usageClearConfirm)) return
        try {
            const auth = await forageStorage.createAuth()
            const response = await fetch('/api/usage', {
                method: 'DELETE',
                headers: {
                    'risu-auth': auth,
                    'x-sync-client-id': getSyncClientId(),
                },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            entries = []
        } catch (error) {
            notifyError(error)
        }
    }

    async function deleteEntry(entry: UsageEntry) {
        if (!await alertConfirm(language.usageDeleteConfirm)) return
        try {
            const auth = await forageStorage.createAuth()
            const response = await fetch(`/api/usage/${encodeURIComponent(entry.jobId)}`, {
                method: 'DELETE',
                headers: {
                    'risu-auth': auth,
                    'x-sync-client-id': getSyncClientId(),
                },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            entries = entries.filter(item => item.jobId !== entry.jobId)
        } catch (error) {
            notifyError(error)
        }
    }

    $effect(() => {
        loadUsage()
    })
</script>

<div class="flex flex-col gap-4">
    <p class="text-textcolor2 text-sm m-0">{language.usageDesc}</p>

    <SettingLayout variant="filter" title={language.systemLogsFilters} bind:open={filtersOpen}>
        {#snippet control()}
            <ShButton variant="outline" size="sm" onclick={showCumulativeActivity}>
                {language.cumulativeActivity}
            </ShButton>
        {/snippet}
        <div class="grid grid-cols-4 items-end gap-2 min-w-[40rem] overflow-x-auto pb-1">
            <div class="flex flex-col gap-1 text-xs text-textcolor2 min-w-0">
                <span>{language.usageDateFilter}</span>
                <ShSelect bind:value={period} size="sm" onchange={(e) => {
                    const next = e.currentTarget.value as UsagePeriod
                    if (next !== 'custom') setPeriod(next)
                }}>
                    <OptionInput value="day">{language.usagePeriodDay}</OptionInput>
                    <OptionInput value="week">{language.usagePeriodWeek}</OptionInput>
                    <OptionInput value="month">{language.usagePeriodMonth}</OptionInput>
                    <OptionInput value="custom">{language.usagePeriodCustom}</OptionInput>
                </ShSelect>
            </div>
            <div class="col-span-3 grid grid-cols-2 gap-2 min-w-0">
                <div class="flex flex-col gap-1 text-xs text-textcolor2 min-w-0">
                    <span>{language.usageStartDate}</span>
                    <ShInput className="h-8 min-h-8 text-sm" type="datetime-local" bind:value={rangeStart} oninput={() => period = 'custom'} />
                </div>
                <div class="flex flex-col gap-1 text-xs text-textcolor2 min-w-0">
                    <span>{language.usageEndDate}</span>
                    <ShInput className="h-8 min-h-8 text-sm" type="datetime-local" bind:value={rangeEnd} oninput={() => period = 'custom'} />
                </div>
            </div>
        </div>
    </SettingLayout>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div class="rounded-md border border-darkborderc bg-darkbg/30 p-3">
            <div class="text-xs text-textcolor2">{language.usageRequests}</div>
            <div class="text-xl text-textcolor font-semibold tabular-nums">{number(totals.requests)}</div>
        </div>
        <div class="rounded-md border border-darkborderc bg-darkbg/30 p-3">
            <div class="text-xs text-textcolor2">{language.usageInputTokens}</div>
            <div class="text-xl text-textcolor font-semibold tabular-nums">{number(totals.promptTokens)}</div>
        </div>
        <div class="rounded-md border border-darkborderc bg-darkbg/30 p-3">
            <div class="text-xs text-textcolor2">{language.usageOutputTokens}</div>
            <div class="text-xl text-textcolor font-semibold tabular-nums">{number(totals.completionTokens)}</div>
        </div>
        <div class="rounded-md border border-darkborderc bg-darkbg/30 p-3">
            <div class="text-xs text-textcolor2">{language.usageCachedTokens}</div>
            <div class="text-xl text-textcolor font-semibold tabular-nums">{number(totals.cachedTokens + totals.cacheReadTokens)}</div>
        </div>
    </div>

    {#if loading}
        <div class="text-textcolor2 text-sm">{language.systemLogsLoading}</div>
    {:else if loadError}
        <div class="text-draculared text-sm">{language.systemLogsFailedLoad}: {loadError}</div>
    {:else}
        <Tooltip.Provider delayDuration={200}>
        <div class="border border-darkborderc rounded-md bg-darkbg/30 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div class="text-sm font-medium text-textcolor">{language.usageChartTitle}</div>
                <div class="flex flex-wrap items-center gap-3 text-xs text-textcolor2">
                    <span><span class="inline-block size-2 rounded-sm bg-violet-500 mr-1"></span>{language.usageInputTokens}</span>
                    <span><span class="inline-block size-2 rounded-sm bg-indigo-500 mr-1"></span>{language.usageCachedTokens}</span>
                    <span><span class="inline-block size-2 rounded-sm bg-yellow-500 mr-1"></span>{language.usageOutputTokens}</span>
                    <span><span class="inline-block size-2 rounded-sm bg-orange-400 mr-1"></span>{language.usageReasoningTokens}</span>
                    <span><span class="inline-block size-2 rounded-full bg-rose-500 mr-1"></span>{language.usageEstimatedCost}</span>
                </div>
            </div>
            <div class={chartScrollable ? 'overflow-x-auto' : 'overflow-x-hidden'}>
                <div
                    class="h-44 box-border px-4"
                    style:min-width={chartScrollable ? `${chartBuckets.length * 24}px` : '100%'}
                >
                    <div class="relative h-40">
                        <svg
                            class="absolute inset-0 z-10 size-full pointer-events-none overflow-visible"
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            aria-hidden="true"
                        >
                            <polyline
                                points={chartCostPolyline}
                                fill="none"
                                class="stroke-rose-500"
                                stroke-width="1"
                                vector-effect="non-scaling-stroke"
                            />
                        </svg>
                        {#each chartCostPoints as point}
                            <span
                                class="absolute z-10 size-1.5 rounded-full bg-rose-500 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                                style:left={`${point.x}%`}
                                style:top={`${point.y}%`}
                            ></span>
                        {/each}
                        <div class="absolute inset-0 flex items-end">
                            {#each chartBuckets as bucket (bucket.key)}
                                {@const effectiveCachedTokens = Math.min(bucket.cachedTokens, bucket.promptTokens)}
                                {@const uncachedPromptTokens = Math.max(0, bucket.promptTokens - effectiveCachedTokens)}
                                {@const effectiveReasoningTokens = Math.min(bucket.reasoningTokens, bucket.completionTokens)}
                                {@const visibleCompletionTokens = Math.max(0, bucket.completionTokens - effectiveReasoningTokens)}
                                {@const bucketTotal = bucket.promptTokens + bucket.completionTokens}
                                <div class="h-full flex-1 min-w-0 flex items-end justify-center">
                                    <Tooltip.Root>
                                    <Tooltip.Trigger>
                                        {#snippet child({ props })}
                                            <div
                                                {...props}
                                                class="w-full h-full flex items-end justify-center cursor-help"
                                            >
                                                <div
                                                    class="w-full max-w-4 flex flex-col rounded-t-sm overflow-hidden"
                                                    style:height={chartMax > 0 && bucketTotal > 0
                                                        ? `${Math.max(3, bucketTotal / chartMax * 100)}%`
                                                        : '0%'}
                                                >
                                                    <div
                                                        class="w-full bg-yellow-500"
                                                        style:height={bucketTotal > 0 ? `${visibleCompletionTokens / bucketTotal * 100}%` : '0%'}
                                                    ></div>
                                                    <div
                                                        class="w-full bg-orange-400"
                                                        style:height={bucketTotal > 0 ? `${effectiveReasoningTokens / bucketTotal * 100}%` : '0%'}
                                                    ></div>
                                                    <div
                                                        class="w-full bg-violet-500"
                                                        style:height={bucketTotal > 0 ? `${uncachedPromptTokens / bucketTotal * 100}%` : '0%'}
                                                    ></div>
                                                    <div
                                                        class="w-full bg-indigo-500"
                                                        style:height={bucketTotal > 0 ? `${effectiveCachedTokens / bucketTotal * 100}%` : '0%'}
                                                    ></div>
                                                </div>
                                            </div>
                                        {/snippet}
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                        <Tooltip.Content
                                            class="break-keep bg-darkbg border border-darkborderc rounded-md px-3 py-2 text-xs text-textcolor shadow-lg z-50 leading-relaxed tabular-nums"
                                            sideOffset={4}
                                            collisionPadding={8}
                                        >
                                            <div class="font-medium">{bucket.title}</div>
                                            <div>{language.usageInputTokens}: {number(bucket.promptTokens)} <span class="text-textcolor2">({number(effectiveCachedTokens)})</span></div>
                                            <div>{language.usageOutputTokens}: {number(bucket.completionTokens)} <span class="text-textcolor2">({number(effectiveReasoningTokens)})</span></div>
                                            <div>{language.usageEstimatedCost}: {formatCost(bucket.estimatedCostUsd)}</div>
                                        </Tooltip.Content>
                                    </Tooltip.Portal>
                                    </Tooltip.Root>
                                </div>
                            {/each}
                        </div>
                    </div>
                    <div class="h-4 flex">
                        {#each chartBuckets as bucket (bucket.key)}
                            <div class="flex-1 min-w-0 text-[10px] leading-4 text-center whitespace-nowrap text-textcolor2 tabular-nums">{bucket.label}</div>
                        {/each}
                    </div>
                </div>
            </div>
        </div>
        </Tooltip.Provider>

        <SettingLayout variant="panel" className="!mb-0">
            <div class="flex items-center gap-2 mb-3">
                <div class="flex items-center gap-1 text-textcolor font-medium">
                    <SearchIcon size={16} />
                    <span>{language.usageEntries}</span>
                    <Help key="usageEntryTokens" />
                </div>
            </div>

            <SettingLayout variant="search">
                <ShInput bind:value={entrySearch} placeholder={language.usageSearchPlaceholder} />
                {#snippet control()}
                    <ShButton variant="destructive" size="default" onclick={clearUsage} disabled={entries.length === 0}>
                        <Trash2Icon />
                        {language.systemLogsClearAll}
                    </ShButton>
                {/snippet}
            </SettingLayout>

            <SettingLayout variant="status" shownCount={displayedEntries.length} totalCount={filteredEntries.length} className="mt-3" />

            {#if displayedEntries.length === 0}
                <div class="flex flex-col items-center justify-center text-center py-12 bg-darkbg/30">
                    <ChartNoAxesColumnIcon size={40} class="text-textcolor2 mb-3 opacity-50" />
                    <div class="text-textcolor font-medium">{language.usageEmpty}</div>
                </div>
            {:else}
                <SettingLayout variant="list" scrollable>
                    {#each displayedEntries as entry (entry.jobId)}
                        <SettingLayout variant="item" className="gap-2">
                            <div class="flex flex-1 min-w-0 flex-col gap-1">
                                <div class="flex items-center gap-2 min-w-0">
                                    <span class="text-xs text-textcolor2 tabular-nums shrink-0">{formatTime(entry.timestamp)}</span>
                                    <span class="text-sm text-textcolor font-medium truncate">{entry.model ?? entry.provider ?? language.usageUnknownModel}</span>
                                    {#if entry.provider && entry.model}
                                        <span class="text-xs text-textcolor2 hidden sm:inline">{entry.provider}</span>
                                    {/if}
                                </div>
                                <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-textcolor2 tabular-nums">
                                    <span>
                                        {language.usageInputTokens}:
                                        <span class="text-textcolor">{number(entry.promptTokens)}</span>
                                        (<span class="text-textcolor2/70">{number((entry.cachedTokens ?? 0) + (entry.cacheReadTokens ?? 0))}{#if entry.cacheCreationTokens}|{number(entry.cacheCreationTokens)}{/if}</span>)
                                    </span>
                                    <span>
                                        {language.usageOutputTokens}:
                                        <span class="text-textcolor">{number(entry.completionTokens)}</span>
                                        (<span class="text-textcolor2/70">{number(entry.reasoningTokens)}</span>)
                                    </span>
                                </div>
                            </div>
                            {#if entry.estimatedCostUsd !== undefined && entry.estimatedCostUsd !== null}
                                <span class="shrink-0 whitespace-nowrap text-xs text-textcolor2 tabular-nums">
                                    {language.usageEstimatedCost}: <span class="text-textcolor">{formatCost(entry.estimatedCostUsd)}</span>
                                </span>
                            {/if}
                            {#snippet control()}<button
                                class="shrink-0 p-1 text-textcolor2 risu-interactive-danger transition-colors cursor-pointer"
                                onclick={() => deleteEntry(entry)}
                                aria-label={language.remove}
                            >
                                <Trash2Icon size={18} />
                            </button>{/snippet}
                        </SettingLayout>
                    {/each}
                </SettingLayout>
            {/if}
        </SettingLayout>
    {/if}
</div>
