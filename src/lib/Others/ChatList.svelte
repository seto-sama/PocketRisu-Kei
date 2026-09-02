<script>
    import { alertConfirm, notifyError } from "../../ts/alert";
    import { language } from "../../lang";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { newChatModelDefaults } from 'src/ts/storage/database.svelte';
    import { ReloadGUIPointer, selectedCharID } from "../../ts/stores.svelte";
    import { DownloadIcon, SquarePenIcon, HardDriveUploadIcon, PlusIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { exportChat, importChat } from "../../ts/characters";
    import { findCharacterbyId } from "../../ts/util";
    import InlineNameInput from "../UI/GUI/InlineNameInput.svelte";
    import { changeChatTo, createPersistedChat, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { v4 } from "uuid";
    import IconButton from "../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";
    import OverlayPortal from "../UI/GUI/OverlayPortal.svelte";

    let editMode = $state(false)
    /** @type {{close?: any}} */
    let { close = () => {} } = $props();
</script>

<OverlayPortal>
<div class="risu-modal-backdrop risu-layer-overlay flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-72 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.chatList}</h2>
            <div class="grow flex justify-end">
                <IconButton size="lg" onclick={close}><XIcon /></IconButton>
            </div>
        </div>
        {#each DBState.db.characters[$selectedCharID].chats as chat, i}
            <button onclick={() => {
                if(!editMode){
                    changeChatTo(i)
                    close()
                }
            }} class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer" class:bg-selected={i === DBState.db.characters[$selectedCharID].chatPage}>
                {#if editMode}
                    <InlineNameInput bind:value={DBState.db.characters[$selectedCharID].chats[i].name} />
                {:else}
                    <span>{chat.name}</span>
                {/if}
                <div class="grow flex justify-end">
                    <div class="text-textcolor2 risu-interactive-accent mr-2 cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        exportChat(i)
                    }} onkeydown={() => {

                    }}>
                        <DownloadIcon size={18}/>
                    </div>
                    <div class="text-textcolor2 risu-interactive-danger cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        if(DBState.db.characters[$selectedCharID].chats.length === 1){
                            notifyError(language.errors.onlyOneChat)
                            return
                        }
                        const d = await alertConfirm(`${language.removeConfirm}${chat.name}`)
                        if(d){
                            changeChatTo(0)
                            let chats = DBState.db.characters[$selectedCharID].chats
                            chats.splice(i, 1)
                            DBState.db.characters[$selectedCharID].chats = chats
                            void requestImmediateSave()
                        }
                    }} onkeydown={() => {
                        
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
        {/each}
        <IconButtonGroup className="mt-2">
            <IconButton onclick={async () => {
                const len = DBState.db.characters[$selectedCharID].chats.length
                const newChat = {
                    message:[], note:'', name:`New Chat ${len + 1}`, localLore:[], fmIndex: -1, id: v4(),
                    ...newChatModelDefaults()
                }
                try {
                    await createPersistedChat(
                        DBState.db.characters[$selectedCharID],
                        newChat,
                    )
                    close()
                } catch (error) {
                    notifyError(error instanceof Error ? error.message : String(error))
                }
            }}>
                <PlusIcon/>
            </IconButton>
            <IconButton onclick={() => {
                importChat()
            }}>
                <HardDriveUploadIcon />
            </IconButton>
            <IconButton active={editMode} onclick={() => {
                editMode = !editMode
            }}>
                <SquarePenIcon />
            </IconButton>
        </IconButtonGroup>
    </div>
</div>
</OverlayPortal>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
