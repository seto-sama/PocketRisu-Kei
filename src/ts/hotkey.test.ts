// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

vi.mock('./alert', async () => {
    return {
        alertRequestData: vi.fn(),
        alertMd: vi.fn(),
        alertSelect: vi.fn(),
        alertWait: vi.fn(),
        doingAlert: vi.fn(() => false),
    }
})
vi.mock('./storage/database.svelte', () => ({
    getCurrentChat: vi.fn(() => undefined),
    getDatabase: vi.fn(() => ({})),
}))
vi.mock('./stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        AdminStatsSubmenuIndex: writable(0),
        alertStore: writable(null),
        botMakerMode: writable(false),
        openHypaV3PresetList: writable(false),
        openModelPresetList: writable(false),
        openPersonaList: writable(false),
        openPresetList: writable(false),
        openThemePresetList: writable(false),
        OpenRealmStore: writable(false),
        personaSelectCallback: writable(null),
        QuickSettings: { open: false, index: 0 },
        SafeModeStore: writable(false),
        selectedCharID: writable(-1),
        sidebarDevTool: writable(false),
        sideBarStore: writable(true),
        settingsOpen: writable(false),
    }
})
vi.mock('src/lang', () => ({ language: {} }))
vi.mock('./gui/colorscheme', () => ({ updateTextThemeAndCSS: vi.fn() }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))

import { hotkeyMatches, isSupportedHotkey } from './defaulthotkeys'
import { findMostVisibleMessageAction, getSidebarCharacterOrder, initHotkey } from './hotkey'
import { requestEscapeAction } from './gui/escapeKey'
import {
    botMakerMode,
    QuickSettings,
    selectedCharID,
    sidebarDevTool,
    sideBarStore,
    settingsOpen,
} from './stores.svelte'

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

    it('does not match a disabled hotkey', () => {
        expect(hotkeyMatches(
            { key: 'g', ctrl: true, disabled: true, action: 'scrollToActiveChar' },
            new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }),
        )).toBe(false)
    })
})

describe('isSupportedHotkey', () => {
    it('distinguishes supported actions from unknown database entries', () => {
        expect(isSupportedHotkey({ key: '?', action: 'unknownActionForTest' })).toBe(false)
        expect(isSupportedHotkey({ key: 'r', ctrl: true, alt: true, action: 'reroll' })).toBe(true)
    })
})

describe('application hotkeys', () => {
    beforeAll(() => {
        initHotkey()
    })

    function press(key: string, modifiers: KeyboardEventInit = {}) {
        const event = new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            ...modifiers,
        })
        document.dispatchEvent(event)
        return event
    }

    function resetSidebarState() {
        selectedCharID.set(0)
        sideBarStore.set(true)
        settingsOpen.set(false)
        botMakerMode.set(false)
        sidebarDevTool.set(false)
        QuickSettings.open = false
        QuickSettings.index = 1
    }

    it('closes settings through the shared Escape request', () => {
        settingsOpen.set(true)
        expect(requestEscapeAction()).toBe(true)
        expect(get(settingsOpen)).toBe(false)
        expect(requestEscapeAction()).toBe(false)
    })

    it('leaves settings open while a modal handles Escape', () => {
        const modal = document.createElement('div')
        modal.setAttribute('aria-modal', 'true')
        modal.dataset.state = 'open'
        document.body.appendChild(modal)
        settingsOpen.set(true)

        expect(press('Escape').defaultPrevented).toBe(true)
        expect(get(settingsOpen)).toBe(true)
        settingsOpen.set(false)
    })

    it('opens quick settings only from the character sidebar', () => {
        resetSidebarState()

        const chatEvent = press('q', { ctrlKey: true })
        expect(QuickSettings.open).toBe(false)
        expect(chatEvent.defaultPrevented).toBe(true)

        botMakerMode.set(true)
        press('q', { ctrlKey: true })
        expect(QuickSettings.open).toBe(true)
        expect(QuickSettings.index).toBe(0)
    })

    it('toggles chat and character views while clearing nested character state', () => {
        resetSidebarState()

        press('q', { ctrlKey: true, altKey: true })
        expect(get(botMakerMode)).toBe(true)

        QuickSettings.open = true
        sidebarDevTool.set(true)
        press('q', { ctrlKey: true, altKey: true })
        expect(get(botMakerMode)).toBe(false)
        expect(get(sidebarDevTool)).toBe(false)
        expect(QuickSettings.open).toBe(false)
    })

    it('does not toggle a sidebar view when no character sidebar is available', () => {
        resetSidebarState()
        selectedCharID.set(-1)

        const event = press('q', { ctrlKey: true, altKey: true })
        expect(get(botMakerMode)).toBe(false)
        expect(event.defaultPrevented).toBe(false)
    })
})

describe('getSidebarCharacterOrder', () => {
    it('uses root and folder placement instead of character names', () => {
        expect(getSidebarCharacterOrder({
            characters: [
                { chaId: 'alpha' },
                { chaId: 'beta' },
                { chaId: 'gamma' },
            ],
            characterOrder: [
                'gamma',
                { data: ['beta', 'missing'] },
                'alpha',
            ],
        })).toEqual([2, 1, 0])
    })
})

describe('findMostVisibleMessageAction', () => {
    function setRect(element: HTMLElement, rect: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>) {
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
            ...rect,
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
            toJSON: () => ({}),
        })
    }

    it('selects the action in the message occupying the most viewport area', () => {
        const root = document.createElement('div')
        setRect(root, { top: 0, right: 100, bottom: 500, left: 0 })

        const messages = [
            { top: -100, bottom: 200 },
            { top: 200, bottom: 550 },
            { top: 450, bottom: 650 },
        ].map((bounds) => {
            const message = document.createElement('div')
            message.dataset.chatIndex = '0'
            const action = document.createElement('button')
            action.className = 'target-action'
            message.appendChild(action)
            root.appendChild(message)
            setRect(message, { ...bounds, right: 100, left: 0 })
            return action
        })

        expect(findMostVisibleMessageAction(root, '.target-action')).toBe(messages[1])
    })

    it('prefers the lower message when visible areas are equal', () => {
        const root = document.createElement('div')
        setRect(root, { top: 0, right: 100, bottom: 500, left: 0 })

        const actions = [
            { top: 0, bottom: 250 },
            { top: 250, bottom: 500 },
        ].map((bounds, index) => {
            const message = document.createElement('div')
            message.dataset.chatIndex = String(index)
            const action = document.createElement('button')
            action.className = 'target-action'
            message.appendChild(action)
            root.appendChild(message)
            setRect(message, { ...bounds, right: 100, left: 0 })
            return action
        })

        expect(findMostVisibleMessageAction(root, '.target-action')).toBe(actions[1])
    })

    it('prefers the lowest fully visible message over larger partial messages', () => {
        const root = document.createElement('div')
        setRect(root, { top: 0, right: 100, bottom: 500, left: 0 })

        const actions = [
            { top: -200, bottom: 300 },
            { top: 320, bottom: 350 },
            { top: 400, bottom: 450 },
        ].map((bounds, index) => {
            const message = document.createElement('div')
            message.dataset.chatIndex = String(index)
            const action = document.createElement('button')
            action.className = 'target-action'
            message.appendChild(action)
            root.appendChild(message)
            setRect(message, { ...bounds, right: 100, left: 0 })
            return action
        })

        expect(findMostVisibleMessageAction(root, '.target-action')).toBe(actions[2])
    })
})
