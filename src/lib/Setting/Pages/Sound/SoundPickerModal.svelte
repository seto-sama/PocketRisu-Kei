<script lang="ts">
    import { language } from 'src/lang';
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import { bundledSoundIds, playSoundPreview } from 'src/ts/notificationSound';
    import { saveAsset } from 'src/ts/globalApi.svelte';
    import { selectSingleFile } from 'src/ts/util';
    import { DBState } from 'src/ts/stores.svelte';
    import { v4 as uuidv4 } from 'uuid';
    import { PlayIcon, UploadIcon, CheckIcon, Trash2Icon } from '@lucide/svelte';

    interface Props {
        open?: boolean;
        /** Current sound: a bundled preset id or an uploaded "assets/<hash>" path. */
        value?: string;
        /** Volume (0-100) used for previews. */
        volume?: number;
    }

    let { open = $bindable(false), value = $bindable(''), volume = 100 }: Props = $props();

    function presetLabel(id: string) {
        return id === 'default' ? language.soundDefault : id;
    }

    function select(v: string) {
        value = v;
        playSoundPreview(v, volume);
    }

    async function uploadSound() {
        const f = await selectSingleFile(['mp3', 'wav', 'ogg', 'm4a']);
        if (!f) return;
        // saveAsset hashes by content, so re-uploading the same file yields the
        // same path. Skip adding a second entry for identical bytes — just select
        // the existing one — but new content gets its own uuid-keyed entry.
        const path = await saveAsset(f.data, '', f.name);
        if (!(DBState.db.customSounds ?? []).some((s) => s.path === path)) {
            DBState.db.customSounds = [...(DBState.db.customSounds ?? []), { id: uuidv4(), name: f.name, path }];
        }
        select(path);
    }

    function removeCustom(entry: { id: string, path: string }) {
        DBState.db.customSounds = (DBState.db.customSounds ?? []).filter((s) => s.id !== entry.id);
        if (value === entry.path) {
            value = '';
        }
    }
</script>

<ShDialog bind:open size="default" tier="alert">
    {#snippet title()}
        {language.selectNotificationSound}
    {/snippet}

    <div class="flex flex-col gap-1 max-h-[50vh] overflow-y-auto pr-1">
        {#each bundledSoundIds as id}
            {@const selected = value === id || (!value && id === 'default')}
            <div class="flex items-center gap-2 rounded-md px-3 py-2 transition-colors {selected ? 'bg-selected' : 'hover:bg-selected/50'}">
                {#if selected}
                    <CheckIcon size={16} class="text-primary shrink-0" />
                {:else}
                    <span class="w-4 shrink-0"></span>
                {/if}
                <button class="flex-1 text-left truncate" onclick={() => select(id)}>
                    {presetLabel(id)}
                </button>
                <button class="shrink-0 hover:text-primary" onclick={() => playSoundPreview(id, volume)} aria-label={language.preview}>
                    <PlayIcon size={18} />
                </button>
            </div>
        {/each}

        {#each DBState.db.customSounds ?? [] as s (s.id)}
            {@const selected = value === s.path}
            <div class="flex items-center gap-2 rounded-md px-3 py-2 transition-colors {selected ? 'bg-selected' : 'hover:bg-selected/50'}">
                {#if selected}
                    <CheckIcon size={16} class="text-primary shrink-0" />
                {:else}
                    <span class="w-4 shrink-0"></span>
                {/if}
                <button class="flex-1 text-left truncate" onclick={() => select(s.path)} title={s.name}>
                    {s.name}
                </button>
                <button class="shrink-0 hover:text-primary" onclick={() => playSoundPreview(s.path, volume)} aria-label={language.preview}>
                    <PlayIcon size={18} />
                </button>
                <button class="shrink-0 text-textcolor2 hover:text-red-500" onclick={() => removeCustom(s)} aria-label={language.remove}>
                    <Trash2Icon size={18} />
                </button>
            </div>
        {/each}
    </div>

    {#snippet footer()}
        <ShButton variant="outline" size="sm" onclick={uploadSound}>
            <UploadIcon />
            {language.uploadSound}
        </ShButton>
    {/snippet}
</ShDialog>
