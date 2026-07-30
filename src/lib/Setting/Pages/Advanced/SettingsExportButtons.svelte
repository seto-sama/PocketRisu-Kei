<script lang="ts">
    import { language } from "src/lang";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import { notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { getDatabase } from "src/ts/storage/database.svelte";
    import { isNodeServer } from "src/ts/platform";

    async function exportCurrentSettings() {
        const db = safeStructuredClone(getDatabase({
            snapshot: true
        }))

        const keyToRemove = [
            'characters', 'loreBook', 'plugins', 'account', 'personas', 'username', 'userIcon', 'userNote',
            'modules', 'enabledModules', 'botPresets', 'characterOrder', 'webUiUrl', 'characterOrder',
            'hordeConfig', 'novelai', 'koboldURL', 'ooba', 'ainconfig', 'personaPrompt', 'promptTemplate',
            'deeplOptions', 'google', 'customPromptTemplateToggle', 'globalChatVariables', 'comfyConfig',
            'comfyUiUrl', 'translatorPrompt', 'translatorPresets', 'translatorPresetId', 'customModels', 'mcpURLs', 'authRefreshes'
        ]
        for(const key in db) {
            if(
                keyToRemove.includes(key) ||
                key.toLowerCase().includes('key') || key.toLowerCase().includes('proxy')
                || key.toLowerCase().includes('hypa')
            ) {
                delete db[key]
            }
        }

        //@ts-expect-error meta is not defined in Database type, added for settings export report
        db.meta = {
            isNodeServer: isNodeServer,
            protocol: location.protocol
        }

        const json = JSON.stringify(db, null, 2)
        await downloadFile('risuai-settings-report.json', new TextEncoder().encode(json))
        await navigator.clipboard.writeText(json)
        notifySuccess(language.settingsExported)
    }
</script>

<SettingLayout
    variant="row"
    title={language.exportCurrentSettings}
    description={language.help.exportCurrentSettings}
    actionLabel={language.export}
    onAction={exportCurrentSettings}
/>
