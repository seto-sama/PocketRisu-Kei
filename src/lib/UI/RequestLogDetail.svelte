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
    const responseBody = $derived(formatResponseBody(log))
    const responseDetails = $derived(getResponseBodyDetails(log))
</script>

{#snippet logBlock(content: string, wrapperClass = '')}
    <div class="request-log-wrapper {wrapperClass}">
        <pre class="request-log-block">{content}</pre>
    </div>
{/snippet}

<div class="flex flex-col gap-4 text-xs text-subtext {className}">
    <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold text-maintext">{language.requestDiagnostics.url}</h3>
        <div class="break-all rounded-md border border-darkborderc/60 bg-lightbg/50 p-2 font-mono text-maintext">{log.url}</div>
    </section>

    <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold text-maintext">{language.requestDiagnostics.requestHeader}</h3>
        {#if headers.length === 0}
            {@render logBlock(log.header)}
        {:else}
            <dl class="m-0 flex flex-col gap-1 rounded-md border border-darkborderc/60 bg-lightbg/50 p-2 font-mono text-maintext">
                {#each headers as [key, value]}
                    <div class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-2">
                        <dt class="break-all text-subtext/70">{key}</dt>
                        <dd class="m-0 break-all">{value}</dd>
                    </div>
                {/each}
            </dl>
        {/if}
    </section>

    <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold text-maintext">{language.requestDiagnostics.requestBody}</h3>
        {@render logBlock(requestBody)}
    </section>

    <section>
        <h3 class="mb-2 mt-0 text-sm font-semibold text-maintext">{language.requestDiagnostics.responseBody}</h3>
        {#if responseDetails}
            <div class="flex flex-col gap-2">
                {#each responseDetails.groups as group (group.event)}
                    <details open={group.defaultOpen} class="request-log-wrapper bg-lightbg/50 text-maintext">
                        <summary class="cursor-pointer select-none p-2 font-mono">{group.summary}</summary>
                        <pre class="request-log-block">{group.readable}</pre>
                        <details class="request-log-raw">
                            <summary class="cursor-pointer select-none p-2 font-mono text-subtext">{language.requestDiagnostics.raw}</summary>
                            <pre class="request-log-block">{group.raw}</pre>
                        </details>
                    </details>
                {/each}
            </div>
            {#if responseDetails.remainder}
                {@render logBlock(responseDetails.remainder, 'mt-2')}
                <details class="request-log-wrapper mt-2 bg-lightbg/50 text-subtext">
                    <summary class="cursor-pointer select-none p-2 font-mono">{language.requestDiagnostics.rawRemaining}</summary>
                    <pre class="request-log-block">{responseDetails.rawRemainder}</pre>
                </details>
            {/if}
        {:else}
            {@render logBlock(responseBody)}
        {/if}
    </section>
</div>

<style>
    .request-log-wrapper {
        --request-log-border: color-mix(in srgb, var(--risu-theme-darkborderc) 60%, transparent);

        overflow: hidden;
        border: 1px solid var(--request-log-border);
        border-radius: 0.375rem;
    }

    details.request-log-wrapper .request-log-block,
    .request-log-raw {
        border-top: 1px solid var(--request-log-border);
    }

    .request-log-block {
        margin: 0;
        max-height: 16rem;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        background: color-mix(in srgb, var(--risu-theme-lightbg) 50%, transparent);
        padding: 0.5rem;
        color: var(--risu-theme-maintext);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
</style>
