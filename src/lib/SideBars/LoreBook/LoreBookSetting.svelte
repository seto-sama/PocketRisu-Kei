<script lang="ts">
    
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from "../../../lang";
    import { DownloadIcon, UploadIcon, PlusIcon, SunIcon, LinkIcon, FolderPlusIcon } from "@lucide/svelte";
    import { addLorebook, addLorebookFolder, exportLoreBook, importLoreBook } from "../../../ts/process/lorebook.svelte";
    import NumberInput from "../../UI/GUI/NumberInput.svelte";
    import ShSettings from "../../UI/GUI/ShSettings.svelte";
    import ShSwitch from "../../UI/GUI/ShSwitch.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { selectedCharID } from "src/ts/stores.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
    import ShChoiceGroup from "src/lib/UI/GUI/ShChoiceGroup.svelte";

    let submenu = $state('character')
    let loreSubmenu = $derived(submenu === 'character' ? 0 : 1)

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

<div class="w-full shrink-0">
<ShChoiceGroup
    variant="pill"
    size="md"
    name="lorebookSubmenu"
    bind:value={submenu}
    options={[
        {
            value: 'character',
            label: language.character,
            description: `${language.help.lorebook.trim()}\n${language.globalLoreInfo}`,
        },
        {
            value: 'chat',
            label: language.Chat,
            description: `${language.help.lorebook.trim()}\n${language.localLoreInfo}`,
        },
        { value: 'settings', label: language.settings },
    ]}
    activeColor="selected"
    fullWidth
    divided
    className="mb-4 shrink-0"
/>
{#if submenu !== 'settings'}
    <LoreBookList submenu={loreSubmenu} />
{:else}
    <ShSettings spacing="none">
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
                <NumberInput size="sm" className="w-24" min={0} max={20} bind:value={DBState.db.characters[$selectedCharID].loreSettings.scanDepth} />
            </ShSettings>
            <ShSettings variant="row">
                <span class="min-w-0 text-textcolor">{language.loreBookToken}</span>
                <NumberInput size="sm" className="w-24" min={0} max={4096} bind:value={DBState.db.characters[$selectedCharID].loreSettings.tokenBudget} />
            </ShSettings>
        {/if}
    </ShSettings>
{/if}
{#if submenu !== 'settings'}

<IconButtonGroup className="mt-2">
    <IconButton onclick={() => {addLorebook(loreSubmenu)}}>
        <PlusIcon />
    </IconButton>
    <IconButton onclick={() => {
        exportLoreBook(submenu === 'character' ? 'global' : 'local')
    }}>
        <DownloadIcon />
    </IconButton>
    <IconButton onclick={() => {
        importLoreBook(submenu === 'character' ? 'global' : 'local')
    }}>
        <UploadIcon />
    </IconButton>
    {#if DBState.db.bulkEnabling}
        <button class="flex items-center gap-1 text-textcolor2 risu-interactive-accent" onclick={() => {
            toggleCharacterLoreAlwaysActive()
        }}>
            {#if isAllCharacterLoreAlwaysActive()}
                <SunIcon size={18} />
            {:else}
                <LinkIcon size={18} />
            {/if}
            <span class="text-xs">CHAR</span>
        </button>
        <button class="flex items-center gap-1 risu-interactive-accent" onclick={() => {
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
        addLorebookFolder(loreSubmenu)
    }}>
        <FolderPlusIcon />
    </IconButton>
</IconButtonGroup>
{/if}
</div>
