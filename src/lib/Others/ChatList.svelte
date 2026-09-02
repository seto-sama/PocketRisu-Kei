<script lang="ts">
    import { v4 } from "uuid";
    import { language } from "src/lang";
    import { alertConfirm, notifyError } from "src/ts/alert";
    import { exportChat, importChat } from "src/ts/characters";
    import { changeChatTo, createPersistedChat, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { newChatModelDefaults, type ChatFolder } from "src/ts/storage/database.svelte";
    import { DBState, ReloadGUIPointer, selectedCharID } from "src/ts/stores.svelte";
    import InlineEditableName from "../UI/GUI/InlineEditableName.svelte";
    import PresetPickerActions from "../UI/PresetPickerActions.svelte";
    import PresetPickerLayout from "../UI/PresetPickerLayout.svelte";

    interface Props {
        close?: () => void;
    }

    interface ChatPickerFolder {
        id: string;
        name: string;
    }

    let { close = () => {} }: Props = $props();
    let selectedFolder = $state('all');
    let searchQuery = $state('');

    const character = $derived(DBState.db.characters[$selectedCharID]);
    const folders = $derived((character?.chatFolders ?? []).map(folder => ({
        id: folder.id,
        name: folder.name || language.presetNewFolder,
    })));
    const itemFolderIds = $derived((character?.chats ?? []).map(chat => chat.folderId));
    const itemNames = $derived((character?.chats ?? []).map(chat => chat.name));

    function persistListChange() {
        $ReloadGUIPointer += 1;
        void requestImmediateSave();
    }

    function updateFolders(next: ChatPickerFolder[]) {
        if (!character) return;
        const existing = new Map(character.chatFolders.map(folder => [folder.id, folder]));
        character.chatFolders = next.map(({ id, name }): ChatFolder => {
            const folder = existing.get(id);
            return folder
                ? { ...folder, name }
                : { id, name, folded: false };
        });
        persistListChange();
    }

    function assignChatToFolder(index: number, folderId: string | undefined) {
        const chat = character?.chats[index];
        if (!chat || !character) return;
        chat.folderId = folderId;
        character.chats = [...character.chats];
        persistListChange();
    }

    function deleteFolder(folderId: string) {
        if (!character) return;
        character.chats = character.chats.map(chat =>
            chat.folderId === folderId ? { ...chat, folderId: undefined } : chat
        );
    }

    function moveChat(fromIndex: number, toIndex: number) {
        if (!character || fromIndex === toIndex) return;
        const chats = [...character.chats];
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= chats.length || toIndex > chats.length) return;
        const activeChatId = chats[character.chatPage]?.id;
        const [moved] = chats.splice(fromIndex, 1);
        if (!moved) return;
        chats.splice(fromIndex < toIndex ? toIndex - 1 : toIndex, 0, moved);
        character.chats = chats;
        if (activeChatId) changeChatTo(activeChatId);
        persistListChange();
    }

    function selectChat(index: number) {
        if (!character?.chats[index]) return;
        changeChatTo(index);
        close();
    }

    async function deleteChat(index: number) {
        if (!character) return;
        if (character.chats.length === 1) {
            notifyError(language.errors.onlyOneChat);
            return;
        }
        const chat = character.chats[index];
        if (!chat || !(await alertConfirm(`${language.removeConfirm}${chat.name}`))) return;

        const activeChat = character.chats[character.chatPage];
        const nextChats = character.chats.filter((_, chatIndex) => chatIndex !== index);
        const nextActive = activeChat === chat
            ? nextChats[Math.min(index, nextChats.length - 1)]
            : activeChat;
        character.chats = nextChats;
        if (nextActive?.id) changeChatTo(nextActive.id);
        persistListChange();
    }

    async function createNewChat() {
        if (!character) return;
        const newChat = {
            message: [],
            note: '',
            name: `${language.newChat} ${character.chats.length + 1}`,
            localLore: [],
            fmIndex: -1,
            id: v4(),
            ...newChatModelDefaults(),
        };
        try {
            await createPersistedChat(character, newChat);
            close();
        } catch (error) {
            notifyError(error instanceof Error ? error.message : String(error));
        }
    }
</script>

{#if character}
    <PresetPickerLayout
        title={language.chatList}
        {folders}
        {itemFolderIds}
        {itemNames}
        itemDragDataKey="chatIndex"
        bind:selectedFolder
        bind:searchQuery
        searchPlaceholder={language.chatSearch}
        folderDeleteConfirm={language.chatFolderDeleteConfirm}
        folderEmptyMessage={language.chatFolderEmpty}
        noSearchResultsMessage={language.chatNoSearchResults}
        selectedItemIndex={character.chatPage}
        allowFolderAssignmentDrag
        {close}
        onFoldersChange={updateFolders}
        onAssignItem={assignChatToFolder}
        onDeleteFolder={deleteFolder}
        onMoveItem={moveChat}
        onSelectItem={selectChat}
        onExportItem={(index) => { void exportChat(index) }}
        onDeleteItem={deleteChat}
        itemRenameable
    >
        {#snippet itemContent(index, renameController)}
            {@const chat = character.chats[index]}
            {#if chat}
                <InlineEditableName
                    controller={renameController}
                    bind:value={character.chats[index].name}
                    size="default"
                    onActivate={() => selectChat(index)}
                    onCommit={persistListChange}
                />
            {/if}
        {/snippet}

        <PresetPickerActions
            onCreate={createNewChat}
            onImport={() => { void importChat() }}
        />
    </PresetPickerLayout>
{/if}
