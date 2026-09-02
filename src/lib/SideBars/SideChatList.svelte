<script lang="ts">
    import { v4 } from "uuid";
    import { DownloadIcon, UploadIcon, MenuIcon, TrashIcon, FolderPlusIcon, PackageIcon, CopyIcon } from "@lucide/svelte";

    import type { Chat, ChatFolder, character } from "src/ts/storage/database.svelte";
    import { newChatModelDefaults } from "src/ts/storage/database.svelte";
    import { ensureChatHydrated } from "src/ts/storage/chatStorage";
    import { DBState, ReloadGUIPointer } from 'src/ts/stores.svelte';
    import { selectedCharID, chatDeselected } from "src/ts/stores.svelte";

    import ShButton from "../UI/GUI/ShButton.svelte";
    import ShSortableList from "../UI/GUI/ShSortableList.svelte";
    import InlineEditableName from "../UI/GUI/InlineEditableName.svelte";
    import IconButton from "../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";
    import InlineRenameAction from "../UI/GUI/InlineRenameAction.svelte";
    import { InlineEditableNameController } from "../UI/GUI/inlineEditableNameController.svelte";

    import { exportChat, importChat, exportAllChats } from "src/ts/characters";
    import { alertConfirm, alertError, alertSelect, notifySuccess, notifyError } from "src/ts/alert";

    import { openModuleListStore } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import Toggles from "./Toggles.svelte";
    import PersonaBind from "./PersonaBind.svelte";
    import PromptBind from "./PromptBind.svelte";
    import ModelBind from "./ModelBind.svelte";
    import { changeChatTo, createPersistedChat, createPersistedChatCopy, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { folderColorOptions, getFolderColorStyle } from "./folderColors";

    interface Props {
        chara: character;
    }

    let { chara = $bindable() }: Props = $props();

    // Safety net: chats whose folderId references a deleted folder would
    // otherwise be invisible (excluded from both the no-folder section and
    // any folder section). Render them in the no-folder section instead.
    // The server-side fix prevents new orphans; this guard rescues existing
    // ones until boot-time normalize touches the disk.
    const validFolderIds = $derived(
        new Set((chara.chatFolders ?? []).map(f => f.id).filter(Boolean))
    )
    const isOrphanFolder = (folderId: string | null | undefined): boolean =>
        folderId != null && !validFolderIds.has(folderId)

    let listEle: HTMLDivElement = $state()

    function syncChatOrderFromDom() {
        const activeChat = chara.chats[chara.chatPage]
        const chatsById = new Map(chara.chats.map(chat => [chat.id, chat]))
        const nextChats: Chat[] = []

        listEle.querySelectorAll<HTMLElement>('[data-sortable-chat-id]').forEach(chatElement => {
            const chat = chatsById.get(chatElement.dataset.sortableChatId ?? '')
            if (!chat || nextChats.includes(chat)) return
            chat.folderId = chatElement.closest<HTMLElement>('[data-risu-chat-folder-id]')?.dataset.risuChatFolderId ?? null
            nextChats.push(chat)
        })

        for (const chat of chara.chats) {
            if (!nextChats.includes(chat)) nextChats.push(chat)
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

    async function createNewChat() {
        const len = chara.chats.length
        const newChat = {
            message:[] as any[], note:'', name:`${language.newChat} ${len + 1}`, localLore:[] as any[], fmIndex: -1, id: v4(),
            ...newChatModelDefaults()
        }
        try {
            await createPersistedChat(chara, newChat)
            $ReloadGUIPointer += 1
        } catch (error) {
            alertError(error)
        }
    }

    function createNewFolder() {
        chara.chatFolders ??= []
        const folders = chara.chatFolders
        folders.unshift({
            id: v4(),
            name: `New Folder ${folders.length + 1}`,
            folded: false,
        })
        chara.chatFolders = folders
        $ReloadGUIPointer += 1
    }
</script>
<div class="flex flex-col w-full">
    <div class="relative bottom-2 flex items-stretch gap-1">
        <ShButton className="min-w-0 flex-1" onclick={createNewChat}>
            {language.newChat}
        </ShButton>
        <ShButton
            size="icon"
            className="shrink-0"
            title={language.presetNewFolder}
            aria-label={language.presetNewFolder}
            onclick={createNewFolder}
        >
            <FolderPlusIcon />
        </ShButton>
    </div>

    <div class="flex flex-col mt-2 overflow-y-auto max-h-100" bind:this={listEle}>
        <!-- folder div -->
        <ShSortableList
            className="flex flex-col"
            handle=".chat-folder-header"
            dragPreviewText={(folderId) => chara.chatFolders.find(folder => folder.id === folderId)?.name}
            onReorder={reorderFolders}
        >
            <!-- chat folder -->
            {#each chara.chatFolders as folder, i (folder.id)}
            {@const folderColorStyle = getFolderColorStyle(folder.color)}
            {@const renameController = new InlineEditableNameController()}
            <div data-sortable-key={folder.id} data-risu-chat-folder-id={folder.id}
                class="flex flex-col mb-2 border-solid border-1 cursor-pointer rounded-md {folderColorStyle.border}">
                <!-- folder header -->
                <div
                    role="button"
                    tabindex="0"
                    data-inline-rename-row
                    onclick={() => {
                        chara.chatFolders[i].folded = !folder.folded
                        $ReloadGUIPointer += 1
                    }}
                    onkeydown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            chara.chatFolders[i].folded = !folder.folded
                            $ReloadGUIPointer += 1
                        }
                    }}
                    class="chat-folder-header flex min-w-0 items-center text-textcolor border-0 p-2 cursor-pointer rounded-md {folderColorStyle.fill}"
                >
                    <InlineEditableName
                        controller={renameController}
                        bind:value={chara.chatFolders[i].name}
                        onActivate={() => {
                            chara.chatFolders[i].folded = !folder.folded
                            $ReloadGUIPointer += 1
                        }}
                    />
                    <IconButtonGroup className="no-sort ml-3 shrink-0" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
                        <InlineRenameAction controller={renameController} />
                        <IconButton onclick={async () => {
                            const remoteVisibilityLabel = folder.localOnly
                                ? language.showFolderOnRemoteAccess
                                : language.hideFolderOnRemoteAccess
                            const sel = parseInt(await alertSelect([language.changeFolderColor, remoteVisibilityLabel, language.cancel]))
                            switch (sel) {
                                case 0:
                                    const colorSelection = parseInt(await alertSelect(
                                        folderColorOptions.map(({ label }) => label)
                                    ))
                                    const selectedColor = folderColorOptions[colorSelection]?.value
                                    if (selectedColor) {
                                        folder.color = selectedColor
                                    }
                                    break
                                case 1:
                                    folder.localOnly = !folder.localOnly
                                    break
                            }
                        }}>
                            <MenuIcon />
                        </IconButton>
                        <IconButton tone="destructive" onclick={async () => {
                            const d = await alertConfirm(`${language.removeConfirm}${folder.name}`)
                            if (d) {
                                $ReloadGUIPointer += 1
                                const folders = chara.chatFolders
                                folders.splice(i, 1)
                                chara.chats.forEach(chat => {
                                    if (chat.folderId == folder.id) {
                                        chat.folderId = null
                                    }
                                })
                                chara.chatFolders = folders
                            }
                        }}>
                            <TrashIcon />
                        </IconButton>
                    </IconButtonGroup>
                </div>
                <!-- chats in folder -->
                <ShSortableList
                    className="risu-chat flex flex-col w-full text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md {folder.folded ? 'hidden' : ''}"
                    draggable="[data-sortable-chat-id]"
                    dataAttribute="data-sortable-chat-id"
                    dragPreviewText={(chatId) => chara.chats.find(chat => chat.id === chatId)?.name}
                    options={{ group: 'chats' }}
                    onReorder={syncChatOrderFromDom}
                >
                    {#if chara.chats.filter(chat => chat.folderId == chara.chatFolders[i].id).length == 0}
                    <span class="no-sort flex justify-center text-textcolor2">Empty</span>
                    <div></div>
                    {:else}
                    {#each chara.chats.filter(chat => chat.folderId == chara.chatFolders[i].id) as chat (chat.id)}
                    {@const chatIdx = chara.chats.indexOf(chat)}
                    {@const renameController = new InlineEditableNameController()}
                    <div role="button" tabindex="0" data-inline-rename-row data-risu-chat-idx={chatIdx} data-sortable-chat-id={chat.id} data-sortable-no-scale onclick={() => changeChatTo(chatIdx)} onkeydown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            changeChatTo(chatIdx)
                        }
                    }} class="risu-selectable-row risu-chats flex min-w-0 items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md" data-selected={chatIdx === chara.chatPage && !$chatDeselected}>
                        <InlineEditableName controller={renameController} bind:value={chat.name} onActivate={() => changeChatTo(chatIdx)} />
                        <IconButtonGroup className="no-sort ml-3 shrink-0" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
                            <InlineRenameAction controller={renameController} />
                            <IconButton onclick={async () => {
                                const confirmed = await alertConfirm(`${language.copyChatConfirm}${chat.name}`)
                                if(!confirmed) return
                                const chatIdx = chara.chats.indexOf(chat)
                                if(chara.chats[chatIdx]?._placeholder){
                                    await ensureChatHydrated(chara.chats, chatIdx, (chara as character).chaId)
                                }
                                if(chara.chats[chatIdx]?._placeholder){
                                    alertError('Failed to load chat data.')
                                    return
                                }
                                try {
                                    await createPersistedChatCopy(chara, chara.chats[chatIdx], 'Copy')
                                    notifySuccess(language.copyChatSuccess)
                                } catch (error) {
                                    alertError(error)
                                }
                            }}>
                                <CopyIcon />
                            </IconButton>
                            <IconButton onclick={() => {
                                exportChat(chara.chats.indexOf(chat))
                            }}>
                                <DownloadIcon />
                            </IconButton>
                            <IconButton tone="destructive" onclick={async () => {
                                if(chara.chats.length === 1){
                                    notifyError(language.errors.onlyOneChat)
                                    return
                                }
                                const d = await alertConfirm(`${language.removeConfirm}${chat.name}`)
                                if(d){
                                    changeChatTo(0)
                                    $ReloadGUIPointer += 1
                                    let chats = chara.chats
                                    chats.splice(chara.chats.indexOf(chat), 1)
                                    chara.chats = chats
                                    void requestImmediateSave()
                                }
                            }}>
                                <TrashIcon />
                            </IconButton>
                        </IconButtonGroup>
                    </div>
                    {/each}
                    {/if}
                </ShSortableList>
            </div>
            {/each}
        </ShSortableList>
        <!-- chat without folder div -->
        <ShSortableList
            className="risu-chat flex flex-col"
            draggable="[data-sortable-chat-id]"
            dataAttribute="data-sortable-chat-id"
            dragPreviewText={(chatId) => chara.chats.find(chat => chat.id === chatId)?.name}
            options={{ group: 'chats' }}
            onReorder={syncChatOrderFromDom}
        >
            {#each chara.chats as chat, i (chat.id)}
            {@const renameController = new InlineEditableNameController()}
            {#if chat.folderId == null || isOrphanFolder(chat.folderId)}
            <div role="button" tabindex="0" data-inline-rename-row data-risu-chat-idx={i} data-sortable-chat-id={chat.id} data-sortable-no-scale onclick={() => changeChatTo(i)} onkeydown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    changeChatTo(i)
                }
            }}
            class="risu-selectable-row flex min-w-0 items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
            data-selected={i === chara.chatPage && !$chatDeselected}>
                <InlineEditableName controller={renameController} bind:value={chara.chats[i].name} onActivate={() => changeChatTo(i)} />
                <IconButtonGroup className="no-sort ml-3 shrink-0" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
                    <InlineRenameAction controller={renameController} />
                    <IconButton onclick={async () => {
                        const confirmed = await alertConfirm(`${language.copyChatConfirm}${chat.name}`)
                        if(!confirmed) return
                        if(chara.chats[i]?._placeholder){
                            await ensureChatHydrated(chara.chats, i, (chara as character).chaId)
                        }
                        if(chara.chats[i]?._placeholder){
                            alertError('Failed to load chat data.')
                            return
                        }
                        try {
                            await createPersistedChatCopy(chara, chara.chats[i], 'Copy')
                            notifySuccess(language.copyChatSuccess)
                        } catch (error) {
                            alertError(error)
                        }
                    }}>
                        <CopyIcon />
                    </IconButton>
                    <IconButton onclick={() => {
                        exportChat(i)
                    }}>
                        <DownloadIcon />
                    </IconButton>
                    <IconButton tone="destructive" onclick={async () => {
                        if(chara.chats.length === 1){
                            notifyError(language.errors.onlyOneChat)
                            return
                        }
                        const d = await alertConfirm(`${language.removeConfirm}${chat.name}`)
                        if(d){
                            changeChatTo(0)
                            $ReloadGUIPointer += 1
                            let chats = chara.chats
                            chats.splice(i, 1)
                            chara.chats = chats
                            void requestImmediateSave()
                        }
                    }}>
                        <TrashIcon />
                    </IconButton>
                </IconButtonGroup>
            </div>
            {/if}
            {/each}
        </ShSortableList>
    </div>

    <div class="border-t border-selected mt-2">
        <IconButtonGroup className="mt-2">
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
        </IconButtonGroup>

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
                <ShButton className="w-full mt-2" onclick={() => {
                    const char = DBState.db.characters[$selectedCharID]
                    if (!char) return
                    char.chats[char.chatPage].modules ??= []
                    openModuleListStore.set(true)
                }}>
                    <PackageIcon class="shrink-0" />
                    <span class="truncate">{language.modules}</span>
                </ShButton>
            {/if}
        {/if}
    </div>
</div>
