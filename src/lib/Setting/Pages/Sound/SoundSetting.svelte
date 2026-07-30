<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import { playSoundPreview } from 'src/ts/notificationSound';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import { PlayIcon, Music2Icon } from '@lucide/svelte';
    import SoundRow from './SoundRow.svelte';
    import SoundPickerModal from './SoundPickerModal.svelte';
    import SettingRenderer from '../../SettingRenderer.svelte';
    import type { SettingItem } from 'src/ts/setting/types';

    interface Props {
        description?: string;
        enabled?: boolean;
        sound?: string;
        volume?: number;
    }

    let {
        description,
        enabled = $bindable(false),
        sound = $bindable(''),
        volume = $bindable(100),
    }: Props = $props();

    let pickerOpen = $state(false);
    const soundTarget = {
        get enabled() { return enabled },
        set enabled(value: boolean) { enabled = value },
        get volume() { return volume },
        set volume(value: number) { volume = value },
    };

    const soundName = $derived.by(() => {
        if (!sound || sound === 'default') return language.soundDefault;
        if (sound.startsWith('assets/')) {
            return (DBState.db.customSounds ?? []).find((s) => s.path === sound)?.name ?? language.uploadedSound;
        }
        return sound;
    });
    const enableItems = $derived<SettingItem[]>([{
        id: 'sound.enabled', type: 'check', fallbackLabel: language.notificationEnable, description,
        bindPath: 'enabled',
    }]);
    const volumeItems = $derived<SettingItem[]>([{
        id: 'sound.volume', type: 'slider', fallbackLabel: language.soundEffectVolume,
        bindPath: 'volume',
        options: { min: 0, max: 100, step: 1, disabled: () => !enabled },
    }]);
</script>

<div class="divide-y divide-darkborderc">
    <SettingRenderer items={enableItems} target={soundTarget} layout="row" />

    <SoundRow label={language.soundEffect} dimmed={!enabled}>
        <div class="flex items-center gap-1 min-w-0">
            <ShButton
                variant="outline"
                size="sm"
                disabled={!enabled}
                onclick={() => (pickerOpen = true)}
                className="max-w-56"
            >
                <Music2Icon class="shrink-0" />
                <span class="truncate">{soundName}</span>
            </ShButton>
            <ShButton
                variant="outline"
                size="icon-sm"
                disabled={!enabled}
                onclick={() => playSoundPreview(sound, volume)}
                aria-label={language.preview}
            >
                <PlayIcon />
            </ShButton>
        </div>
    </SoundRow>

    <SettingRenderer items={volumeItems} target={soundTarget} layout="row" />
</div>

<SoundPickerModal bind:open={pickerOpen} bind:value={sound} {volume} />
