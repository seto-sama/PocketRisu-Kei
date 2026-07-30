
import type { SettingItem } from './types';
import { loadPlugins } from '../plugins/plugins.svelte';
export const advancedSettingsItems: SettingItem[] = [
    { type: 'header', id: 'adv.warn', labelKey: 'advancedSettingsWarn', options: { level: 'warning' } },

    // LoreBook Settings
    {
        id: 'adv.lbDepth', type: 'number', labelKey: 'loreBookDepth', bindKey: 'loreBookDepth',
        helpKey: 'loreBookDepth',
        options: { min: 0, max: 20 },
        classes: 'mt-4'
    },
    {
        id: 'adv.lbToken', type: 'number', labelKey: 'loreBookToken', bindKey: 'loreBookToken',
        helpKey: 'loreBookToken',
        options: { min: 0 }
    },
    {
        id: 'adv.disableLbRecursive', type: 'check', labelKey: 'disableGlobalLorebookRecursiveScanning',
        bindKey: 'disableGlobalLorebookRecursiveScanning', helpKey: 'disableGlobalLorebookRecursiveScanning'
    },
    {
        id: 'adv.localActivationInCharacterLorebook', type: 'check', labelKey: 'localActivationInGlobalLorebook',
        bindKey: 'localActivationInGlobalLorebook', helpKey: 'localActivationInGlobalLorebook'
    },
    {
        id: 'adv.bulkEnabling', type: 'check', labelKey: 'bulkEnabling',
        bindKey: 'bulkEnabling', helpKey: 'bulkEnabling'
    },
    // Request Settings
    {
        id: 'adv.retries', type: 'number', labelKey: 'requestretrys', bindKey: 'requestRetrys',
        helpKey: 'requestretrys', options: { min: 0, max: 20 }
    },
    {
        id: 'adv.genTime', type: 'number', labelKey: 'genTimes', bindKey: 'genTime',
        helpKey: 'genTimes', options: { min: 0, max: 4096 }
    },
    // Request Location (Non-Node/Tauri)
    {
        id: 'adv.reqLoc', type: 'segmented', labelKey: 'requestLocation', bindKey: 'requestLocation',
        condition: () => false,
        options: {
            segmentOptions: [
                { value: '', label: 'Default' },
                { value: 'eu', label: 'EU (GDPR)' },
                { value: 'fedramp', label: 'US (FedRAMP)' }
            ]
        }
    },

    // Toggles
    { id: 'adv.sayNothing', type: 'check', labelKey: 'sayNothing', bindKey: 'useSayNothing', helpKey: 'sayNothing' },
    { id: 'adv.newImgBeta', type: 'check', labelKey: 'newImageHandlingBeta', bindKey: 'newImageHandlingBeta', helpKey: 'newImageHandlingBeta' },
    {
        id: 'adv.allowV2Plugin', type: 'check', labelKey: 'allowV2Plugin', bindKey: 'allowV2Plugin',
        helpKey: 'allowV2Plugin', helpUnrecommended: true,
        onChange: () => {
            void loadPlugins();
        }
    },
    // Experimental Section
    {
        id: 'adv.exp.cachePoint', type: 'check', labelKey: 'automaticCachePoint', bindKey: 'automaticCachePoint',
        helpKey: 'automaticCachePoint', showExperimental: true
    },
    // Node/Tauri Specific
    {
        id: 'adv.requestInfo', type: 'check', labelKey: 'requestInfoInsideChat', bindKey: 'requestInfoInsideChat',
        helpKey: 'requestInfoInsideChat'
    },
    {
        id: 'adv.promptInfo', type: 'check', labelKey: 'promptInfoInsideChat', bindKey: 'promptInfoInsideChat',
        helpKey: 'promptInfoInsideChatDesc'
    },
    {
        id: 'adv.promptTextInfo', type: 'check', labelKey: 'promptTextInfoInsideChat', bindKey: 'promptTextInfoInsideChat',
        condition: (ctx) => ctx.db.promptInfoInsideChat, helpKey: 'promptTextInfoInsideChat'
    },
    { id: 'adv.allowExt', type: 'check', labelKey: 'allowAllExtentionFiles', bindKey: 'allowAllExtentionFiles', helpKey: 'allowAllExtentionFiles' },
    // Remote saving removed — incompatible with NodeOnly server

    // Dynamic Assets & Others
    { id: 'adv.cssErr', type: 'check', labelKey: 'returnCSSError', bindKey: 'returnCSSError', helpKey: 'returnCSSError' },
    { id: 'adv.antiOverload', type: 'check', labelKey: 'antiServerOverload', bindKey: 'antiServerOverloads', helpKey: 'antiServerOverload' },
    { id: 'adv.toolUsage', type: 'check', labelKey: 'rememberToolUsage', bindKey: 'rememberToolUsage', helpKey: 'rememberToolUsage' },
    { id: 'adv.simpleTool', type: 'check', labelKey: 'simplifiedToolUse', bindKey: 'simplifiedToolUse', helpKey: 'simplifiedToolUse' },

    // Sync (Condition: db.account.useSync)
    {
        id: 'adv.sync.realm', type: 'check', fallbackLabel: 'Lightning Realm Import', bindKey: 'lightningRealmImport',
        condition: (ctx) => !!ctx.db.account?.useSync, helpKey: 'lightningRealmImport', showExperimental: true
    },

    // Dynamic Assets Edit (Condition: dynamicAssets)
    {
        id: 'adv.dynAssetsEdit', type: 'check', labelKey: 'dynamicAssetsEditDisplay', bindKey: 'dynamicAssetsEditDisplay',
        condition: (ctx) => ctx.db.dynamicAssets, helpKey: 'dynamicAssetsEditDisplay'
    },

    // Unrecommended Extra
    {
        id: 'adv.depTrig', type: 'check', labelKey: 'showDeprecatedTriggerV1', bindKey: 'showDeprecatedTriggerV1',
        helpKey: 'unrecommendedTriggerV1', helpUnrecommended: true
    },

    // Custom Components
    { type: 'custom', id: 'adv.banChar', componentId: 'BanCharacterSetSettings' },
    { type: 'custom', id: 'adv.export', componentId: 'SettingsExportButtons' },
];
