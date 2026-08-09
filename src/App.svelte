<script lang="ts">
    import { DynamicGUI, settingsOpen, sideBarStore, openPresetList, openModelPresetList, openModelProfileBrowser, openPersonaList, personaSelectCallback, openHypaV3PresetList, openThemePresetList, MobileGUI, loadedStore, alertStore, LoadingStatusState, bookmarkListOpen, popupStore, popUpEditorStore } from './ts/stores.svelte';
    import Sidebar from './lib/SideBars/Sidebar.svelte';
    import { DBState } from './ts/stores.svelte';
    import ChatScreen from './lib/ChatScreens/ChatScreen.svelte';
    import AlertComp from './lib/Others/AlertComp.svelte';
    import RealmPopUp from './lib/UI/Realm/RealmPopUp.svelte';
    import GridChars from './lib/Others/GridCatalog.svelte';
    import BookmarkList from './lib/Others/BookmarkList.svelte';
    import Settings from './lib/Setting/Settings.svelte';
    import { showRealmInfoStore, importCharacterProcess } from './ts/characterCards';
    import { importPreset, getDatabase, setDatabase } from './ts/storage/database.svelte';
    import { readModule } from './ts/process/modules';
    import { notifySuccess } from './ts/alert';
    import { language } from './lang';
    import SavePopupIconComp from './lib/Others/SavePopupIcon.svelte';
    import Botpreset from './lib/Setting/botpreset.svelte';
    import Modelpreset from './lib/Setting/modelpreset.svelte';
    import ModelProfileBrowser from './lib/Setting/modelProfileBrowser.svelte';
    import Themepreset from './lib/Setting/themepreset.svelte';
    import ListedPersona from './lib/Setting/listedPersona.svelte';
    import ListedHypaV3Preset from './lib/Setting/listedHypaV3Preset.svelte';
    import MobileHeader from './lib/Mobile/MobileHeader.svelte';
    import MobileBody from './lib/Mobile/MobileBody.svelte';
    import MobileFooter from './lib/Mobile/MobileFooter.svelte';
    import { checkCharOrder } from './ts/globalApi.svelte';
    import { hypaV3ModalOpen, hypaV3ProgressStore } from "./ts/stores.svelte";
    import HypaV3Modal from './lib/Others/HypaV3Modal.svelte';
    import HypaV3Progress from './lib/Others/HypaV3Progress.svelte';
    import PluginAlertModal from './lib/Others/PluginAlertModal.svelte';
    import PopupEditor from './lib/Others/PopupEditor.svelte';
    import UpdatePopup from './lib/Others/UpdatePopup.svelte';
    import BootBackupPrompt from './lib/Others/BootBackupPrompt.svelte';
    import PopupList from './lib/UI/PopupList.svelte';
    import LoadingOverlay from './lib/Others/LoadingOverlay.svelte';
    import Toaster from './lib/UI/GUI/Toaster.svelte';
    import RequestStatusToaster from './lib/UI/GUI/RequestStatusToaster.svelte';
    import sendSound from './etc/send.mp3'

    let gridOpen = $state(false)
    let keepingSessionAlive = $state(false)

    function openCharacterGrid() {
        gridOpen = true
        sideBarStore.set(false)
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main class="flex bg-bg w-full h-full max-w-100vw text-textcolor" ondragover={(e) => {
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
        <div class="w-full h-full flex justify-center items-center text-textcolor text-xl bg-gray-900 flex-col">
            <div class="flex flex-row items-center">
                <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-textcolor" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <span>Loading...</span>
            </div>

            <span class="text-sm mt-2 text-textcolor2">{LoadingStatusState.text}</span>
        </div>
    {:else if $settingsOpen}
        <Settings />
    {:else if $MobileGUI}
        <div class="w-full h-full flex flex-col" style="touch-action: pan-y pinch-zoom;">
            <MobileHeader />
            <MobileBody />
            <MobileFooter />
        </div>
    {:else}
        {#if (!$DynamicGUI)}
            <Sidebar
                openGrid={openCharacterGrid}
                onNavigate={() => {gridOpen = false}}
                hidden={!$sideBarStore}
            />
        {:else}
            <div class="top-0 w-full h-full left-0 z-30 flex flex-row items-center" class:fixed={$sideBarStore} class:hidden={!$sideBarStore} >
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <Sidebar
                    openGrid={openCharacterGrid}
                    onNavigate={() => {gridOpen = false}}
                    hidden={false}
                />
            </div>
        {/if}
        {#if gridOpen}
            <GridChars endGrid={() => {gridOpen = false}} />
        {:else}
            <ChatScreen />
        {/if}
    {/if}
    <AlertComp />
    {#if $showRealmInfoStore}
        <RealmPopUp bind:openedData={$showRealmInfoStore} />
    {/if}
    {#if $openPresetList}
        <Botpreset close={() => {$openPresetList = false}} />
    {/if}
    {#if $openModelPresetList}
        <Modelpreset close={() => {$openModelPresetList = false}} />
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
    {#if $hypaV3ModalOpen}
        <HypaV3Modal />
    {/if}
    <SavePopupIconComp />
    {#if $hypaV3ProgressStore.open}
        <HypaV3Progress />
    {/if}
    <PluginAlertModal />
    <LoadingOverlay />
    <UpdatePopup />
    <BootBackupPrompt />
    {#if popupStore.children}
        <PopupList />
    {/if}
    {#if popUpEditorStore.open}
        <PopupEditor />
    {/if}
    <Toaster />
    <RequestStatusToaster />
</main>
