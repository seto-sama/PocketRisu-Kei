<script lang="ts">
    import { language } from 'src/lang';
    import SettingPage from '../../UI/components/SettingPage.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import NotificationToggle from './Display/NotificationToggle.svelte';
    import SoundSetting from './Sound/SoundSetting.svelte';
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte';
    import SettingRenderer from '../SettingRenderer.svelte';
    import type { SettingItem } from 'src/ts/setting/types';

    let {
        embedded = false,
    }: {
        embedded?: boolean;
    } = $props();

    const volumeItems: SettingItem[] = [
        {
            id: 'sound.messageVolume', type: 'slider', fallbackLabel: language.groupMessageNotification,
            bindKey: 'messageSoundVolume', options: { min: 0, max: 100, step: 1 },
        },
        {
            id: 'sound.translateVolume', type: 'slider', fallbackLabel: language.groupTranslateNotification,
            bindKey: 'translateSoundVolume', options: { min: 0, max: 100, step: 1 },
        },
        {
            id: 'sound.ttsVolume', type: 'slider', fallbackLabel: language.ttsVoiceVolume,
            bindKey: 'ttsVolume', options: { min: 0, max: 100, step: 1 },
        },
    ];
</script>

{#snippet content()}
    <SettingLayout variant="section" title={language.groupNotification} first>
        <div class="divide-y divide-darkborderc">
            <NotificationToggle />
            <SoundSetting
                label={language.groupMessageNotification}
                description={language.help.descMessageSound}
                bind:sound={DBState.db.messageSound}
                volume={DBState.db.messageSoundVolume}
            />
            <SoundSetting
                label={language.groupTranslateNotification}
                description={language.help.descTranslateSound}
                bind:sound={DBState.db.translateSound}
                volume={DBState.db.translateSoundVolume}
            />
        </div>
    </SettingLayout>

    <SettingLayout variant="section" title={language.groupVolume}>
        <SettingRenderer items={volumeItems} layout="row" />
    </SettingLayout>
{/snippet}

{#if embedded}
    {@render content()}
{:else}
    <SettingPage title={language.soundAndNotification}>
        {@render content()}
    </SettingPage>
{/if}
