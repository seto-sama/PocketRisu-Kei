<script lang="ts">
    import { PencilIcon, TrashIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { alertConfirm, alertInput } from 'src/ts/alert';
    import {
        clearRealmMutes,
        realmMuteStore,
        setRealmCharacterMuteNote,
        setRealmCreatorMuteNote,
        unmuteRealmCharacter,
        unmuteRealmCreator,
    } from 'src/ts/realmMute';
    import PresetPickerLayout from '../PresetPickerLayout.svelte';
    import IconButton from '../GUI/IconButton.svelte';
    import IconButtonGroup from '../GUI/IconButtonGroup.svelte';

    interface Props {
        onClose: () => void;
    }

    let { onClose }: Props = $props();
    let selectedFolder = $state('all');

    const folders = $derived([
        { id: 'characters', name: language.realmMutedCharacters, sortable: false },
        { id: 'creators', name: language.realmMutedCreators, sortable: false },
    ]);
    const entries = $derived([
        ...$realmMuteStore.characters.map(entry => ({ ...entry, kind: 'characters' as const })),
        ...$realmMuteStore.creators.map(entry => ({ ...entry, kind: 'creators' as const })),
    ]);

    function removeEntry(index: number) {
        const entry = entries[index];
        if (!entry) return;
        if (entry.kind === 'characters') unmuteRealmCharacter(entry.id);
        else unmuteRealmCreator(entry.id);
    }

    async function editNote(index: number) {
        const entry = entries[index];
        if (!entry) return;
        const note = await alertInput(language.realmMuteNotePrompt, [], entry.note);
        if (note === null || note === undefined) return;
        if (entry.kind === 'characters') setRealmCharacterMuteNote(entry.id, note);
        else setRealmCreatorMuteNote(entry.id, note);
    }

    async function clearAll() {
        if (entries.length === 0 || !await alertConfirm(language.realmMuteClearAllConfirm)) return;
        clearRealmMutes();
    }
</script>

<PresetPickerLayout
    title={language.realmMuteManagement}
    {folders}
    itemFolderIds={entries.map(entry => entry.kind)}
    itemNames={entries.map(entry => entry.name)}
    itemSearchTexts={entries.map(entry => `${entry.name} ${entry.note} ${entry.id}`)}
    bind:selectedFolder
    itemDragDataKey="realmMuteIndex"
    close={onClose}
    onFoldersChange={() => {}}
    onAssignItem={() => {}}
    onDeleteFolder={() => {}}
    onSelectItem={() => {}}
    onDeleteItem={removeEntry}
    folderReadOnly
    folderReorderable={false}
    folderEditable={false}
    allowItemReorder={false}
    showCreateFolder={false}
    showUncategorized={false}
    searchPlaceholder={language.realmMuteSearchPlaceholder}
    folderEmptyMessage={language.realmMuteEmpty}
>
    {#snippet itemContent(index)}
        <span class="min-w-0 grow truncate text-sm text-maintext">
            <span>{entries[index].name}</span>
            <span class="text-subtext"> / {entries[index].note || language.realmMuteNoNote}</span>
        </span>
    {/snippet}
    {#snippet itemActions(index)}
        <IconButton
            title={language.realmMuteEditNote}
            aria-label={language.realmMuteEditNote}
            onclick={() => editNote(index)}
        >
            <PencilIcon />
        </IconButton>
    {/snippet}
    <IconButtonGroup className="mt-2 shrink-0 border-t border-darkborderc pt-2">
        <IconButton
            tone="destructive"
            disabled={entries.length === 0}
            title={language.realmMuteClearAll}
            aria-label={language.realmMuteClearAll}
            onclick={clearAll}
        >
            <TrashIcon />
        </IconButton>
    </IconButtonGroup>
</PresetPickerLayout>
