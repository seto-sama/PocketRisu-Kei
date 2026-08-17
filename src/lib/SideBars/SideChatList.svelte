<script lang="ts">
    import { v4 } from "uuid";
    import { DownloadIcon, PencilIcon, HardDriveUploadIcon, MenuIcon, TrashIcon, SplitIcon, FolderPlusIcon, BookmarkCheckIcon, PackageIcon, CopyIcon } from "@lucide/svelte";

    import type { Chat, ChatFolder, character } from "src/ts/storage/database.svelte";
    import { newChatModelDefaults } from "src/ts/storage/database.svelte";
    import { ensureChatHydrated } from "src/ts/storage/chatStorage";
    import { DBState, ReloadGUIPointer } from 'src/ts/stores.svelte';
    import { selectedCharID, chatDeselected } from "src/ts/stores.svelte";

    import ShButton from "../UI/GUI/ShButton.svelte";
    import ShSortableList from "../UI/GUI/ShSortableList.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import IconButton from "../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";

    import { exportChat, importChat, exportAllChats } from "src/ts/characters";
    import { alertConfirm, alertError, alertSelect, alertStore, notifySuccess, notifyError } from "src/ts/alert";

    import { bookmarkListOpen, openModuleListStore } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import Toggles from "./Toggles.svelte";
    import PersonaBind from "./PersonaBind.svelte";
    import PromptBind from "./PromptBind.svelte";
    import ModelBind from "./ModelBind.svelte";
    import { changeChatTo, createChatCopyName, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { folderColorOptions, getFolderColorStyle } from "./folderColors";

    interface Props {
        chara: character;
    }

    let { chara = $bindable() }: Props = $props();
    let editMode = $state(false)

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
</script>
<div class="flex flex-col w-full">
    <ShButton className="relative bottom-2 h-10 min-h-10 w-full" onclick={() => {
        const len = chara.chats.length
        let chats = chara.chats
        const newChat = {
            message:[] as any[], note:'', name:`New Chat ${len + 1}`, localLore:[] as any[], fmIndex: -1, id: v4(),
            ...newChatModelDefaults()
        }
        chats.unshift(newChat)
        chara.chats = chats
        changeChatTo(0)
        void requestImmediateSave()
        $ReloadGUIPointer += 1
    }}>{language.newChat}</ShButton>

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
            <div data-sortable-key={folder.id} data-risu-chat-folder-id={folder.id}
                class="flex flex-col mb-2 border-solid border-1 cursor-pointer rounded-md {folderColorStyle.border}">
                <!-- folder header -->
                <button 
                    onclick={() => {
                        if(!editMode) {
                            chara.chatFolders[i].folded = !folder.folded
                            $ReloadGUIPointer += 1
                        }
                    }}
                    class="chat-folder-header flex min-w-0 items-center text-textcolor border-0 p-2 cursor-pointer rounded-md {folderColorStyle.fill}"
                >
                    {#if editMode}
                        <div class="min-w-0 grow">
                            <TextInput bind:value={chara.chatFolders[i].name} className="h-6 min-w-0 px-2" padding={false} fullwidth/>
                        </div>
                    {:else}
                        <span class="truncate grow text-left">{folder.name}</span>
                    {/if}
                    <div class="no-sort ml-3 flex shrink-0 items-center gap-2">
                        <div role="button" tabindex="0" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                e.currentTarget.click()
                            }
                        }} class="text-textcolor2 risu-interactive-accent cursor-pointer" onclick={async (e) => {
                            e.stopPropagation()
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
                            <MenuIcon size={18}/>
                        </div>
                        <div role="button" tabindex="0" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                e.currentTarget.click()
                            }
                        }} class="text-textcolor2 risu-interactive-danger cursor-pointer" onclick={async (e) => {
                            e.stopPropagation()
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
                            <TrashIcon size={18}/>
                        </div>
                    </div>
                </button>
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
                    <button data-risu-chat-idx={chatIdx} data-sortable-chat-id={chat.id} data-sortable-no-scale onclick={() => {
                        if(!editMode){
                            changeChatTo(chatIdx)
                        }
                    }} class="risu-chats flex min-w-0 items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"class:bg-selected={chatIdx === chara.chatPage && !$chatDeselected}>
                        {#if editMode}
                            <div class="min-w-0 grow">
                                <TextInput bind:value={chat.name} className="h-6 min-w-0 px-2" padding={false} fullwidth/>
                            </div>
                        {:else}
                            <span class="truncate grow text-left">{chat.name}</span>
                        {/if}
                        <div class="no-sort ml-3 flex shrink-0 items-center gap-2">
                            <div role="button" tabindex="0" onkeydown={(e) => {
                                if(e.key === 'Enter'){
                                    e.currentTarget.click()
                                }
                            }} class="text-textcolor2 risu-interactive-accent cursor-pointer" onclick={async (e) => {
                                e.stopPropagation()
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
                                const newChat = $state.snapshot(chara.chats[chatIdx])
                                newChat.name = createChatCopyName(newChat.name, 'Copy')
                                newChat.id = v4()
                                chara.chats.unshift(newChat)
                                changeChatTo(0)
                                chara.chats = chara.chats
                                void requestImmediateSave()
                                notifySuccess(language.copyChatSuccess)
                            }}>
                                <CopyIcon size={18}/>
                            </div>
                            <div role="button" tabindex="0" onkeydown={(e) => {
                                if(e.key === 'Enter'){
                                    e.currentTarget.click()
                                }
                            }} class="text-textcolor2 risu-interactive-accent cursor-pointer" onclick={async (e) => {
                                e.stopPropagation()
                                exportChat(chara.chats.indexOf(chat))
                            }}>
                                <DownloadIcon size={18}/>
                            </div>
                            <div role="button" tabindex="0" onkeydown={(e) => {
                                if(e.key === 'Enter'){
                                    e.currentTarget.click()
                                }
                            }} class="text-textcolor2 risu-interactive-danger cursor-pointer" onclick={async (e) => {
                                e.stopPropagation()
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
                                <TrashIcon size={18}/>
                            </div>
                        </div>
                    </button>
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
            {#if chat.folderId == null || isOrphanFolder(chat.folderId)}
            <button data-risu-chat-idx={i} data-sortable-chat-id={chat.id} data-sortable-no-scale onclick={() => {
                if(!editMode){
                    changeChatTo(i)
                }
            }}
            class="flex min-w-0 items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
            class:bg-selected={i === chara.chatPage && !$chatDeselected}>
                {#if editMode}
                    <div class="min-w-0 grow">
                        <TextInput bind:value={chara.chats[i].name} className="h-6 min-w-0 px-2" padding={false} fullwidth/>
                    </div>
                {:else}
                    <span class="truncate grow text-left">{chat.name}</span>
                {/if}
                <div class="no-sort ml-3 flex shrink-0 items-center gap-2">
                    <div role="button" tabindex="0" onkeydown={(e) => {
                        if(e.key === 'Enter'){
                            e.currentTarget.click()
                        }
                    }} class="text-textcolor2 risu-interactive-accent cursor-pointer" onclick={async (e) => {
                        e.stopPropagation()
                        const confirmed = await alertConfirm(`${language.copyChatConfirm}${chat.name}`)
                        if(!confirmed) return
                        if(chara.chats[i]?._placeholder){
                            await ensureChatHydrated(chara.chats, i, (chara as character).chaId)
                        }
                        if(chara.chats[i]?._placeholder){
                            alertError('Failed to load chat data.')
                            return
                        }
                        const newChat = $state.snapshot(chara.chats[i])
                        newChat.name = createChatCopyName(newChat.name, 'Copy')
                        newChat.id = v4()
                        chara.chats.unshift(newChat)
                        changeChatTo(0)
                        chara.chats = chara.chats
                        void requestImmediateSave()
                        notifySuccess(language.copyChatSuccess)
                    }}>
                        <CopyIcon size={18}/>
                    </div>
                    <div role="button" tabindex="0" onkeydown={(e) => {
                        if(e.key === 'Enter'){
                            e.currentTarget.click()
                        }
                    }} class="text-textcolor2 risu-interactive-accent cursor-pointer" onclick={async (e) => {
                        e.stopPropagation()
                        exportChat(i)
                    }}>
                        <DownloadIcon size={18}/>
                    </div>
                    <div role="button" tabindex="0" onkeydown={(e) => {
                        if(e.key === 'Enter'){
                            e.currentTarget.click()
                        }
                    }} class="text-textcolor2 risu-interactive-danger cursor-pointer" onclick={async (e) => {
                        e.stopPropagation()
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
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
            {/if}
            {/each}
        </ShSortableList>
    </div>

    <div class="border-t border-selected mt-2">
        <IconButtonGroup className="mt-2 ml-2">
            <IconButton onclick={() => {
                exportAllChats()
            }}>
                <DownloadIcon />
            </IconButton>
            <IconButton onclick={() => {
                importChat()
            }}>
                <HardDriveUploadIcon />
            </IconButton>
            <IconButton active={editMode} onclick={() => {
                editMode = !editMode
            }}>
                <PencilIcon />
            </IconButton>
            <IconButton onclick={() => {
                alertStore.set({
                  type: "branches",
                  msg: ""
                })
            }}>
                <SplitIcon />
            </IconButton>
            <IconButton onclick={() => {
                $bookmarkListOpen = true;
            }}>
                <BookmarkCheckIcon />
            </IconButton>
            <IconButton className="ml-auto mr-2" onclick={() => {
                if (!chara.chatFolders) {
                    chara.chatFolders = []
                }
                const folders = chara.chatFolders
                const length = chara.chatFolders.length
                folders.unshift({
                    id: v4(),
                    name: `New Folder ${length + 1}`,
                    folded: false,
                })
                chara.chatFolders = folders
                $ReloadGUIPointer += 1
            }}>
                <FolderPlusIcon />
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
