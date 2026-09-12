import { get } from "svelte/store"
import { alertRequestData, alertSelect, doingAlert, requestDiagnosticsTabs } from "./alert"
import { getCurrentChat, getDatabase  } from "./storage/database.svelte"
import {
    alertStore,
    botMakerMode,
    openHypaV3PresetList,
    openModelPresetList,
    openPersonaList,
    openPresetList,
    openThemePresetList,
    OpenRealmStore,
    personaSelectCallback,
    presetSelectCallback,
    QuickSettings,
    requestPreviewOpen,
    SafeModeStore,
    selectedCharID,
    sidebarDevTool,
    sideBarStore,
    settingsOpen,
} from "./stores.svelte"
import { language } from "src/lang"
import { updateTextThemeAndCSS } from "./gui/colorscheme"
import { defaultHotkeys, hotkeyMatches, isSupportedHotkey } from "./defaulthotkeys"
import { bindPersonaToCurrentChat, bindPromptPresetToCurrentChat } from "./chatBindings"
import { resolveRequestDiagnosticContext } from "./requestDiagnostics"

let hotkeyInitialized = false

export function initHotkey() {
    if (hotkeyInitialized) return
    hotkeyInitialized = true

    document.addEventListener('keydown', async (event) => {
        const activeElement = document.activeElement as HTMLElement | null
        if (
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            !!activeElement &&
            (activeElement.tagName === 'INPUT' ||
                activeElement?.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable)
        ) {
            return
        }

        const database = getDatabase()
        const hotkeys = database?.hotkeys ?? defaultHotkeys
        let handled = false

        for (const hotkey of hotkeys) {
            if (!isSupportedHotkey(hotkey)) continue
            if (!hotkeyMatches(hotkey, event)) continue

                switch (hotkey.action) {
                case 'reroll':
                    handled = clickVisibleMessageAction('.button-icon-reroll')
                    break
                case 'unreroll':
                    handled = clickVisibleMessageAction('.button-icon-unreroll')
                    break
                case 'translate':
                    handled = clickVisibleMessageAction('.button-icon-translate')
                    break
                case 'remove':
                    handled = clickVisibleMessageAction('.button-icon-remove')
                    break
                case 'edit':
                    handled = clickVisibleMessageAction('.button-icon-edit')
                    if (handled) {
                        setTimeout(() => focusQuery('.message-edit-area'), 100)
                    }
                    break
                case 'copy':
                    handled = clickVisibleMessageAction('.button-icon-copy')
                    break
                case 'focusInput':
                    handled = focusQuery('.text-input-area')
                    break
                case 'settings':
                    settingsOpen.set(!get(settingsOpen))
                    handled = true
                    break
                case 'home':
                    selectedCharID.set(-1)
                    handled = true
                    break
                case 'presets':
                    if (!getCurrentChat()) break
                    presetSelectCallback.set(bindPromptPresetToCurrentChat)
                    openPresetList.set(!get(openPresetList))
                    handled = true
                    break
                case 'persona':
                    if (!getCurrentChat()) break
                    personaSelectCallback.set(bindPersonaToCurrentChat)
                    openPersonaList.set(!get(openPersonaList))
                    handled = true
                    break
                case 'modelSelect':
                    if (!getCurrentChat()) break
                    openModelPresetList.set(!get(openModelPresetList))
                    handled = true
                    break
                case 'toggleCSS':
                    SafeModeStore.set(!get(SafeModeStore))
                    updateTextThemeAndCSS()
                    handled = true
                    break
                case 'prevChar':
                    handled = selectAdjacentCharacter(-1)
                    break
                case 'nextChar':
                    handled = selectAdjacentCharacter(1)
                    break
                case 'quickMenu':
                    void quickMenu()
                    handled = true
                    break
                case 'previewRequest':
                    requestPreviewOpen.set(true)
                    handled = true
                    break
                case 'toggleLog':
                    handled = openVisibleMessageRequestLog()
                    break
                case 'quickSettings':
                    if (!isSelectedCharacterSidebarAvailable()) break
                    if (get(botMakerMode)) {
                        QuickSettings.open = !QuickSettings.open
                        QuickSettings.index = 0
                    }
                    // Keep the application shortcut from falling through to a
                    // browser/desktop-host Ctrl+Q action while the chat tab is active.
                    handled = true
                    break
                case 'toggleSidebarView':
                    if (!isSelectedCharacterSidebarAvailable()) break

                    if (get(botMakerMode)) {
                        botMakerMode.set(false)
                        QuickSettings.open = false
                    } else {
                        botMakerMode.set(true)
                    }
                    sidebarDevTool.set(false)
                    handled = true
                    break
                case 'scrollToActiveChar':
                    window.dispatchEvent(new CustomEvent('scrollToActiveCharacter'))
                    handled = true
                    break
                case 'popupEditor':
                    // The shared textarea owns this action so it can bind the edited
                    // value back to the field that opened the popup.
                    break
            }

            if (handled) break
        }

        if (handled) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        if (event.key === 'Escape') {
            if (doingAlert() || document.querySelector('[aria-modal="true"][data-state="open"]')) {
                event.preventDefault()
                return
            }
            if (get(settingsOpen)) settingsOpen.set(false)
            event.preventDefault()
        }
        if (event.key === 'Enter') {
            const alertType = get(alertStore).type
            if (alertType === 'ask' || alertType === 'normal' || alertType === 'error') {
                alertStore.set({ type: 'none', msg: 'yes' })
            }
        }
    })

    let touchCount = 0
    let touchStartTime = 0
    document.addEventListener('touchstart', () => {
        const quickMenuHotkey = getDatabase().hotkeys?.find((hotkey) => hotkey.action === 'quickMenu')
        if (quickMenuHotkey?.disabled) return
        touchCount++
        if (touchCount > 2) {
            if (Date.now() - touchStartTime > 300) return
            touchCount = 0
            if (!doingAlert()) void quickMenu()
        }
        if (touchCount === 1) touchStartTime = Date.now()
    })
    document.addEventListener('touchend', () => {
        touchCount = 0
    })

}

function isSelectedCharacterSidebarAvailable(): boolean {
    return get(sideBarStore) && get(selectedCharID) >= 0 && !get(settingsOpen)
}

export function findMostVisibleMessageAction(root: HTMLElement, selector: string): HTMLElement | null {
    const message = findMostVisibleMessage(root, (candidate) => !!candidate.querySelector(selector))
    return message?.querySelector<HTMLElement>(selector) ?? null
}

export function findMostVisibleMessage(
    root: HTMLElement,
    isEligible: (message: HTMLElement) => boolean = () => true,
): HTMLElement | null {
    const viewport = root.getBoundingClientRect()
    let fullyVisibleMessage: HTMLElement | null = null
    let fullyVisibleBottom = Number.NEGATIVE_INFINITY
    let bestMessage: HTMLElement | null = null
    let bestArea = 0
    let bestTop = Number.NEGATIVE_INFINITY

    for (const message of root.querySelectorAll<HTMLElement>('[data-chat-index]')) {
        if (!isEligible(message)) continue

        const rect = message.getBoundingClientRect()
        const visibleWidth = Math.max(0, Math.min(rect.right, viewport.right) - Math.max(rect.left, viewport.left))
        const visibleHeight = Math.max(0, Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top))
        const visibleArea = visibleWidth * visibleHeight
        const fullyVisible = visibleArea > 0
            && rect.top >= viewport.top
            && rect.right <= viewport.right
            && rect.bottom <= viewport.bottom
            && rect.left >= viewport.left

        if (fullyVisible) {
            if (rect.bottom > fullyVisibleBottom) {
                fullyVisibleMessage = message
                fullyVisibleBottom = rect.bottom
            }
            continue
        }

        if (visibleArea > bestArea || (visibleArea === bestArea && visibleArea > 0 && rect.top > bestTop)) {
            bestMessage = message
            bestArea = visibleArea
            bestTop = rect.top
        }
    }

    return fullyVisibleMessage ?? bestMessage
}

function clickVisibleMessageAction(selector: string): boolean {
    const root = document.querySelector<HTMLElement>('[data-chat-scroll-root]')
    const element = root ? findMostVisibleMessageAction(root, selector) : null
    if (!element) return false
    element.click()
    return true
}

function openVisibleMessageRequestLog(): boolean {
    const root = document.querySelector<HTMLElement>('[data-chat-scroll-root]')
    const chat = getCurrentChat()
    if (!root || !chat) return false

    const target = findMostVisibleMessage(root, (element) => {
        const index = Number(element.dataset.chatIndex)
        if (!Number.isInteger(index)) return false
        const message = chat.message[index]
        if (!message) return false
        const context = resolveRequestDiagnosticContext(message, message.generationInfo)
        return Object.keys(context.generationInfo).length > 0
    })
    if (!target) return false

    const index = Number(target.dataset.chatIndex)
    const message = chat.message[index]
    const context = resolveRequestDiagnosticContext(message, message.generationInfo)
    alertRequestData({ genInfo: context.generationInfo, idx: index, initialTab: requestDiagnosticsTabs.requestLog })
    return true
}

function focusQuery(selector: string): boolean {
    const element = document.querySelector<HTMLElement>(selector)
    if (!element) return false
    element.focus()
    return true
}

export function getSidebarCharacterOrder(database: {
    characters: { chaId: string }[]
    characterOrder: (string | { data: string[] })[]
}): number[] {
    const indexById = new Map(database.characters.map((character, index) => [character.chaId, index]))
    const orderedIds = (database.characterOrder ?? []).flatMap((entry) =>
        typeof entry === 'string' ? [entry] : (entry?.data ?? [])
    )

    return orderedIds
        .map((id) => indexById.get(id))
        .filter((index): index is number => index !== undefined)
}

function selectAdjacentCharacter(direction: -1 | 1): boolean {
    const database = getDatabase()
    const sidebarOrder = getSidebarCharacterOrder(database)
    const currentIndex = sidebarOrder.indexOf(get(selectedCharID))
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sidebarOrder.length) return false
    selectedCharID.set(sidebarOrder[nextIndex])
    OpenRealmStore.set(false)
    return true
}

export async function quickMenu(){
    const db = getDatabase()
    const showHypaV3 = db.hypaV3 && db.hypaV3Presets?.length > 1

    const options = [
        language.modelPresetMenu,
        `${language.promptPresetMenu} ${language.presets}`,
        language.persona,
        language.themePresets,
        ...(showHypaV3 ? [language.longTermMemory + ' ' + language.presets] : []),
        language.cancel
    ]

    const sel = parseInt(await alertSelect(options))
    let idx = 0
    if(sel === idx++){
        openModelPresetList.set(!get(openModelPresetList))
    }
    else if(sel === idx++){
        openPresetList.set(!get(openPresetList))
    }
    else if(sel === idx++){
        openPersonaList.set(!get(openPersonaList))
        personaSelectCallback.set(null)
    }
    else if(sel === idx++){
        openThemePresetList.set(!get(openThemePresetList))
    }
    else if(showHypaV3 && sel === idx++){
        openHypaV3PresetList.set(true)
    }
}
