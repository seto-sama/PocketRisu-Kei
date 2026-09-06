
import type { SettingItem } from './types';
import { DEFAULT_PLUGIN_STORAGE_WARNING_MB, getPluginStorageWarningMB, setPluginStorageWarningMB } from '../plugins/pluginMemorySafety';
import { loadPlugins } from '../plugins/plugins.svelte';
import { GENERATION_COUNT_MAX, GENERATION_COUNT_MIN } from '../process/automaticReroll';
import {
    OUTPUT_REPETITION_MAX,
    OUTPUT_REPETITION_MIN,
} from '../process/request/repetitionDetector';
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
        id: 'adv.genTime', type: 'number', labelKey: 'genTimes', bindKey: 'genTime',
        helpKey: 'genTimes', options: { min: GENERATION_COUNT_MIN, max: GENERATION_COUNT_MAX }
    },
    {
        id: 'adv.retries', type: 'number', labelKey: 'requestretrys', bindKey: 'requestRetrys',
        helpKey: 'requestretrys', options: { min: 0, max: 20 }
    },
    {
        id: 'adv.outputRepetition', type: 'number', labelKey: 'outputRepetitionDetection',
        bindKey: 'outputRepetitionLimit', helpKey: 'outputRepetitionDetection',
        options: {
            min: OUTPUT_REPETITION_MIN,
            max: OUTPUT_REPETITION_MAX,
            disableable: true,
            defaultValue: 8,
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
        id: 'adv.pluginStorageWarning', type: 'number', labelKey: 'pluginMemoryWarningTitle',
        helpKey: 'pluginStorageWarningThreshold',
        getValue: () => getPluginStorageWarningMB(),
        setValue: (_db, value) => setPluginStorageWarningMB(value),
        options: { min: 0, suffix: 'MB', disableable: true, defaultValue: DEFAULT_PLUGIN_STORAGE_WARNING_MB },
    },
    {
        id: 'adv.exp.cachePoint', type: 'check', labelKey: 'automaticCachePoint', bindKey: 'automaticCachePoint',
        helpKey: 'automaticCachePoint', showExperimental: true
    },
    // Prompt Information
    {
        id: 'adv.requestInfo', type: 'check', labelKey: 'requestInfoInsideChat', bindKey: 'requestInfoInsideChat',
        helpKey: 'requestInfoInsideChat'
    },
    {
        id: 'adv.promptInfo', type: 'check', labelKey: 'promptInfoInsideChat', bindKey: 'promptInfoInsideChat',
        helpKey: 'promptInfoInsideChatDesc'
    },
    { id: 'adv.allowExt', type: 'check', labelKey: 'allowAllExtentionFiles', bindKey: 'allowAllExtentionFiles', helpKey: 'allowAllExtentionFiles' },
    // Remote saving removed — incompatible with NodeOnly server

    // Dynamic Assets & Others
    { id: 'adv.cssErr', type: 'check', labelKey: 'returnCSSError', bindKey: 'returnCSSError', helpKey: 'returnCSSError' },
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

    // Custom Components
    { type: 'custom', id: 'adv.banChar', componentId: 'BanCharacterSetSettings' },
];
