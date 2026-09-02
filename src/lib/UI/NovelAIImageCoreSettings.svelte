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
    import NumberInput from './GUI/NumberInput.svelte'
    import OptionInput from './GUI/OptionInput.svelte'
    import SelectInput from './GUI/SelectInput.svelte'
    import ShButton from './GUI/ShButton.svelte'

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
                <ShButton
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
                </ShButton>
            {/if}
            <SelectInput
                className="w-48 text-sm"
                size="sm"
                value={settings.NAIImgSizePreset}
                onchange={(event) => applySizePreset(event.currentTarget.value as NAIImageSizePreset)}
            >
                <OptionInput value="small">{language.imageSettings.sizeSmall}</OptionInput>
                <OptionInput value="normal">{language.imageSettings.sizeNormal}</OptionInput>
                <OptionInput value="large">{language.imageSettings.sizeLarge}</OptionInput>
                <OptionInput value="custom">{language.imageSettings.sizeCustom}</OptionInput>
            </SelectInput>
        </div>
    {/snippet}
</SettingLayout>
{#if settings.NAIImgSizePreset === 'custom'}
    <SettingLayout variant="row" title={language.imageSettings.width} description={language.help.naiWidth}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={settings.NAIImgConfig.width}/>{/snippet}</SettingLayout>
    <SettingLayout variant="row" title={language.imageSettings.height} description={language.help.naiHeight}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={settings.NAIImgConfig.height}/>{/snippet}</SettingLayout>
{/if}
<SettingLayout variant="row" title={language.imageSettings.sampler} description={language.help.naiSampler}>
    {#snippet control()}
        <SelectInput className="w-48 text-sm" size="sm" bind:value={settings.NAIImgConfig.sampler}>
            {#each samplerOptions as [value, label]}
                <OptionInput {value}>{label}</OptionInput>
            {/each}
        </SelectInput>
    {/snippet}
</SettingLayout>
<SettingLayout variant="row" title={language.imageSettings.noiseSchedule} description={language.help.naiNoiseSchedule}>{#snippet control()}<SelectInput className="w-48 text-sm" size="sm" bind:value={settings.NAIImgConfig.noise_schedule}>
    <OptionInput value="native">native</OptionInput>
    <OptionInput value="karras">karras</OptionInput>
    <OptionInput value="exponential">exponential</OptionInput>
    <OptionInput value="polyexponential">polyexponential</OptionInput>
</SelectInput>{/snippet}</SettingLayout>
<SettingLayout variant="row" title={language.imageSettings.steps} description={language.help.naiSteps}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={settings.NAIImgConfig.steps}/>{/snippet}</SettingLayout>
<SettingLayout variant="row" title={language.imageSettings.cfgScale} description={language.help.naiCFG}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={2048} bind:value={settings.NAIImgConfig.scale}/>{/snippet}</SettingLayout>
<SettingLayout variant="row" title={language.imageSettings.cfgRescale} description={language.help.naiCFGRescale}>{#snippet control()}<NumberInput className="w-48 text-sm" size="sm" min={0} max={1} bind:value={settings.NAIImgConfig.cfg_rescale}/>{/snippet}</SettingLayout>
