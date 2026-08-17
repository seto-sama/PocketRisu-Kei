<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import { alertConfirm } from "src/ts/alert";
    import {
        LoadLocalBackup,
        SaveLocalBackupForUpstream,
        SavePartialLocalBackup,
    } from "src/ts/drive/backuplocal";
    import { exportAsDataset } from "src/ts/storage/exportAsDataset";
    import { openSettings, SettingsRoute, StorageManagementTab } from "src/ts/routing";
    import { InfoIcon } from "@lucide/svelte";

    function gotoBackupTab() {
        openSettings(SettingsRoute.System, StorageManagementTab.Backups);
    }
</script>

<SettingPage title={language.migration}>
    <p class="text-textcolor2 text-sm leading-relaxed mb-4">{language.migrationDesc}</p>

    <ShAlert variant="info" className="mb-4">
        {#snippet icon()}<InfoIcon />{/snippet}
        {#snippet title()}{language.migrationInfoBackupMoved}{/snippet}
        {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={gotoBackupTab}>
                {language.migrationGotoBackupTab}
            </ShButton>
        {/snippet}
    </ShAlert>

    <!-- Migration: upstream RisuAI ↔ NodeOnly ─────────────────────────── -->
    <ShButton
        onclick={async () => {
            if (await alertConfirm(language.saveBackupForUpstreamConfirm)) {
                SaveLocalBackupForUpstream();
            }
        }} className="mt-2">
        {language.saveBackupForUpstream}
    </ShButton>

    <ShButton
        onclick={async () => {
            if ((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))) {
                LoadLocalBackup();
            }
        }} className="mt-2">
        {language.migrationLoadUpstreamBackup}
    </ShButton>

    <!-- Legacy backup options (collapsed by default) ──────────────────── -->
    <div class="mt-6">
        <ShAccordion name={language.migrationLegacyAccordion} variant="card">
            <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.migrationLegacyDesc}</p>
            <div class="flex flex-col gap-2">
                <ShButton
                    onclick={async () => {
                        if (await alertConfirm(language.backupConfirm)) {
                            SavePartialLocalBackup();
                        }
                    }} className="w-full">
                    {language.savePartialLocalBackup}
                </ShButton>

                <ShButton onclick={exportAsDataset} className="w-full">
                    {language.exportAsDataset}
                </ShButton>
            </div>
        </ShAccordion>
    </div>
</SettingPage>
