<script lang="ts">
    import { getCurrentLocale, language } from 'src/lang'
    import Tooltip from './components/Tooltip.svelte'
    import { globalFetch } from 'src/ts/globalApi.svelte'
    import { getApiKey } from 'src/ts/preset/apiKeyPool'
    import type { ImageGenerationPresetSettings } from 'src/ts/imageGeneration/presets'

    let { settings, open, generating }: {
        settings: ImageGenerationPresetSettings
        open: boolean
        generating: boolean
    } = $props()

    let percent = $state<number | null>(null)
    let fullAt = $state<number | null>(null)
    let now = $state(Date.now())
    const remainingTime = $derived.by(() => {
        if (fullAt === null) return language.imageGenerationQuotaTimeUnavailable
        const minutes = Math.max(0, Math.ceil((fullAt - now) / 60_000))
        const parts = [
            ['day', Math.floor(minutes / 1440)],
            ['hour', Math.floor(minutes % 1440 / 60)],
            ['minute', minutes % 60],
        ] as const
        return parts.filter(([unit, value]) => value > 0 || (unit === 'minute' && minutes === 0))
            .map(([unit, value]) => new Intl.NumberFormat(getCurrentLocale(), {
                style: 'unit', unit, unitDisplay: 'long',
            }).format(value)).join(' ')
    })
    const apiKey = $derived((getApiKey(settings.imageApiKeyRefs?.novelai)?.key ?? settings.NAIApiKey).trim())
    const fill = $derived(Math.min(100, Math.max(0, percent ?? 0)))

    $effect(() => {
        const key = apiKey
        const provider = settings.sdProvider
        percent = null
        fullAt = null
        if (!open || generating || provider !== 'novelai' || !key) return
        const controller = new AbortController()
        let active = true
        let pending = false
        async function refresh() {
            now = Date.now()
            if (pending) return
            pending = true
            try {
                const result = await globalFetch('https://image.novelai.net/user/subscription', {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${key}` },
                    abortSignal: controller.signal,
                    requestTimeoutMs: 15_000,
                })
                if (!active) return
                const usage = result.data?.usage
                if (result.ok && typeof usage?.percent === 'number' && Number.isFinite(usage.percent)) {
                    now = Date.now()
                    percent = usage.isNegative ? 0 : Math.max(0, usage.percent)
                    // NovelAI's frontend defines timeUntilNextPercent as seconds per 1%.
                    // A negative balance has no exposed magnitude, so its ETA is unknown.
                    const secondsPerPercent = usage.timeUntilNextPercent
                    fullAt = !usage.isNegative && percent < 100
                        && typeof secondsPerPercent === 'number' && Number.isFinite(secondsPerPercent) && secondsPerPercent > 0
                        ? Date.now() + (100 - percent) * secondsPerPercent * 1000
                        : null
                } else {
                    percent = null
                    fullAt = null
                }
            } catch {
                // Quota availability must not interrupt image generation.
                if (active) {
                    percent = null
                    fullAt = null
                }
            } finally {
                pending = false
            }
        }
        void refresh()
        const interval = setInterval(() => void refresh(), 60_000)
        return () => {
            clearInterval(interval)
            active = false
            controller.abort()
        }
    })
</script>

<Tooltip>
    {#snippet trigger(props)}
    <button {...props} type="button" data-risu-help class="flex min-h-5 w-40 items-center gap-1.5 text-xs font-normal text-subtext cursor-help">
        <span class="shrink-0">{language.imageGenerationRemainingQuota}</span>
        <div
            class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full border border-darkborderc bg-transparent"
            role="meter"
            aria-label={language.imageGenerationRemainingQuota}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={fill}
            aria-valuetext={percent === null ? '—' : `${percent}%`}
        >
            <div class="h-full bg-primary transition-[width]" style:width={`${fill}%`}></div>
        </div>
    </button>
    {/snippet}
    {language.imageGenerationQuotaHelp}
    {#if percent !== null && percent < 100}
        <br />
        {language.imageGenerationQuotaRemainingTime}: {remainingTime}
    {/if}
</Tooltip>
