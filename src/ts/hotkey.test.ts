// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

vi.mock('./alert', async () => {
    const { writable } = await import('svelte/store')
    return {
        alertMd: vi.fn(),
        alertSelect: vi.fn(),
        alertWait: vi.fn(),
        doingAlert: writable(false),
    }
})
vi.mock('./storage/database.svelte', () => ({ getDatabase: vi.fn(() => ({})) }))
vi.mock('./stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        AdminStatsSubmenuIndex: writable(0),
        alertStore: writable(null),
        MobileGUIStack: writable(0),
        MobileSideBar: writable(0),
        openHypaV3PresetList: writable(false),
        openModelPresetList: writable(false),
        openPersonaList: writable(false),
        openPresetList: writable(false),
        openThemePresetList: writable(false),
        OpenRealmStore: writable(false),
        personaSelectCallback: writable(null),
        PlaygroundStore: writable(0),
        QuickSettings: writable(false),
        SafeModeStore: writable(false),
        selectedCharID: writable(-1),
        settingsOpen: writable(false),
    }
})
vi.mock('src/lang', () => ({ language: {} }))
vi.mock('./gui/colorscheme', () => ({ updateTextThemeAndCSS: vi.fn() }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))

import { defaultHotkeys, hotkeyMatches } from './defaulthotkeys'
import { initMobileGesture } from './hotkey'
import { MobileGUIStack, selectedCharID } from './stores.svelte'

function dispatchPointer(
    type: 'pointerdown' | 'pointerup' | 'pointercancel',
    target: EventTarget,
    pointer: {
        pointerId: number
        clientX: number
        clientY: number
        pointerType?: 'touch' | 'mouse'
        button?: number
        isPrimary?: boolean
    },
) {
    const event = new Event(type, { bubbles: true })
    for(const [key, value] of Object.entries({
        pointerType: 'touch',
        button: 0,
        isPrimary: true,
        ...pointer,
    })){
        Object.defineProperty(event, key, { value })
    }
    target.dispatchEvent(event)
}

afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
})

describe('hotkeyMatches', () => {
    it('requires an exact, case-insensitive modifier match', () => {
        const hotkey = { key: 'R', ctrl: true, alt: true, action: 'reroll' }

        expect(hotkeyMatches(
            hotkey,
            new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, altKey: true }),
        )).toBe(true)
        expect(hotkeyMatches(
            hotkey,
            new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, altKey: true, shiftKey: true }),
        )).toBe(false)
    })

    it('does not capture unmodified keys while typing in an input', () => {
        const input = document.createElement('textarea')
        document.body.appendChild(input)
        input.focus()

        expect(hotkeyMatches(
            { key: ' ', action: 'focusInput' },
            new KeyboardEvent('keydown', { key: ' ' }),
        )).toBe(false)
    })
})

describe('defaultHotkeys', () => {
    it('contains only unique, supported actions', () => {
        const actions = defaultHotkeys.map((hotkey) => hotkey.action)
        expect(new Set(actions).size).toBe(actions.length)
        expect(actions).toContain('modelSelect')
        expect(actions).toContain('popupEditor')
        expect(actions).not.toContain('loadout')
    })
})

describe('initMobileGesture', () => {
    beforeAll(() => {
        initMobileGesture()
    })

    it('ignores pointerup events without a tracked pointerdown', () => {
        selectedCharID.set(-1)
        MobileGUIStack.set(1)

        const button = document.createElement('button')
        const buttonIcon = document.createElement('span')
        button.appendChild(buttonIcon)
        document.body.appendChild(button)

        expect(() => {
            dispatchPointer('pointerdown', buttonIcon, {
                pointerId: 1,
                clientX: 100,
                clientY: 0,
            })
            dispatchPointer('pointerup', buttonIcon, {
                pointerId: 1,
                clientX: 200,
                clientY: 0,
            })
            dispatchPointer('pointerup', document.body, {
                pointerId: 2,
                clientX: 200,
                clientY: 0,
            })
        }).not.toThrow()
        expect(get(MobileGUIStack)).toBe(1)
    })

    it('uses the same navigation gesture for touch swipes and mouse drags', () => {
        selectedCharID.set(-1)
        MobileGUIStack.set(1)

        dispatchPointer('pointerdown', document.body, {
            pointerId: 3,
            clientX: 100,
            clientY: 0,
        })
        dispatchPointer('pointerup', document.body, {
            pointerId: 3,
            clientX: 200,
            clientY: 0,
        })
        expect(get(MobileGUIStack)).toBe(0)

        dispatchPointer('pointerdown', document.body, {
            pointerId: 4,
            pointerType: 'mouse',
            clientX: 200,
            clientY: 0,
        })
        dispatchPointer('pointerup', document.body, {
            pointerId: 4,
            pointerType: 'mouse',
            clientX: 100,
            clientY: 0,
        })
        expect(get(MobileGUIStack)).toBe(1)
    })
})
