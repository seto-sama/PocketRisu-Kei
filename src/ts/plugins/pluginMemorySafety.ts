import { get, writable } from 'svelte/store'
import type {
    PluginStorageExclusion,
    PluginStorageStartupStats,
} from '../storage/nodeStorage'

const MEGABYTE = 1_000_000
const WARNING_THRESHOLD_KEY = 'pluginStorageWarningMB'
export const DEFAULT_PLUGIN_STORAGE_WARNING_MB = 256
// Shared disableable number settings use -1000 for an empty input.
const DISABLED_THRESHOLD = -1000

export function getPluginStorageWarningMB(): number {
    const stored = localStorage.getItem(WARNING_THRESHOLD_KEY)
    const value = stored === null ? NaN : Number(stored)
    return Number.isFinite(value) && (value >= 0 || value === DISABLED_THRESHOLD)
        ? value : DEFAULT_PLUGIN_STORAGE_WARNING_MB
}

export function setPluginStorageWarningMB(value: number): void {
    if (!Number.isFinite(value) || (value < 0 && value !== DISABLED_THRESHOLD)) return
    localStorage.setItem(WARNING_THRESHOLD_KEY, String(value))
}

export function getPluginStorageWarningBytes(): number | null {
    const value = getPluginStorageWarningMB()
    return value === DISABLED_THRESHOLD ? null : value * MEGABYTE
}

export interface PluginMemoryDecision {
    excludedPluginNames: string[]
    excludeUnclassified: boolean
    excludeAll: boolean
}

export interface PluginMemoryPromptData {
    stats: PluginStorageStartupStats
    thresholdBytes: number
    resolve: (decision: PluginMemoryDecision) => void
}

export interface PluginMemorySessionState {
    disableAll: boolean
    disabledPluginNames: string[]
    unclassifiedExcluded: boolean
}

export const pluginMemoryPromptStore = writable<PluginMemoryPromptData | null>(null)
export const pluginMemorySessionStore = writable<PluginMemorySessionState>({
    disableAll: false,
    disabledPluginNames: [],
    unclassifiedExcluded: false,
})

export function requestPluginMemoryDecision(
    stats: PluginStorageStartupStats,
    thresholdBytes: number,
): Promise<PluginMemoryDecision> {
    return new Promise(resolve => pluginMemoryPromptStore.set({ stats, thresholdBytes, resolve }))
}

export function selectedPluginStorageBytes(
    stats: PluginStorageStartupStats,
    enabledPluginNames: readonly string[],
    unclassifiedEnabled: boolean,
): number {
    const enabled = new Set(enabledPluginNames)
    return stats.plugins.reduce(
        (sum, plugin) => sum + (enabled.has(plugin.name) ? plugin.bytes : 0),
        unclassifiedEnabled ? stats.unclassifiedBytes : 0,
    )
}

export function buildPluginMemoryDecision(
    stats: PluginStorageStartupStats,
    enabledPluginNames: readonly string[],
    unclassifiedEnabled: boolean,
): PluginMemoryDecision {
    const enabled = new Set(enabledPluginNames)
    const excludedPluginNames = stats.plugins
        .map(plugin => plugin.name)
        .filter(name => !enabled.has(name))
    return {
        excludedPluginNames,
        excludeUnclassified: !unclassifiedEnabled,
        excludeAll: excludedPluginNames.length === stats.plugins.length && !unclassifiedEnabled,
    }
}

export function applyPluginMemoryDecision(decision: PluginMemoryDecision): PluginStorageExclusion | null {
    pluginMemorySessionStore.set({
        disableAll: decision.excludeAll,
        disabledPluginNames: decision.excludedPluginNames,
        unclassifiedExcluded: decision.excludeUnclassified,
    })
    if (decision.excludeAll) return { all: true }
    if (decision.excludedPluginNames.length === 0 && !decision.excludeUnclassified) return null
    return {
        pluginNames: decision.excludedPluginNames,
        unclassified: decision.excludeUnclassified,
    }
}

export function pluginDisabledForMemorySession(
    plugin: { name?: string, version?: unknown },
    state: PluginMemorySessionState = get(pluginMemorySessionStore),
): boolean {
    if (state.disableAll) return true
    if (plugin.name && state.disabledPluginNames.includes(plugin.name)) return true
    return state.unclassifiedExcluded && (plugin.version === 2 || plugin.version === '2.0' || plugin.version === '2.1')
}
