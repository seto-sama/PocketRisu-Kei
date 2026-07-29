<script lang="ts">
    
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from "../../../lang";
    import { DownloadIcon, HardDriveUploadIcon, PlusIcon, SunIcon, LinkIcon, FolderPlusIcon, PencilIcon } from "@lucide/svelte";
    import { addLorebook, addLorebookFolder, exportLoreBook, importLoreBook } from "../../../ts/process/lorebook.svelte";
    import NumberInput from "../../UI/GUI/NumberInput.svelte";
    import ShSettings from "../../UI/GUI/ShSettings.svelte";
    import ShSwitch from "../../UI/GUI/ShSwitch.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { selectedCharID } from "src/ts/stores.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";

    let submenu = $state(0)
    let listEditMode = $state(false)

    function isAllCharacterLoreAlwaysActive() {
        const globalLore = DBState.db.characters[$selectedCharID].globalLore;
        return globalLore && globalLore.every((book) => book.alwaysActive);
    }

    function isAllChatLoreAlwaysActive() {
        const localLore = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore;
        return localLore && localLore.every((book) => book.alwaysActive);
    }

    function toggleCharacterLoreAlwaysActive() {
        const globalLore = DBState.db.characters[$selectedCharID].globalLore;

        if (!globalLore) return;
        
        const allActive = globalLore.every((book) => book.alwaysActive);
        
        globalLore.forEach((book) => {
            book.alwaysActive = !allActive;
        });
    }

    function toggleChatLoreAlwaysActive() {
        const localLore = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore;

        if (!localLore) return;

        const allActive = localLore.every((book) => book.alwaysActive);

        localLore.forEach((book) => {
            book.alwaysActive = !allActive;
        });
    }

    function setUseGlobalSettings(useGlobal: boolean) {
        if(useGlobal){
            DBState.db.characters[$selectedCharID].loreSettings = undefined
            return
        }

        DBState.db.characters[$selectedCharID].loreSettings = {
            tokenBudget: DBState.db.loreBookToken,
            scanDepth: DBState.db.loreBookDepth,
            recursiveScanning: false,
            fullWordMatching: false,
        }
    }
</script>

<div class="flex w-full rounded-md border border-selected">
    <button onclick={() => {
        submenu = 0
    }} class="flex min-h-10 flex-1 items-center justify-center p-2" class:bg-selected={submenu === 0}>
        <span>{language.character}</span>
    </button>
    <button onclick={() => {
        submenu = 1
    }} class="flex min-h-10 flex-1 items-center justify-center border-r border-l border-selected p-2" class:bg-selected={submenu === 1}>
        <span>{language.Chat}</span>
    </button>
    <button onclick={() => {
        submenu = 2
    }} class="flex min-h-10 flex-1 items-center justify-center p-2" class:bg-selected={submenu === 2}>
        <span>{language.settings}</span>
    </button>
</div>
{#if submenu !== 2}
    <span class="text-textcolor2 mt-2 text-sm">{submenu === 0 ? language.globalLoreInfo : language.localLoreInfo}</span>
    <LoreBookList submenu={submenu} bind:listEditMode />
{:else}
    <ShSettings spacing="divided" className="mt-4">
        <ShSettings variant="row">
            <span class="min-w-0 text-textcolor">{language.useGlobalSettings}</span>
            <ShSwitch
                checked={!DBState.db.characters[$selectedCharID].loreSettings}
                onCheckedChange={setUseGlobalSettings}
            />
        </ShSettings>
        {#if DBState.db.characters[$selectedCharID].loreSettings}
            <ShSettings variant="row">
                <span class="min-w-0 text-textcolor">{language.recursiveScanning}</span>
                <ShSwitch bind:checked={DBState.db.characters[$selectedCharID].loreSettings.recursiveScanning}/>
            </ShSettings>
            <ShSettings variant="row">
                <span class="min-w-0 text-textcolor">{language.fullWordMatching}</span>
                <ShSwitch bind:checked={DBState.db.characters[$selectedCharID].loreSettings.fullWordMatching}/>
            </ShSettings>
            <ShSettings variant="row">
                <span class="min-w-0 text-textcolor">{language.loreBookDepth}</span>
                <NumberInput className="w-24" min={0} max={20} bind:value={DBState.db.characters[$selectedCharID].loreSettings.scanDepth} />
            </ShSettings>
            <ShSettings variant="row">
                <span class="min-w-0 text-textcolor">{language.loreBookToken}</span>
                <NumberInput className="w-24" min={0} max={4096} bind:value={DBState.db.characters[$selectedCharID].loreSettings.tokenBudget} />
            </ShSettings>
        {/if}
    </ShSettings>
{/if}
{#if submenu !== 2}

<IconButtonGroup className="mt-2">
    <IconButton onclick={() => {addLorebook(submenu)}}>
        <PlusIcon />
    </IconButton>
    <IconButton onclick={() => {
        exportLoreBook(submenu === 0 ? 'global' : 'local')
    }}>
        <DownloadIcon />
    </IconButton>
    <IconButton onclick={() => {
        importLoreBook(submenu === 0 ? 'global' : 'local')
    }}>
        <HardDriveUploadIcon />
    </IconButton>
    <IconButton
        active={listEditMode}
        aria-label={language.changeFolderName}
        onclick={() => {
            listEditMode = !listEditMode
        }}
    >
        <PencilIcon />
    </IconButton>
    {#if DBState.db.bulkEnabling}
        <button class="flex items-center gap-1 text-textcolor2 hover:text-primary" onclick={() => {
            toggleCharacterLoreAlwaysActive()
        }}>
            {#if isAllCharacterLoreAlwaysActive()}
                <SunIcon size={18} />
            {:else}
                <LinkIcon size={18} />
            {/if}
            <span class="text-xs">CHAR</span>
        </button>
        <button class="flex items-center gap-1 hover:text-primary" onclick={() => {
            toggleChatLoreAlwaysActive()
        }}>
            {#if isAllChatLoreAlwaysActive()}
                <SunIcon size={18} />
            {:else}
                <LinkIcon size={18} />
            {/if}
            <span class="text-xs">CHAT</span>
        </button>
    {/if}
    <IconButton className="ml-auto" onclick={() => {
        addLorebookFolder(submenu)
    }}>
        <FolderPlusIcon />
    </IconButton>
</IconButtonGroup>
{/if}
