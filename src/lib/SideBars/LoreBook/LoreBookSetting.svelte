<script lang="ts">
    
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from "../../../lang";
    import { DownloadIcon, UploadIcon, PlusIcon, SunIcon, LinkIcon, FolderPlusIcon } from "@lucide/svelte";
    import { addLorebook, addLorebookFolder, exportLoreBook, importLoreBook } from "../../../ts/process/lorebook.svelte";
    import NumberInput from "../../UI/components/NumberInput.svelte";
    import SettingsList from "../../UI/components/SettingsList.svelte";
    import Switch from "../../UI/components/Switch.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { selectedCharID } from "src/ts/stores.svelte";
    import IconButton from "../../UI/components/IconButton.svelte";
    import ListActionBar from "../../UI/components/ListActionBar.svelte";
    import ChoiceGroup from "../../UI/components/ChoiceGroup.svelte";

    let submenu = $state('character')
    let loreSubmenu = $derived(submenu === 'character' ? 0 : 1)

    const currentLoreEntries = $derived.by(() => {
        const character = DBState.db.characters[$selectedCharID];
        const lore = submenu === 'character'
            ? character?.globalLore
            : submenu === 'chat' ? character?.chats[character.chatPage]?.localLore : [];
        return (lore ?? []).filter(book => book.mode !== 'folder');
    });
    const allLoreAlwaysActive = $derived(currentLoreEntries.length > 0
        && currentLoreEntries.every(book => book.alwaysActive));
    const bulkToggleLabel = $derived(`${submenu === 'character' ? language.character : language.Chat}: ${language.bulkEnabling}`);

    function toggleCurrentLoreAlwaysActive() {
        const nextActive = !allLoreAlwaysActive;
        currentLoreEntries.forEach(book => {
            book.alwaysActive = nextActive;
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
<ChoiceGroup
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
    <SettingsList spacing="none">
        <SettingsList variant="row">
            <span class="min-w-0 text-maintext">{language.useGlobalSettings}</span>
            <Switch
                checked={!DBState.db.characters[$selectedCharID].loreSettings}
                onCheckedChange={setUseGlobalSettings}
            />
        </SettingsList>
        {#if DBState.db.characters[$selectedCharID].loreSettings}
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.recursiveScanning}</span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].loreSettings.recursiveScanning}/>
            </SettingsList>
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.fullWordMatching}</span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].loreSettings.fullWordMatching}/>
            </SettingsList>
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.loreBookDepth}</span>
                <NumberInput size="sm" className="w-24" min={0} max={20} bind:value={DBState.db.characters[$selectedCharID].loreSettings.scanDepth} />
            </SettingsList>
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.loreBookToken}</span>
                <NumberInput size="sm" className="w-24" min={0} max={4096} bind:value={DBState.db.characters[$selectedCharID].loreSettings.tokenBudget} />
            </SettingsList>
        {/if}
    </SettingsList>
{/if}
{#if submenu !== 'settings'}

<ListActionBar mode="footer">
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
        <IconButton
            className="ml-auto"
            title={bulkToggleLabel}
            aria-label={bulkToggleLabel}
            aria-pressed={allLoreAlwaysActive}
            disabled={currentLoreEntries.length === 0}
            onclick={toggleCurrentLoreAlwaysActive}
        >
            {#if allLoreAlwaysActive}
                <SunIcon />
            {:else}
                <LinkIcon />
            {/if}
        </IconButton>
    {/if}
    <IconButton className={DBState.db.bulkEnabling ? '' : 'ml-auto'} onclick={() => {
        addLorebookFolder(loreSubmenu)
    }}>
        <FolderPlusIcon />
    </IconButton>
</ListActionBar>
{/if}
</div>
