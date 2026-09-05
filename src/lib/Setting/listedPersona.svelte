<script lang="ts">
    import { language } from "../../lang";
    import { getCharImage } from "src/ts/characters";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { changeUserPersona, createUserPersona, deleteUserPersona, exportUserPersona, importUserPersona, moveUserPersona, saveUserPersona } from "src/ts/persona";
    import { DBState, settingsOpen } from "src/ts/stores.svelte";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import PresetPickerLayout from "../UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "../UI/PresetPickerActions.svelte";
    import InlineEditableName from "../UI/components/InlineEditableName.svelte";
    import AvatarFallback from "../UI/AvatarFallback.svelte";
    import { v4 as uuidv4 } from "uuid";
    import { removePresetTag, togglePresetTag } from "src/ts/preset/tags";

    interface Props {
        close?: () => void;
        onSelect?: ((index: number) => void) | null;
    }

    let { close = () => {}, onSelect = null }: Props = $props();
    let selectedFolder = $state('all');
    let searchQuery = $state('');
    let visibleItemIndexes = $state<number[]>([]);
    let emptyMessage = $state('');
    const tags = $derived(DBState.db.personaTags ?? []);

    function selectPersona(index: number) {
        if (onSelect) onSelect(index);
        else changeUserPersona(index);
        close();
    }

    function assignPersonaToTag(index: number, tagId: string | undefined) {
        const persona = DBState.db.personas[index];
        if (!persona) return;
        persona.tagIds = togglePresetTag(persona.tagIds, tagId);
        DBState.db.personas = [...DBState.db.personas];
        void requestImmediateSave();
    }

    function duplicatePersona(index: number) {
        if (index === DBState.db.selectedPersona) saveUserPersona();
        const source = DBState.db.personas[index];
        if (!source) return;
        const copy = safeStructuredClone(source);
        copy.id = uuidv4();
        copy.name = `${source.name} ${language.copy}`;
        DBState.db.personas = [...DBState.db.personas, copy];
        void requestImmediateSave();
    }

    async function importPersona() {
        const previousLength = DBState.db.personas.length;
        await importUserPersona();
        if (DBState.db.personas.length <= previousLength) return;
        const importedIndex = DBState.db.personas.length - 1;
        changeUserPersona(importedIndex);
        void requestImmediateSave();
    }
</script>

<PresetPickerLayout
    title={language.persona}
    folders={tags}
    itemFolderIds={DBState.db.personas.map(persona => persona.tagIds)}
    organizationKind="tag"
    itemNames={DBState.db.personas.map(persona => persona.name ?? '')}
    itemSearchTexts={DBState.db.personas.map(persona => `${persona.name ?? ''}\n${persona.note ?? ''}`)}
    searchPlaceholder={language.personaSearch}
    itemDragDataKey="personaIndex"
    bind:selectedFolder
    bind:searchQuery
    bind:visibleItemIndexes
    bind:emptyMessage
    selectedItemIndex={DBState.db.selectedPersona}
    onMoveItem={moveUserPersona}
    onSelectItem={selectPersona}
    onDuplicateItem={duplicatePersona}
    onExportItem={exportUserPersona}
    onDeleteItem={deleteUserPersona}
    itemDeleteLabel={language.personaDeleteAction}
    {close}
    onFoldersChange={(next) => {
        DBState.db.personaTags = next;
        void requestImmediateSave();
    }}
    onAssignItem={assignPersonaToTag}
    onDeleteFolder={(tagId) => {
        DBState.db.personas = DBState.db.personas.map(persona =>
            ({ ...persona, tagIds: removePresetTag(persona.tagIds, tagId) })
        );
        void requestImmediateSave();
    }}
    configure={!$settingsOpen ? () => {
        close();
        openSettings(SettingsRoute.Persona);
    } : undefined}
    itemRenameable
>
    {#snippet itemContent(index, renameController)}
        {@const persona = DBState.db.personas[index]}
        <div class="mr-2 h-7 w-7 shrink-0 overflow-hidden rounded-md">
            {#if persona.icon}
                {#await getCharImage(persona.icon, 'css') then imageStyle}
                    <div class="h-full w-full bg-cover bg-center" style={imageStyle}></div>
                {/await}
            {:else}
                <AvatarFallback className="h-full w-full" iconSize={16} />
            {/if}
        </div>
        <InlineEditableName
            controller={renameController}
            bind:value={DBState.db.personas[index].name}
            size="default"
            onActivate={() => selectPersona(index)}
            onValueChange={(value) => {
                if (index === DBState.db.selectedPersona) DBState.db.username = value;
            }}
        >
            {#snippet display()}
                <span>{persona.name}</span>
                {#if persona.note}<span class="text-subtext"> / {persona.note}</span>{/if}
            {/snippet}
        </InlineEditableName>
    {/snippet}

    <PresetPickerActions
        onCreate={createUserPersona}
        onImport={importPersona}
    />
</PresetPickerLayout>
