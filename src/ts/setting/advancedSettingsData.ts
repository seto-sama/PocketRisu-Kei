
import type { SettingItem } from './types';
import { serverDriveAvailable } from '../serverDriveFilePicker.svelte';
import { isPrivacyGuardActive } from '../platform';
import { language } from 'src/lang';
import { DEFAULT_PLUGIN_STORAGE_WARNING_MB, getPluginStorageWarningMB, setPluginStorageWarningMB } from '../plugins/pluginMemorySafety';
import { GENERATION_COUNT_MAX, GENERATION_COUNT_MIN } from '../process/automaticReroll';
import {
    OUTPUT_REPETITION_MAX,
    OUTPUT_REPETITION_MIN,
} from '../process/request/repetitionDetector';
export const advancedSettingsItems: SettingItem[] = [
    { type: 'header', id: 'adv.warn', labelKey: 'advancedSettingsWarn', options: { level: 'warning' } },

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
    { id: 'adv.sayNothing', type: 'check', labelKey: 'sayNothing', bindKey: 'useSayNothing', helpKey: 'sayNothing' },
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
    {
        id: 'adv.serverDriveFileImport', type: 'check', labelKey: 'useServerDriveForFileImport',
        bindKey: 'useServerDriveForFileImport', helpKey: 'useServerDriveForFileImport',
        condition: () => serverDriveAvailable
    },
    {
        id: 'adv.requestInfo', type: 'check', labelKey: 'requestInfoInsideChat', bindKey: 'requestInfoInsideChat',
        helpKey: 'requestInfoInsideChat'
    },
    {
        id: 'adv.promptInfo', type: 'check', labelKey: 'promptInfoInsideChat', bindKey: 'promptInfoInsideChat',
        helpKey: 'promptInfoInsideChatDesc'
    },
    { id: 'adv.cssErr', type: 'check', labelKey: 'returnCSSError', bindKey: 'returnCSSError', helpKey: 'returnCSSError' },
    { id: 'adv.toolUsage', type: 'check', labelKey: 'rememberToolUsage', bindKey: 'rememberToolUsage', helpKey: 'rememberToolUsage' },
    { id: 'adv.simpleTool', type: 'check', labelKey: 'simplifiedToolUse', bindKey: 'simplifiedToolUse', helpKey: 'simplifiedToolUse' },

    { type: 'custom', id: 'adv.banChar', componentId: 'BanCharacterSetSettings' },
    { type: 'custom', id: 'adv.privacyGuard', componentId: 'PrivacyGuardToggle', labelKey: 'privacyGuardMode' },
    {
        id: 'adv.privacyGuardIdleLock', type: 'number', labelKey: 'privacyGuardIdleLock',
        bindKey: 'privacyGuardIdleLockMinutes', helpKey: 'privacyGuardIdleLock',
        options: { min: 1, max: 1440, suffix: () => language.minutesUnit, disableable: true, defaultValue: 10 },
        condition: () => isPrivacyGuardActive,
    },
];
