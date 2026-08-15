<script lang="ts">
    import { language } from 'src/lang'
    import { formatRequestBody, formatResponseBody, getResponseBodyDetails } from 'src/ts/requestLogFormat'
    import type { FetchLog } from 'src/ts/requestLogStore'

    let {
        log,
        className = '',
    }: {
        log: FetchLog
        className?: string
    } = $props()

    const headers = $derived.by(() => {
        try {
            const parsed = JSON.parse(log.header)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
            return Object.entries(parsed).map(([key, value]) => [
                key,
                typeof value === 'string' ? value : JSON.stringify(value),
            ] as const)
        } catch {
            return []
        }
    })
    const requestBody = $derived(formatRequestBody(log.body))
    const responseDetails = $derived(getResponseBodyDetails(log))

</script>

<div class="flex flex-col gap-4 text-xs text-textcolor2 {className}">
    <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold text-textcolor">{language.requestDiagnostics.url}</h3>
        <div class="break-all rounded-md border border-darkborderc/60 bg-bgcolor/50 p-2 font-mono text-textcolor">{log.url}</div>
    </section>

    <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold text-textcolor">{language.requestDiagnostics.requestHeader}</h3>
        {#if headers.length === 0}
            <pre class="request-log-block">{log.header}</pre>
        {:else}
            <dl class="m-0 flex flex-col gap-1 rounded-md border border-darkborderc/60 bg-bgcolor/50 p-2 font-mono text-textcolor">
                {#each headers as [key, value]}
                    <div class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-2">
                        <dt class="break-all text-textcolor2/70">{key}</dt>
                        <dd class="m-0 break-all">{value}</dd>
                    </div>
                {/each}
            </dl>
        {/if}
    </section>

    <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold text-textcolor">{language.requestDiagnostics.requestBody}</h3>
        <pre class="request-log-block">{requestBody}</pre>
    </section>

    <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold text-textcolor">{language.requestDiagnostics.responseBody}</h3>
        {#if responseDetails}
            <div class="flex flex-col gap-2">
                {#each responseDetails.groups as group (group.event)}
                    <details class="rounded-md border border-darkborderc/60 bg-bgcolor/50 text-textcolor">
                        <summary class="cursor-pointer select-none p-2 font-mono">{group.summary}</summary>
                        <pre class="request-log-block rounded-none border-x-0 border-b-0">{group.readable}</pre>
                        <details class="border-t border-darkborderc/60">
                            <summary class="cursor-pointer select-none p-2 font-mono text-textcolor2">{language.requestDiagnostics.raw}</summary>
                            <pre class="request-log-block rounded-none border-x-0 border-b-0">{group.raw}</pre>
                        </details>
                    </details>
                {/each}
            </div>
            {#if responseDetails.remainder}
                <pre class="request-log-block mt-2">{responseDetails.remainder}</pre>
                <details class="mt-2 rounded-md border border-darkborderc/60 bg-bgcolor/50 text-textcolor2">
                    <summary class="cursor-pointer select-none p-2 font-mono">{language.requestDiagnostics.rawRemaining}</summary>
                    <pre class="request-log-block rounded-none border-x-0 border-b-0">{responseDetails.rawRemainder}</pre>
                </details>
            {/if}
        {:else}
            <pre class="request-log-block">{formatResponseBody(log)}</pre>
        {/if}
    </section>
</div>

<style>
    .request-log-block {
        margin: 0;
        max-height: 16rem;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        border: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 60%, transparent);
        border-radius: 0.375rem;
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 50%, transparent);
        padding: 0.5rem;
        color: var(--risu-theme-textcolor);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
</style>
