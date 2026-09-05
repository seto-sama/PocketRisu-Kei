import { beforeEach, describe, expect, it } from 'vitest'
import {
    applyPluginMemoryDecision,
    buildPluginMemoryDecision,
    getPluginStorageWarningMB,
    getPluginStorageWarningBytes,
    setPluginStorageWarningMB,
    pluginDisabledForMemorySession,
    pluginMemorySessionStore,
    selectedPluginStorageBytes,
} from './pluginMemorySafety'

describe('plugin startup storage warning', () => {
    beforeEach(() => pluginMemorySessionStore.set({
        disableAll: false,
        disabledPluginNames: [],
        unclassifiedExcluded: false,
    }))

    it('persists the browser-local threshold before database loading', () => {
        localStorage.removeItem('pluginStorageWarningMB')
        expect(getPluginStorageWarningMB()).toBe(256)
        expect(getPluginStorageWarningBytes()).toBe(256_000_000)
        setPluginStorageWarningMB(512)
        expect(getPluginStorageWarningBytes()).toBe(512_000_000)
        setPluginStorageWarningMB(-1)
        expect(getPluginStorageWarningMB()).toBe(512)
        setPluginStorageWarningMB(-1000)
        expect(getPluginStorageWarningBytes()).toBeNull()
        setPluginStorageWarningMB(0)
        expect(getPluginStorageWarningBytes()).toBe(0)
        localStorage.removeItem('pluginStorageWarningMB')
    })

    it('turns plugin and unclassified selections into one projection decision', () => {
        const stats = {
            totalBytes: 100,
            unclassifiedBytes: 30,
            plugins: [
                { name: 'large', displayName: 'Large', bytes: 60 },
                { name: 'small', displayName: 'Small', bytes: 10 },
            ],
        }

        expect(selectedPluginStorageBytes(stats, ['small'], true)).toBe(40)
        expect(buildPluginMemoryDecision(stats, ['small'], true)).toEqual({
            excludedPluginNames: ['large'],
            excludeUnclassified: false,
            excludeAll: false,
        })
        expect(buildPluginMemoryDecision(stats, [], false).excludeAll).toBe(true)
    })

    it('disables selected V3 and legacy plugins only for the filtered session', () => {
        applyPluginMemoryDecision({
            excludedPluginNames: ['large'],
            excludeUnclassified: true,
            excludeAll: false,
        })

        expect(pluginDisabledForMemorySession({ name: 'large', version: '3.0' })).toBe(true)
        expect(pluginDisabledForMemorySession({ name: 'small', version: '3.0' })).toBe(false)
        expect(pluginDisabledForMemorySession({ name: 'legacy', version: '2.1' })).toBe(true)
    })
})
