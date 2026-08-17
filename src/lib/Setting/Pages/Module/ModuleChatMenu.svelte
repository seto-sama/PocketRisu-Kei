<script lang="ts">
    import { Waypoints } from "@lucide/svelte";
    import { language } from "src/lang";
    import PresetPickerLayout from "src/lib/UI/PresetPickerLayout.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { AddonSettingsTab, openAddonSettings } from "src/ts/routing";
    import { DBState, ReloadGUIPointer, selectedCharID } from "src/ts/stores.svelte";

    interface Props {
        close?: (id: string) => void;
        alertMode?: boolean;
    }

    let { close = () => {}, alertMode = false }: Props = $props();
    let moduleSearch = $state('');
    let selectedFolder = $state('all');
    let visibleModuleIndexes = $state<number[]>([]);
    let emptyModuleMessage = $state('');
    const moduleFolders = $derived(DBState.db.moduleFolders ?? []);

    function currentCharacter() {
        return DBState.db.characters[$selectedCharID];
    }

    function currentChat() {
        const character = currentCharacter();
        return character?.chats?.[character.chatPage];
    }

    function isGlobal(moduleId: string) {
        return DBState.db.enabledModules.includes(moduleId);
    }

    function isPrimary(moduleId: string) {
        return currentChat()?.modules?.includes(moduleId) ?? false;
    }

    function isScoped(moduleId: string) {
        return currentCharacter()?.modules?.includes(moduleId) ?? false;
    }

    function setPrimary(moduleId: string, checked: boolean) {
        if (isGlobal(moduleId)) return;
        const chat = currentChat();
        const character = currentCharacter();
        if (!chat || !character) return;
        chat.modules ??= [];
        character.modules ??= [];

        if (checked) {
            if (!chat.modules.includes(moduleId)) chat.modules = [...chat.modules, moduleId];
            character.modules = character.modules.filter((id) => id !== moduleId);
        } else {
            // The switch represents both scopes, so turning it off must clear
            // a previously selected character-scoped value as well.
            chat.modules = chat.modules.filter((id) => id !== moduleId);
            character.modules = character.modules.filter((id) => id !== moduleId);
        }
        $ReloadGUIPointer += 1;
    }

    function toggleScoped(moduleId: string, event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        if (isGlobal(moduleId)) return;
        const character = currentCharacter();
        const chat = currentChat();
        if (!character || !chat) return;
        character.modules ??= [];
        chat.modules ??= [];
        if (character.modules.includes(moduleId) || chat.modules.includes(moduleId)) {
            // Match lorebook's three-state behavior: changing scope always
            // passes through neutral instead of replacing the active scope.
            character.modules = character.modules.filter((id) => id !== moduleId);
            chat.modules = chat.modules.filter((id) => id !== moduleId);
        } else {
            character.modules = [...character.modules, moduleId];
        }
        $ReloadGUIPointer += 1;
    }

    function moveModule(fromIndex: number, toIndex: number) {
        const modules = [...DBState.db.modules];
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= modules.length || toIndex > modules.length) return;
        const [moved] = modules.splice(fromIndex, 1);
        if (!moved) return;
        modules.splice(fromIndex < toIndex ? toIndex - 1 : toIndex, 0, moved);
        DBState.db.modules = modules;
        void requestImmediateSave();
    }

    function assignModuleToFolder(index: number, folderId: string | undefined) {
        const rmodule = DBState.db.modules[index];
        if (!rmodule) return;
        rmodule.folderId = folderId;
        DBState.db.modules = [...DBState.db.modules];
        void requestImmediateSave();
    }

    function selectModule(index: number) {
        const rmodule = DBState.db.modules[index];
        if (!rmodule) return;
        if (alertMode) close(rmodule.id);
    }

    function openModuleSettings() {
        openAddonSettings(AddonSettingsTab.Module);
        close('');
    }

    function closePicker() {
        close('');
    }
</script>

<PresetPickerLayout
    title={language.modules}
    titleHelp={language.chatModulesInfo}
    folders={moduleFolders}
    itemFolderIds={DBState.db.modules.map((rmodule) => rmodule.folderId)}
    itemNames={DBState.db.modules.map((rmodule) => rmodule.name)}
    itemSearchTexts={DBState.db.modules.map((rmodule) => `${rmodule.name}\n${rmodule.description ?? ''}`)}
    searchPlaceholder={language.search}
    itemDragDataKey="moduleIndex"
    readOnly
    bind:selectedFolder
    bind:searchQuery={moduleSearch}
    bind:visibleItemIndexes={visibleModuleIndexes}
    bind:emptyMessage={emptyModuleMessage}
    onMoveItem={moveModule}
    onSelectItem={selectModule}
    close={closePicker}
    onFoldersChange={(next) => {
        DBState.db.moduleFolders = next;
        void requestImmediateSave();
    }}
    onAssignItem={assignModuleToFolder}
    onDeleteFolder={(folderId) => {
        DBState.db.modules = DBState.db.modules.map((rmodule) =>
            rmodule.folderId === folderId ? { ...rmodule, folderId: undefined } : rmodule
        );
        void requestImmediateSave();
    }}
    configure={openModuleSettings}
>
    {#snippet itemContent(index)}
        {@const rmodule = DBState.db.modules[index]}
        <div class="min-w-0 grow flex items-center gap-2">
            {#if rmodule.mcp}
                <Waypoints size={18} class="shrink-0 text-textcolor2" />
            {/if}
            <div class="min-w-0 grow truncate">
                <span class:isModuleGlobal={isGlobal(rmodule.id)}>{rmodule.name}</span>
                {#if rmodule.description}
                    <span class="text-textcolor2"> / {rmodule.description}</span>
                {/if}
            </div>
        </div>

        {#if !alertMode}
            <!-- The switch is chat-scoped on left click and character-scoped on right click/long press. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
                class="mr-1 shrink-0"
                role="presentation"
                onclick={(event) => event.stopPropagation()}
                oncontextmenu={(event) => toggleScoped(rmodule.id, event)}
                title={language.chatModulesInfo}
            >
                <ShSwitch
                    checked={isPrimary(rmodule.id) || isScoped(rmodule.id)}
                    disabled={isGlobal(rmodule.id)}
                    className={isScoped(rmodule.id) && !isPrimary(rmodule.id) ? 'data-[state=checked]:bg-scoped' : ''}
                    onCheckedChange={(checked) => setPrimary(rmodule.id, checked)}
                />
            </div>
        {/if}
    {/snippet}

</PresetPickerLayout>

<style>
    .isModuleGlobal {
        color: var(--risu-theme-textcolor2);
    }
</style>
