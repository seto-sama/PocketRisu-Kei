<script lang="ts">
    import { DynamicGUI, settingsOpen, sideBarClosing, sideBarStore, openPresetList, openModelPresetList, requestPreviewOpen, openModelProfileBrowser, openPersonaList, personaSelectCallback, openHypaV3PresetList, openThemePresetList, loadedStore, alertStore, LoadingStatusState, bookmarkListOpen, popupStore, popUpEditorStore, selectedCharID } from './ts/stores.svelte';
    import Sidebar from './lib/SideBars/Sidebar.svelte';
    import { DBState } from './ts/stores.svelte';
    import ChatScreen from './lib/ChatScreens/ChatScreen.svelte';
    import AlertComp from './lib/Others/AlertComp.svelte';
    import RealmPopUp from './lib/UI/Realm/RealmPopUp.svelte';
    import FolderSettingsDialog from './lib/SideBars/FolderSettingsDialog.svelte';
    import GridChars from './lib/Others/GridCatalog.svelte';
    import Dialog from './lib/UI/components/Dialog.svelte';
    import BookmarkList from './lib/Others/BookmarkList.svelte';
    import Settings from './lib/Setting/Settings.svelte';
    import { showRealmInfoStore, importCharacterProcess } from './ts/characterCards';
    import { importPreset, getDatabase, setDatabase } from './ts/storage/database.svelte';
    import { readModule } from './ts/process/modules';
    import { notifySuccess } from './ts/alert';
    import { language } from './lang';
    import SavePopupIconComp from './lib/Others/SavePopupIcon.svelte';
    import Botpreset from './lib/Setting/botpreset.svelte';
    import QuickModelPresetPicker from './lib/UI/QuickModelPresetPicker.svelte';
    import RequestPreviewModal from './lib/Others/RequestPreviewModal.svelte';
    import ModelProfileBrowser from './lib/Setting/modelProfileBrowser.svelte';
    import Themepreset from './lib/Setting/themepreset.svelte';
    import ListedPersona from './lib/Setting/listedPersona.svelte';
    import ListedHypaV3Preset from './lib/Setting/listedHypaV3Preset.svelte';
    import { checkCharOrder } from './ts/globalApi.svelte';
    import { hypaV3ProgressStore } from "./ts/stores.svelte";
    import HypaV3Modal from './lib/Others/HypaV3Modal.svelte';
    import HypaV3Progress from './lib/Others/HypaV3Progress.svelte';
    import PluginAlertModal from './lib/Others/PluginAlertModal.svelte';
    import PopupEditor from './lib/Others/PopupEditor.svelte';
    import UpdatePopup from './lib/Others/UpdatePopup.svelte';
    import BootBackupPrompt from './lib/Others/BootBackupPrompt.svelte';
    import PluginMemoryPrompt from './lib/Others/PluginMemoryPrompt.svelte';
    import PopupList from './lib/UI/PopupList.svelte';
    import LoadingOverlay from './lib/Others/LoadingOverlay.svelte';
    import Toaster from './lib/UI/components/Toaster.svelte';
    import RequestStatusToaster from './lib/UI/components/RequestStatusToaster.svelte';
    import sendSound from './etc/send.mp3'
    import { ensureBookmarkCatalog } from './ts/bookmarks/bookmarkService'

    let gridOpen = $state(false)
    let keepingSessionAlive = $state(false)

    function openCharacterGrid() {
        gridOpen = true
        if ($DynamicGUI) sideBarStore.set(false)
    }

    function focusOverlay(node: HTMLElement) {
        let active = true
        queueMicrotask(() => {
            if (active) node.focus({ preventScroll: true })
        })
        return {
            destroy() {
                active = false
            },
        }
    }

    $effect(() => {
        if ($loadedStore) {
            void ensureBookmarkCatalog().catch(error => {
                console.error('[bookmarks] Initial catalog load failed', error)
            })
        }
    })

    $effect(() => {
        if (!$DynamicGUI || !$settingsOpen) return
        sideBarClosing.set(false)
        sideBarStore.set(false)
    })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main class="flex bg-lightbg w-full h-full max-w-100vw text-maintext" ondragover={(e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'link'
}} ondrop={async (e) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('application/x-risu-internal')) {
        return
    }
    const file = e.dataTransfer.files[0]
    if (file) {
        const name = file.name.toLowerCase()

        if (name.endsWith('.risup')) {
            const data = new Uint8Array(await file.arrayBuffer())
            await importPreset({ name: file.name, data })
            notifySuccess(language.successImport)
        } else if (name.endsWith('.risum')) {
            const data = new Uint8Array(await file.arrayBuffer())
            const module = await readModule(Buffer.from(data))
            const db = getDatabase()
            db.modules.push(module)
            notifySuccess(language.successImport)
        } else {
            await importCharacterProcess({
                name: file.name,
                data: file
            })
            checkCharOrder()
        }
    }
}} onclick={() => {
    if(keepingSessionAlive){
        return
    }

    if(DBState?.db?.keepSessionAlive){
        console.log("Starting silent audio to keep session alive")
        const silentAudio = new Audio(sendSound);
        silentAudio.loop = true;
        silentAudio.volume = 0.000001;
        silentAudio.play();
        keepingSessionAlive = true;
    }
}}>
    {#if !$loadedStore}
        <div class="w-full h-full flex justify-center items-center text-maintext text-xl bg-lightbg flex-col">
            <div class="flex flex-row items-center">
                <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-maintext" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <span>Loading...</span>
            </div>

            <span class="text-sm mt-2 text-subtext">{LoadingStatusState.text}</span>
        </div>
    {:else}
        <div
            class="risu-local-stack relative flex h-full w-full min-w-0"
            inert={$settingsOpen}
            aria-hidden={$settingsOpen}
        >
            {#if !$DynamicGUI}
                <Sidebar
                    openGrid={openCharacterGrid}
                    onNavigate={() => {gridOpen = false}}
                    hidden={!$sideBarStore}
                />
            {/if}
            <ChatScreen />
        </div>

        {#if !$settingsOpen}
            <Dialog
                bind:open={gridOpen}
                size="xl"
                closable={false}
                ariaLabel={language.characterList}
                contentClass="h-[90dvh] overflow-hidden bg-lightbg p-0 gap-0"
                bodyClass="flex min-h-0 grow overflow-hidden"
            >
                <GridChars endGrid={() => {gridOpen = false}} />
            </Dialog>
        {/if}

        {#if $settingsOpen}
            <div
                class="risu-layer-local-focus fixed inset-0 h-dvh w-full overflow-hidden bg-lightbg outline-none"
                tabindex="-1"
                use:focusOverlay
            >
                <Settings />
            </div>
        {/if}

        {#if $DynamicGUI}
            <div
                class="risu-layer-local-focus inset-0 h-dvh w-full flex-row items-center"
                class:fixed={$sideBarStore}
                class:flex={$sideBarStore}
                class:hidden={!$sideBarStore}
            >
                <Sidebar
                    openGrid={openCharacterGrid}
                    onNavigate={() => {gridOpen = false}}
                    hidden={false}
                />
            </div>
        {/if}
    {/if}
    <FolderSettingsDialog />
    <AlertComp />
    {#if $showRealmInfoStore}
        <RealmPopUp bind:openedData={$showRealmInfoStore} />
    {/if}
    {#if $openPresetList}
        <Botpreset close={() => {$openPresetList = false}} />
    {/if}
    {#if $openModelPresetList}
        <QuickModelPresetPicker bind:open={$openModelPresetList} />
    {/if}
    {#if $requestPreviewOpen}
        <RequestPreviewModal bind:open={$requestPreviewOpen} />
    {/if}
    {#if $openModelProfileBrowser}
        <ModelProfileBrowser close={() => {$openModelProfileBrowser = false}} />
    {/if}
    {#if $openThemePresetList}
        <Themepreset close={() => {$openThemePresetList = false}} />
    {/if}
    {#if $openPersonaList}
        <ListedPersona close={() => {$openPersonaList = false; $personaSelectCallback = null}} onSelect={$personaSelectCallback} />
    {/if}
    {#if $openHypaV3PresetList}
        <ListedHypaV3Preset close={() => {$openHypaV3PresetList = false}} />
    {/if}
    {#if $bookmarkListOpen}
        <BookmarkList />
    {/if}
    <!-- Keep the modal mounted while a chat is selected so work/results survive closing it. -->
    {#if $selectedCharID >= 0 && DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID].chatPage]}
        {#key `${$selectedCharID}:${DBState.db.characters[$selectedCharID].chatPage}:${DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].id ?? ''}`}
            <HypaV3Modal />
        {/key}
    {/if}
    <SavePopupIconComp />
    {#if $hypaV3ProgressStore.open}
        <HypaV3Progress />
    {/if}
    <PluginAlertModal />
    <LoadingOverlay />
    <UpdatePopup />
    <BootBackupPrompt />
    <PluginMemoryPrompt />
    {#if popupStore.children}
        <PopupList />
    {/if}
    {#if popUpEditorStore.open}
        <PopupEditor />
    {/if}
    <Toaster />
    <RequestStatusToaster />
</main>
