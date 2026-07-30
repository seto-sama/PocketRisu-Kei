<script lang="ts">
    import { language } from 'src/lang';
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import NotificationToggle from './Display/NotificationToggle.svelte';
    import SoundGroup from './Sound/SoundGroup.svelte';
    import SoundSetting from './Sound/SoundSetting.svelte';
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte';

    let {
        embedded = false,
    }: {
        embedded?: boolean;
    } = $props();
</script>

{#snippet content()}
    <SettingLayout variant="section" title={language.groupBrowserNotification} first><NotificationToggle /></SettingLayout>

    <SoundGroup title={language.groupMessageNotification}>
        <SoundSetting
            description={language.help.descMessageSound}
            bind:enabled={DBState.db.playMessage}
            bind:sound={DBState.db.messageSound}
            bind:volume={DBState.db.messageSoundVolume}
        />
    </SoundGroup>

    <SoundGroup title={language.groupTranslateNotification}>
        <SoundSetting
            description={language.help.descTranslateSound}
            bind:enabled={DBState.db.playMessageOnTranslateEnd}
            bind:sound={DBState.db.translateSound}
            bind:volume={DBState.db.translateSoundVolume}
        />
    </SoundGroup>
{/snippet}

{#if embedded}
    {@render content()}
{:else}
    <SettingPage title={language.soundAndNotification}>
        {@render content()}
    </SettingPage>
{/if}
