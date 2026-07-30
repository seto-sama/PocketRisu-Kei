import { get } from "svelte/store"
import { alertMd, alertSelect, alertWait, doingAlert } from "./alert"
import { getDatabase  } from "./storage/database.svelte"
import {
    AdminStatsSubmenuIndex,
    alertStore,
    MobileGUIStack,
    MobileSideBar,
    openHypaV3PresetList,
    openModelPresetList,
    openPersonaList,
    openPresetList,
    openThemePresetList,
    OpenRealmStore,
    personaSelectCallback,
    PlaygroundStore,
    QuickSettings,
    SafeModeStore,
    selectedCharID,
    settingsOpen,
} from "./stores.svelte"
import { language } from "src/lang"
import { updateTextThemeAndCSS } from "./gui/colorscheme"
import { defaultHotkeys, hotkeyMatches } from "./defaulthotkeys"
import { openSettings, SettingsRoute } from "./routing"

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

        if (database.enableHotkeys !== false) {
            for (const hotkey of hotkeys) {
                if (!hotkeyMatches(hotkey, event)) continue

                switch (hotkey.action) {
                case 'reroll':
                    handled = clickQuery('.button-icon-reroll')
                    break
                case 'unreroll':
                    handled = clickQuery('.button-icon-unreroll')
                    break
                case 'translate':
                    handled = clickQuery('.button-icon-translate')
                    break
                case 'remove':
                    handled = clickQuery('.button-icon-remove')
                    break
                case 'edit':
                    handled = clickQuery('.button-icon-edit')
                    if (handled) {
                        setTimeout(() => focusQuery('.message-edit-area'), 100)
                    }
                    break
                case 'copy':
                    handled = clickQuery('.button-icon-copy')
                    break
                case 'focusInput':
                    handled = focusQuery('.text-input-area')
                    break
                case 'send':
                    handled = clickQuery('.button-icon-send')
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
                    openPresetList.set(!get(openPresetList))
                    handled = true
                    break
                case 'persona':
                    openPersonaList.set(!get(openPersonaList))
                    personaSelectCallback.set(null)
                    handled = true
                    break
                case 'modelSelect':
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
                    const chatProcess = await import('./process/index.svelte')
                    if (get(chatProcess.doingChat) && get(selectedCharID) !== -1) break
                    alertWait('Loading...')
                    event.preventDefault()
                    event.stopPropagation()
                    try {
                        await chatProcess.sendChat(-1, { previewPrompt: true })
                        const body = JSON.stringify(JSON.parse(chatProcess.previewBody), null, 2).replaceAll('```', '\\`\\`\\`')
                        alertMd(`### Prompt\n\`\`\`json\n${body}\n\`\`\`\n`)
                    } finally {
                        chatProcess.doingChat.set(false)
                    }
                    return
                case 'toggleLog':
                    openSettings(SettingsRoute.AdminAndStats)
                    AdminStatsSubmenuIndex.set(1)
                    handled = true
                    break
                case 'quickSettings':
                    QuickSettings.open = !QuickSettings.open
                    QuickSettings.index = 0
                    handled = true
                    break
                case 'scrollToActiveChar':
                    if (database.enableScrollToActiveChar !== false) {
                        window.dispatchEvent(new CustomEvent('scrollToActiveCharacter'))
                        handled = true
                    }
                    break
                case 'popupEditor':
                    // TextAreaInput owns this action so it can bind the edited
                    // value back to the field that opened the popup.
                    break
                }

                if (handled) break
            }
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
        if (getDatabase().enableHotkeys === false) return
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

    let lastScrollTime = 0
    const scrollCooldown = 500
    document.addEventListener('dragover', (event) => {
        if (getDatabase().enableHotkeys === false) return
        if (!event.ctrlKey || event.shiftKey || event.altKey) return
        if (!event.dataTransfer?.types.includes('application/x-risu-internal')) return
        if (getDatabase().enableScrollToActiveChar === false) return
        const now = Date.now()
        if (now - lastScrollTime <= scrollCooldown) return
        lastScrollTime = now
        window.dispatchEvent(new CustomEvent('scrollToActiveCharacter'))
    }, true)
}

function clickQuery(selector: string): boolean {
    const element = document.querySelector<HTMLElement>(selector)
    if (!element) return false
    element.click()
    return true
}

function focusQuery(selector: string): boolean {
    const element = document.querySelector<HTMLElement>(selector)
    if (!element) return false
    element.focus()
    return true
}

function selectAdjacentCharacter(direction: -1 | 1): boolean {
    const database = getDatabase()
    const sorted = database.characters
        .map((character, index) => ({ name: character.name, index }))
        .sort((a, b) => a.name.localeCompare(b.name))
    const currentIndex = sorted.findIndex(({ index }) => index === get(selectedCharID))
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sorted.length) return false
    selectedCharID.set(sorted[nextIndex].index)
    PlaygroundStore.set(0)
    OpenRealmStore.set(false)
    return true
}

export async function quickMenu(){
    const db = getDatabase()
    const showHypaV3 = db.hypaV3 && db.hypaV3Presets?.length > 1

    const options = [
        language.presets,
        language.themePresets,
        language.persona,
        ...(showHypaV3 ? [language.longTermMemory + ' ' + language.presets] : []),
        language.cancel
    ]

    const sel = parseInt(await alertSelect(options))
    let idx = 0
    if(sel === idx++){
        openPresetList.set(!get(openPresetList))
    }
    else if(sel === idx++){
        openThemePresetList.set(!get(openThemePresetList))
    }
    else if(sel === idx++){
        openPersonaList.set(!get(openPersonaList))
        personaSelectCallback.set(null)
    }
    else if(showHypaV3 && sel === idx++){
        openHypaV3PresetList.set(true)
    }
}

export function initMobileGesture(){
    let pressingPointers = new Map<number, {x:number, y:number}>()

    document.addEventListener('pointerdown', (event) => {
        if(
            !event.isPrimary
            || (event.pointerType === 'mouse' && event.button !== 0)
            || (event.target instanceof Element && event.target.closest('button, input, select, textarea'))
        ){
            pressingPointers.delete(event.pointerId)
            return
        }
        pressingPointers.set(event.pointerId, {x: event.clientX, y: event.clientY})
    })

    document.addEventListener('pointerup', (event) => {
        const start = pressingPointers.get(event.pointerId)
        pressingPointers.delete(event.pointerId)
        if(!start){
            return
        }
        const moveX = event.clientX - start.x
        const moveY = event.clientY - start.y

        if(moveX > 50 && Math.abs(moveY) < Math.abs(moveX)){
            if(get(selectedCharID) === -1){
                if(get(MobileGUIStack) > 0){
                    MobileGUIStack.update(v => v - 1)
                }
            }
            else{
                if(get(MobileSideBar) > 0){
                    MobileSideBar.update(v => v - 1)
                }
            }
        }
        else if(moveX < -50 && Math.abs(moveY) < Math.abs(moveX)){
            if(get(selectedCharID) === -1){
                if(get(MobileGUIStack) < 2){
                    MobileGUIStack.update(v => v + 1)
                }
            }
            else{
                if(get(MobileSideBar) < 3){
                    MobileSideBar.update(v => v + 1)
                }
            }
        }
    })

    document.addEventListener('pointercancel', (event) => {
        pressingPointers.delete(event.pointerId)
    })
}
