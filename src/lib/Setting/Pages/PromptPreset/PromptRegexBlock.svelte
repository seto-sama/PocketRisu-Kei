<script lang="ts">
    import { DownloadIcon, HardDriveUploadIcon, PlusIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";

    let search = $state('');

    function addRegex() {
        DBState.db.presetRegex = [
            ...DBState.db.presetRegex,
            { comment: '', in: '', out: '', type: 'editinput' as const },
        ];
    }

    async function importPresetRegex() {
        DBState.db.presetRegex = await importRegex(DBState.db.presetRegex);
    }
</script>

<SettingLayout variant="search" className="mb-4">
    <ShInput bind:value={search} placeholder={language.presetRegexSearchPlaceholder} />
    {#snippet control()}
        <IconButtonGroup size="lg">
        <IconButton onclick={addRegex} aria-label={language.add}>
            <PlusIcon />
        </IconButton>
        <IconButton onclick={() => exportRegex(DBState.db.presetRegex)} aria-label={language.export}>
            <DownloadIcon />
        </IconButton>
        <IconButton onclick={importPresetRegex} aria-label={language.import}>
            <HardDriveUploadIcon />
        </IconButton>
        </IconButtonGroup>
    {/snippet}
</SettingLayout>

<RegexList bind:value={DBState.db.presetRegex} embedded {search} />
