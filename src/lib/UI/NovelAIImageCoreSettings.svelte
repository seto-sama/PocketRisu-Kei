<script lang="ts">
    import { RectangleHorizontalIcon, RectangleVerticalIcon, SquareIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte'
    import {
        getNAIImageDimensions,
        type NAIImageCoreSettings,
        type NAIImageOrientation,
        type NAIImageSizePreset,
    } from 'src/ts/imageGeneration/presets'
    import NumberInput from './components/NumberInput.svelte'
    import Slider from './components/Slider.svelte'
    import SelectOption from './components/SelectOption.svelte'
    import Select from './components/Select.svelte'
    import Button from './components/Button.svelte'

    interface Props {
        settings: NAIImageCoreSettings
    }

    let { settings }: Props = $props()
    const orientationOrder: NAIImageOrientation[] = ['landscape', 'portrait', 'square']
    const samplerOptions = [
        ['k_euler_ancestral', 'Euler Ancestral'],
        ['k_euler', 'Euler'],
        ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
        ['k_dpmpp_2m_sde', 'DPM++ 2M SDE'],
        ['k_dpmpp_2s', 'DPM++ 2S'],
        ['k_dpmpp_sde', 'DPM++ SDE'],
    ]

    function applySizePreset(size: NAIImageSizePreset, orientation = settings.NAIImgOrientation) {
        if (settings.NAIImgSizePreset !== size) settings.NAIImgSizePreset = size
        if (size === 'custom') return
        const [width, height] = getNAIImageDimensions(size, orientation)
        if (settings.NAIImgConfig.width !== width) settings.NAIImgConfig.width = width
        if (settings.NAIImgConfig.height !== height) settings.NAIImgConfig.height = height
    }

    function cycleOrientation() {
        const currentIndex = orientationOrder.indexOf(settings.NAIImgOrientation)
        const orientation = orientationOrder[(currentIndex + 1) % orientationOrder.length]
        settings.NAIImgOrientation = orientation
        applySizePreset(settings.NAIImgSizePreset, orientation)
    }
</script>

<SettingLayout variant="row" title={language.imageSettings.resolution} description={language.help.naiResolution}>
    {#snippet control()}
        <div class="flex shrink-0 items-center gap-2 self-end">
            {#if settings.NAIImgSizePreset !== 'custom'}
                <Button
                    variant="outline"
                    size="icon-sm"
                    onclick={cycleOrientation}
                    title={language.imageSettings[settings.NAIImgOrientation]}
                    aria-label={language.imageSettings[settings.NAIImgOrientation]}
                >
                    {#if settings.NAIImgOrientation === 'landscape'}
                        <RectangleHorizontalIcon />
                    {:else if settings.NAIImgOrientation === 'portrait'}
                        <RectangleVerticalIcon />
                    {:else}
                        <SquareIcon />
                    {/if}
                </Button>
            {/if}
            <Select
                className="w-48 text-sm"
                size="sm"
                value={settings.NAIImgSizePreset}
                onchange={(event) => applySizePreset(event.currentTarget.value as NAIImageSizePreset)}
            >
                <SelectOption value="small">{language.imageSettings.sizeSmall}</SelectOption>
                <SelectOption value="normal">{language.imageSettings.sizeNormal}</SelectOption>
                <SelectOption value="large">{language.imageSettings.sizeLarge}</SelectOption>
                <SelectOption value="custom">{language.imageSettings.sizeCustom}</SelectOption>
            </Select>
        </div>
    {/snippet}
</SettingLayout>
{#if settings.NAIImgSizePreset === 'custom'}
    <SettingLayout variant="row" title={language.imageSettings.width} description={language.help.naiWidth}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={settings.NAIImgConfig.width}/>{/snippet}</SettingLayout>
    <SettingLayout variant="row" title={language.imageSettings.height} description={language.help.naiHeight}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={settings.NAIImgConfig.height}/>{/snippet}</SettingLayout>
{/if}
<SettingLayout variant="row" title={language.imageSettings.sampler} description={language.help.naiSampler}>
    {#snippet control()}
        <Select className="w-48 text-sm" size="sm" bind:value={settings.NAIImgConfig.sampler}>
            {#each samplerOptions as [value, label]}
                <SelectOption {value}>{label}</SelectOption>
            {/each}
        </Select>
    {/snippet}
</SettingLayout>
<SettingLayout variant="row" title={language.imageSettings.noiseSchedule} description={language.help.naiNoiseSchedule}>{#snippet control()}<Select className="w-48 text-sm" size="sm" bind:value={settings.NAIImgConfig.noise_schedule}>
    <SelectOption value="native">native</SelectOption>
    <SelectOption value="karras">karras</SelectOption>
    <SelectOption value="exponential">exponential</SelectOption>
    <SelectOption value="polyexponential">polyexponential</SelectOption>
</Select>{/snippet}</SettingLayout>
<SettingLayout variant="row" title={language.imageSettings.steps} description={language.help.naiSteps}>
    {#snippet control()}
        <div class="w-48">
            <Slider min={1} max={28} step={1} inputWidth="w-16" bind:value={settings.NAIImgConfig.steps} />
        </div>
    {/snippet}
</SettingLayout>
<SettingLayout variant="row" title={language.imageSettings.cfgScale} description={language.help.naiCFG}>
    {#snippet control()}
        <div class="w-48">
            <Slider min={1} max={10} step={0.1} fixed={1} inputWidth="w-16" bind:value={settings.NAIImgConfig.scale} />
        </div>
    {/snippet}
</SettingLayout>
<SettingLayout variant="row" title={language.imageSettings.cfgRescale} description={language.help.naiCFGRescale}>
    {#snippet control()}
        <div class="w-48">
            <Slider min={0} max={1} step={0.01} fixed={2} inputWidth="w-16" bind:value={settings.NAIImgConfig.cfg_rescale} />
        </div>
    {/snippet}
</SettingLayout>
