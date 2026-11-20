import { get } from "svelte/store"
import { alertRequestData, alertSelect, doingAlert, requestDiagnosticsTabs } from "./alert"
import { getCurrentChat, getDatabase  } from "./storage/database.svelte"
import { changeChar } from './characters'
import {
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
import { editableFieldFor, requestPopupEditor } from './gui/editableField'
import { installMultiFingerTap } from './gui/multiFingerTap'
import { handleTextEntryEscape, isTextEntryElement, requestDialogCloseAction } from './gui/escapeKey'

let hotkeyInitialized = false

export function initHotkey() {
    if (hotkeyInitialized) return
    hotkeyInitialized = true

    // Handle field overlays before blur or parent dismissal during capture.
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.isComposing) return
        const activeElement = document.activeElement as HTMLElement | null
        if (!isTextEntryElement(activeElement)) return
        const focusReturnTarget = activeElement.closest<HTMLElement>('[role="dialog"][tabindex]')
        event.preventDefault()
        event.stopImmediatePropagation()
        if (handleTextEntryEscape(activeElement)) return
        activeElement.blur()
        focusReturnTarget?.focus({ preventScroll: true })
    }, true)

    document.addEventListener('keydown', async (event) => {
        const activeElement = document.activeElement as HTMLElement | null
        const focusedTextEntry = isTextEntryElement(activeElement)
        if (event.defaultPrevented) return
        // Shift alone only types capitals, so it never turns text entry into a hotkey.
        if (
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            focusedTextEntry
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
            if (requestDialogCloseAction()) {
                event.preventDefault()
            }
        }
    })

    // Touch gestures are the mobile entry points, so they stay on even when the
    // matching keyboard hotkey is disabled.
    installMultiFingerTap((fingers, target) => {
        switch (fingers) {
            case 3:
                if (!doingAlert()) void quickMenu()
                return true
            case 4:
                return requestPopupEditor(editableFieldFor(target))
            default:
                return false
        }
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
    characters: { chaId: string; trashTime?: number }[]
    characterOrder: (string | { data: string[] })[]
}): string[] {
    const characterIds = new Set(database.characters.filter(character => !character.trashTime).map(character => character.chaId))
    const orderedIds = (database.characterOrder ?? []).flatMap((entry) =>
        typeof entry === 'string' ? [entry] : (entry?.data ?? [])
    )

    return orderedIds.filter(id => characterIds.has(id))
}

function selectAdjacentCharacter(direction: -1 | 1): boolean {
    const database = getDatabase()
    const sidebarOrder = getSidebarCharacterOrder(database)
    const currentCharacterId = database.characters[get(selectedCharID)]?.chaId
    const currentIndex = sidebarOrder.indexOf(currentCharacterId)
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sidebarOrder.length) return false
    if (!changeChar(sidebarOrder[nextIndex])) return false
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
