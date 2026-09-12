<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { createEntityId } from 'src/ts/id';
    import { DownloadIcon, UploadIcon, TrashIcon, FolderPlusIcon, FolderIcon, FolderOpenIcon, PackageIcon, CopyIcon, PencilIcon, SettingsIcon } from "@lucide/svelte";

    import type { Chat, ChatFolder, character } from "src/ts/storage/database.svelte";
    import { newChatModelDefaults } from "src/ts/storage/database.svelte";
    import { ensureChatHydrated } from "src/ts/storage/chatStorage";
    import { DBState, ReloadGUIPointer } from 'src/ts/stores.svelte';
    import { selectedCharID, chatDeselected } from "src/ts/stores.svelte";

    import Button from "../UI/components/Button.svelte";
    import SortableList from "../UI/components/SortableList.svelte";
    import InlineEditableName from "../UI/components/InlineEditableName.svelte";
    import IconButton, { iconButtonEdgeInset, iconButtonSizeValues } from "../UI/components/IconButton.svelte";
    import IconButtonGroup from "../UI/components/IconButtonGroup.svelte";
    import ListActionBar from "../UI/components/ListActionBar.svelte";
    import InlineRenameAction from "../UI/components/InlineRenameAction.svelte";
    import { InlineEditableNameController } from "../UI/components/InlineEditableNameController.svelte";
    import PopupButton from "../UI/PopupButton.svelte";
    import { Item as DropdownMenuItem } from "../UI/components/dropdown-menu";

    import { exportChat, importChat, exportAllChats } from "src/ts/characters";
    import { alertConfirm, alertError, notifySuccess, notifyError } from "src/ts/alert";

    import { openModuleListStore } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import Toggles from "./Toggles.svelte";
    import PersonaBind from "./PersonaBind.svelte";
    import PromptBind from "./PromptBind.svelte";
    import ModelBind from "./ModelBind.svelte";
    import { changeChatTo, createPersistedChat, createPersistedChatCopy, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { getFolderColorStyle } from "./folderColors";
    import { folderIconComponent } from "./folderIcons";
    import { openChatFolderMenu } from "./sidebarFolderMenu";

    interface Props {
        chara: character;
        mobile?: boolean;
    }

    let { chara = $bindable(), mobile = false }: Props = $props();
    const chatSortableOptions = { group: 'chats' };
    const chatFolderIconSize = iconButtonSizeValues.default.icon;

    // Safety net: chats whose folderId references a deleted folder would
    // otherwise be invisible (excluded from both the no-folder section and
    // any folder section). Render them in the no-folder section instead.
    // The server-side fix prevents new orphans; this guard rescues existing
    // ones until boot-time normalize touches the disk.
    const validFolderIds = $derived(
        new Set((chara.chatFolders ?? []).map(f => f.id).filter(Boolean))
    )
    const chatsByFolder = $derived.by(() => {
        const grouped = new Map<string, Chat[]>()
        for (const chat of chara.chats) {
            if (!chat.folderId) continue
            const folderChats = grouped.get(chat.folderId)
            if (folderChats) folderChats.push(chat)
            else grouped.set(chat.folderId, [chat])
        }
        return grouped
    })
    const chatIndexes = $derived(new Map(chara.chats.map((chat, index) => [chat, index] as const)))
    const isOrphanFolder = (folderId: string | null | undefined): boolean =>
        folderId != null && !validFolderIds.has(folderId)

    let listEle: HTMLDivElement | undefined = $state()

    function syncChatOrderFromDom() {
        if (!listEle) return
        const activeChat = chara.chats[chara.chatPage]
        const chatsById = new Map(chara.chats.map(chat => [chat.id, chat]))
        const nextChats: Chat[] = []
        const includedChats = new Set<Chat>()

        listEle.querySelectorAll<HTMLElement>('[data-sortable-chat-id]').forEach(chatElement => {
            const chat = chatsById.get(chatElement.dataset.sortableChatId ?? '')
            if (!chat || includedChats.has(chat)) return
            chat.folderId = chatElement.closest<HTMLElement>('[data-risu-chat-folder-id]')?.dataset.risuChatFolderId ?? null
            nextChats.push(chat)
            includedChats.add(chat)
        })

        for (const chat of chara.chats) {
            if (!includedChats.has(chat)) {
                nextChats.push(chat)
                includedChats.add(chat)
            }
        }

        chara.chats = nextChats
        changeChatTo(Math.max(0, nextChats.indexOf(activeChat)))
    }

    function reorderFolders(orderedIds: string[]) {
        const foldersById = new Map(chara.chatFolders.map(folder => [folder.id, folder]))
        chara.chatFolders = orderedIds
            .map(id => foldersById.get(id))
            .filter((folder): folder is ChatFolder => !!folder)
        syncChatOrderFromDom()
    }

    function toggleChatFolder(index: number) {
        const folder = chara.chatFolders[index]
        if (!folder) return
        folder.folded = !folder.folded
        $ReloadGUIPointer += 1
    }

    function createNewFolder() {
        const folders = chara.chatFolders ?? []
        chara.chatFolders = [{
            id: createEntityId(),
            name: `New Folder ${folders.length + 1}`,
            folded: false,
        }, ...folders]
        $ReloadGUIPointer += 1
    }

    async function createNewChat() {
        const newChat: Chat = {
            message: [],
            note: '',
            name: `${language.newChat} ${chara.chats.length + 1}`,
            localLore: [],
            fmIndex: -1,
            id: createEntityId(),
            ...newChatModelDefaults(),
        }
        try {
            await createPersistedChat(chara, newChat)
            $ReloadGUIPointer += 1
        } catch (error) {
            alertError(error)
        }
    }

    async function copyChat(chat: Chat) {
        const characterId = chara.chaId
        const chatId = chat.id
        if (!(await alertConfirm(`${language.copyChatConfirm}${chat.name}`))) return
        if (chara.chaId !== characterId) return
        let chatIdx = chara.chats.findIndex(item => item.id === chatId)
        if (chatIdx < 0) return
        if (chara.chats[chatIdx]?._placeholder) {
            await ensureChatHydrated(chara.chats, chatIdx, chara.chaId)
            if (chara.chaId !== characterId) return
            chatIdx = chara.chats.findIndex(item => item.id === chatId)
            if (chatIdx < 0) return
        }
        if (chara.chats[chatIdx]?._placeholder) {
            alertError('Failed to load chat data.')
            return
        }
        try {
            await createPersistedChatCopy(chara, chara.chats[chatIdx], 'Copy')
            notifySuccess(language.copyChatSuccess)
        } catch (error) {
            alertError(error)
        }
    }

    function exportSingleChat(chat: Chat) {
        const chatIdx = chara.chats.indexOf(chat)
        if (chatIdx >= 0) exportChat(chatIdx)
    }

    async function removeChat(chat: Chat) {
        const characterId = chara.chaId
        const chatId = chat.id
        if (chara.chats.length === 1) {
            notifyError(language.errors.onlyOneChat)
            return
        }
        if (!await alertConfirm(`${language.removeConfirm}${chat.name}`)) return
        if (chara.chaId !== characterId || !chara.chats.some(item => item.id === chatId)) return
        // The list can change while the confirmation dialog is open.
        if (chara.chats.length === 1) {
            notifyError(language.errors.onlyOneChat)
            return
        }
        changeChatTo(0)
        $ReloadGUIPointer += 1
        chara.chats = chara.chats.filter(item => item.id !== chatId)
        void requestImmediateSave()
    }
</script>

{#snippet chatActions(chat: Chat, renameController: InlineEditableNameController)}
    <IconButtonGroup
        className="no-sort ml-3 shrink-0"
        style={`margin-right:-${iconButtonEdgeInset(mobile ? 'lg' : 'default')}px`}
        onclick={(event) => event.stopPropagation()}
        onkeydown={(event) => event.stopPropagation()}
    >
        {#if mobile}
            <PopupButton>
                <DropdownMenuItem onSelect={() => renameController.startEditing()}>
                    <PencilIcon />
                    <span>{language.togglePresetMenuRename}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { void copyChat(chat) }}>
                    <CopyIcon />
                    <span>{language.copy}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportSingleChat(chat)}>
                    <DownloadIcon />
                    <span>{language.export}</span>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => { void removeChat(chat) }}>
                    <TrashIcon />
                    <span>{language.remove}</span>
                </DropdownMenuItem>
            </PopupButton>
        {:else}
            <InlineRenameAction controller={renameController} />
            <IconButton onclick={() => { void copyChat(chat) }}>
                <CopyIcon />
            </IconButton>
            <IconButton onclick={() => exportSingleChat(chat)}>
                <DownloadIcon />
            </IconButton>
            <IconButton tone="destructive" onclick={() => { void removeChat(chat) }}>
                <TrashIcon />
            </IconButton>
        {/if}
    </IconButtonGroup>
{/snippet}

<div class="flex flex-col w-full">
    <div class="relative bottom-2 flex items-stretch gap-1">
        <Button className="min-w-0 flex-1" onclick={createNewChat}>
            {language.newChat}
        </Button>
        <Button
            size="icon"
            className="shrink-0"
            title={language.presetNewFolder}
            aria-label={language.presetNewFolder}
            onclick={createNewFolder}
        >
            <FolderPlusIcon />
        </Button>
    </div>

    <div class="flex flex-col mt-2 overflow-y-auto max-h-100" bind:this={listEle}>
        <!-- folder div -->
        <SortableList
            className="flex flex-col"
            handle=".chat-folder-header"
            dragPreviewText={(folderId) => chara.chatFolders.find(folder => folder.id === folderId)?.name}
            onReorder={reorderFolders}
        >
            <!-- chat folder -->
            {#each chara.chatFolders as folder, i (folder.id)}
            {@const folderColorStyle = getFolderColorStyle(folder.color)}
            {@const folderChats = chatsByFolder.get(folder.id) ?? []}
            {@const FolderGlyph = folderIconComponent(folder.nodeOnlyIcon) ?? (folder.folded ? FolderIcon : FolderOpenIcon)}
            <div data-sortable-key={folder.id} data-risu-chat-folder-id={folder.id}
                class="risu-folder-section flex flex-col mb-1"
                style:--risu-folder-color={folderColorStyle.accent}>
                <!-- folder header -->
                <div
                    role="button"
                    tabindex="0"
                    aria-expanded={!folder.folded}
                    data-inline-rename-row
                    onclick={() => toggleChatFolder(i)}
                    onkeydown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleChatFolder(i)
                        }
                    }}
                    class="chat-folder-header risu-folder-header risu-selectable-row text-maintext cursor-pointer"
                >
                    <FolderGlyph size={chatFolderIconSize} class="risu-folder-icon mr-2 shrink-0" />
                    <InlineEditableName
                        size="row"
                        bind:value={chara.chatFolders[i].name}
                        onActivate={() => toggleChatFolder(i)}
                    />
                    <IconButton
                        className="no-sort ml-3"
                        style={`margin-right:-${iconButtonEdgeInset('default')}px`}
                        title={language.folderSettings}
                        aria-label={language.folderSettings}
                        onclick={(event) => {
                            event.stopPropagation()
                            openChatFolderMenu(chara.chaId, folder.id)
                        }}
                    >
                        <SettingsIcon />
                    </IconButton>
                </div>
                <!-- chats in folder -->
                <SortableList
                    className="risu-sidebar-chat-list risu-folder-children risu-tree-list flex flex-col gap-1 mt-1 text-maintext cursor-pointer {folder.folded ? 'hidden' : ''}"
                    draggable="[data-sortable-chat-id]"
                    dataAttribute="data-sortable-chat-id"
                    dragPreviewText={(chatId) => chara.chats.find(chat => chat.id === chatId)?.name}
                    options={chatSortableOptions}
                    onReorder={syncChatOrderFromDom}
                >
                    {#if folderChats.length === 0}
                    <EmptyState title={language.chatFolderEmpty} description="" layout="inline" density="compact" className="no-sort" />
                    <div></div>
                    {:else}
                    {#each folderChats as chat (chat.id)}
                    {@const chatIdx = chatIndexes.get(chat) ?? -1}
                    {@const renameController = new InlineEditableNameController()}
                    <div role="button" tabindex="0" data-tree-item data-inline-rename-row data-risu-chat-idx={chatIdx} data-sortable-chat-id={chat.id} data-sortable-no-scale onclick={() => changeChatTo(chatIdx)} onkeydown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            changeChatTo(chatIdx)
                        }
                    }} class="risu-selectable-row risu-chats flex h-8 min-w-0 shrink-0 items-center rounded-md text-maintext px-2 py-0.5 cursor-pointer" data-selected={chatIdx === chara.chatPage && !$chatDeselected}>
                        <InlineEditableName size="row" controller={renameController} bind:value={chat.name} editorLeadingInset="row" onActivate={() => changeChatTo(chatIdx)} />
                        {@render chatActions(chat, renameController)}
                    </div>
                    {/each}
                    {/if}
                </SortableList>
            </div>
            {/each}
        </SortableList>
        <!-- chat without folder div -->
        <SortableList
            className="risu-sidebar-chat-list flex flex-col gap-1"
            draggable="[data-sortable-chat-id]"
            dataAttribute="data-sortable-chat-id"
            dragPreviewText={(chatId) => chara.chats.find(chat => chat.id === chatId)?.name}
            options={chatSortableOptions}
            onReorder={syncChatOrderFromDom}
        >
            {#each chara.chats as chat, i (chat.id)}
            {@const renameController = new InlineEditableNameController()}
            {#if chat.folderId == null || isOrphanFolder(chat.folderId)}
            <div role="button" tabindex="0" data-tree-item data-inline-rename-row data-risu-chat-idx={i} data-sortable-chat-id={chat.id} data-sortable-no-scale onclick={() => changeChatTo(i)} onkeydown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    changeChatTo(i)
                }
            }}
            class="risu-selectable-row flex h-8 min-w-0 shrink-0 items-center rounded-md text-maintext px-2 py-0.5 cursor-pointer"
            data-selected={i === chara.chatPage && !$chatDeselected}>
                <InlineEditableName size="row" controller={renameController} bind:value={chara.chats[i].name} editorLeadingInset="row" onActivate={() => changeChatTo(i)} />
                {@render chatActions(chat, renameController)}
            </div>
            {/if}
            {/each}
        </SortableList>
    </div>

    <div>
        <ListActionBar mode="inline">
            <IconButton onclick={() => {
                exportAllChats()
            }}>
                <DownloadIcon />
            </IconButton>
            <IconButton onclick={() => {
                importChat()
            }}>
                <UploadIcon />
            </IconButton>
        </ListActionBar>

        {#if !$chatDeselected}
            {#if DBState.db.showModelInSidebar}
                <ModelBind />
            {/if}
            {#if DBState.db.showPresetInSidebar}
                <PromptBind />
            {/if}
            {#if DBState.db.showPersonaInSidebar}
                <PersonaBind />
            {/if}
            <Toggles bind:chara={chara} noContainer />
            {#if DBState.db.showModuleSidebar}
                <Button className="w-full mt-2" onclick={() => {
                    const char = DBState.db.characters[$selectedCharID]
                    if (!char) return
                    char.chats[char.chatPage].modules ??= []
                    openModuleListStore.set(true)
                }}>
                    <PackageIcon class="shrink-0" />
                    <span class="truncate">{language.modules}</span>
                </Button>
            {/if}
        {/if}
    </div>
</div>
