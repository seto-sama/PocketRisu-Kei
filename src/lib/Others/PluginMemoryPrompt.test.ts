// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

vi.mock('src/lang', () => ({
    language: {
        pluginMemoryWarningTitle: 'Plugin Memory Risk',
        pluginMemoryWarningDescription: 'Warning',
        pluginMemoryWarningDescriptionMobile: 'Warning',
        pluginMemoryStoredData: 'Stored',
        pluginStorageWarningThreshold: 'Safe',
        pluginMemoryStillToDisable: 'Remaining',
        pluginMemorySelectedTotal: 'Selected: {}',
        pluginMemoryUnclassified: 'Unclassified',
        pluginMemoryUnclassifiedDescription: 'Legacy data',
        pluginMemoryEnableAll: 'Enable All',
        pluginMemoryDisableAll: 'Disable All',
        pluginMemoryProceed: 'Proceed',
    },
}))

const { pluginMemoryPromptStore } = await import('src/ts/plugins/pluginMemorySafety')
const { default: PluginMemoryPrompt } = await import('./PluginMemoryPrompt.svelte')

let component: ReturnType<typeof mount> | null = null

afterEach(async () => {
    pluginMemoryPromptStore.set(null)
    if (component) await unmount(component)
    component = null
    document.body.replaceChildren()
})

describe('PluginMemoryPrompt', () => {
    it('binds each shared switch to the selection used by Proceed', async () => {
        const resolve = vi.fn()
        pluginMemoryPromptStore.set({
            stats: {
                totalBytes: 70,
                unclassifiedBytes: 0,
                plugins: [
                    { name: 'large', displayName: 'Large', bytes: 60 },
                    { name: 'small', displayName: 'Small', bytes: 10 },
                ],
            },
            thresholdBytes: 50,
            resolve,
        })
        const target = document.createElement('div')
        document.body.appendChild(target)
        component = mount(PluginMemoryPrompt, { target })
        await tick()

        const switches = document.querySelectorAll<HTMLButtonElement>('[data-slot="switch"]')
        expect(switches).toHaveLength(2)
        expect(switches[0].dataset.state).toBe('checked')

        switches[0].click()
        await tick()
        expect(switches[0].dataset.state).toBe('unchecked')

        const proceed = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.trim() === 'Proceed')
        proceed?.click()
        await tick()

        expect(resolve).toHaveBeenCalledWith({
            excludedPluginNames: ['large'],
            excludeUnclassified: false,
            excludeAll: false,
        })
    })
})
