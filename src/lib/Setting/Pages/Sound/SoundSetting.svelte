<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import { playSoundPreview } from 'src/ts/notificationSound';
    import Button from '../../../UI/components/Button.svelte';
    import { PlayIcon, Music2Icon } from '@lucide/svelte';
    import SoundRow from './SoundRow.svelte';
    import SoundPickerModal from './SoundPickerModal.svelte';

    interface Props {
        label: string;
        description?: string;
        sound?: string;
        volume?: number;
    }

    let {
        label,
        description,
        sound = $bindable(''),
        volume = $bindable(100),
    }: Props = $props();

    let pickerOpen = $state(false);

    const soundName = $derived.by(() => {
        if (!sound || sound === 'silent') return language.soundSilent;
        if (sound === 'default') return language.soundDefault;
        if (sound.startsWith('assets/')) {
            return (DBState.db.customSounds ?? []).find((s) => s.path === sound)?.name ?? language.uploadedSound;
        }
        return sound;
    });
</script>

<SoundRow {label} {description}>
    <div class="flex items-center gap-1 min-w-0">
        <Button
            variant="outline"
            size="sm"
            onclick={() => (pickerOpen = true)}
            className="max-w-56"
        >
            <Music2Icon class="shrink-0" />
            <span class="truncate">{soundName}</span>
        </Button>
        <Button
            variant="outline"
            size="icon-sm"
            onclick={() => playSoundPreview(sound, volume)}
            aria-label={language.preview}
        >
            <PlayIcon />
        </Button>
    </div>
</SoundRow>

<SoundPickerModal bind:open={pickerOpen} bind:value={sound} {volume} />
