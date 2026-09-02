<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "../../UI/components/SettingPage.svelte";
    import Button from "../../UI/components/Button.svelte";
    import Alert from "../../UI/components/Alert.svelte";
    import Accordion from "../../UI/components/Accordion.svelte";
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
    <p class="text-subtext text-sm leading-relaxed mb-4">{language.migrationDesc}</p>

    <Alert variant="info" className="mb-4">
        {#snippet icon()}<InfoIcon />{/snippet}
        {#snippet title()}{language.migrationInfoBackupMoved}{/snippet}
        {#snippet action()}
            <Button variant="outline" size="sm" onclick={gotoBackupTab}>
                {language.migrationGotoBackupTab}
            </Button>
        {/snippet}
    </Alert>

    <!-- Migration: upstream RisuAI ↔ NodeOnly ─────────────────────────── -->
    <Button
        onclick={async () => {
            if (await alertConfirm(language.saveBackupForUpstreamConfirm)) {
                SaveLocalBackupForUpstream();
            }
        }} className="mt-2">
        {language.saveBackupForUpstream}
    </Button>

    <Button
        onclick={async () => {
            if ((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))) {
                LoadLocalBackup();
            }
        }} className="mt-2">
        {language.migrationLoadUpstreamBackup}
    </Button>

    <!-- Legacy backup options (collapsed by default) ──────────────────── -->
    <div class="mt-6">
        <Accordion name={language.migrationLegacyAccordion} variant="card">
            <p class="text-subtext text-sm leading-relaxed mb-3">{language.migrationLegacyDesc}</p>
            <div class="flex flex-col gap-2">
                <Button
                    onclick={async () => {
                        if (await alertConfirm(language.backupConfirm)) {
                            SavePartialLocalBackup();
                        }
                    }} className="w-full">
                    {language.savePartialLocalBackup}
                </Button>

                <Button onclick={exportAsDataset} className="w-full">
                    {language.exportAsDataset}
                </Button>
            </div>
        </Accordion>
    </div>
</SettingPage>
