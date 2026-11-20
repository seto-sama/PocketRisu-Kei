export interface Hotkey {
    key: string
    ctrl?: boolean
    shift?: boolean
    alt?: boolean
    /** The Win / Super / ⌘ key. */
    meta?: boolean
    disabled?: boolean
    action: string
}

export const hotkeyActionGroups = {
    chatInput: ['focusInput'],
    toolbar: ['translate', 'edit', 'remove', 'reroll', 'unreroll'],
    menu: ['home', 'settings', 'quickMenu', 'previewRequest', 'toggleLog'],
    features: ['popupEditor', 'toggleCSS'],
    sidebar: [
        'quickSettings',
        'toggleSidebarView',
        'presets',
        'persona',
        'modelSelect',
        'prevChar',
        'nextChar',
        'scrollToActiveChar',
    ],
} as const

export function hotkeyMatches(hotkey: Hotkey | undefined, event: KeyboardEvent): boolean {
    if (!hotkey?.key || hotkey.disabled) return false
    if ((hotkey.ctrl ?? false) !== event.ctrlKey) return false
    if ((hotkey.alt ?? false) !== event.altKey) return false
    if ((hotkey.shift ?? false) !== event.shiftKey) return false
    if ((hotkey.meta ?? false) !== event.metaKey) return false
    if (hotkey.key.toLowerCase() !== event.key.toLowerCase()) return false

    // Shift alone only types capitals, so a Shift-only hotkey must not swallow text entry.
    if (!hotkey.ctrl && !hotkey.alt && !hotkey.meta) {
        const activeElement = document.activeElement as HTMLElement | null
        if (activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA') return false
    }
    return true
}

export const defaultHotkeys: Hotkey[] = [
    { key: 'r', ctrl: true, alt: true, action: 'reroll' },
    { key: 'f', ctrl: true, alt: true, action: 'unreroll' },
    { key: 't', ctrl: true, alt: true, action: 'translate' },
    { key: 'd', ctrl: true, alt: true, action: 'remove' },
    { key: 'e', ctrl: true, alt: true, action: 'edit' },
    { key: 's', ctrl: true, action: 'settings' },
    { key: 'h', ctrl: true, action: 'home' },
    { key: 'p', ctrl: true, action: 'presets' },
    { key: 'e', ctrl: true, action: 'persona' },
    { key: 'm', ctrl: true, action: 'modelSelect' },
    { key: '.', ctrl: true, action: 'toggleCSS' },
    { key: '[', ctrl: true, action: 'prevChar' },
    { key: ']', ctrl: true, action: 'nextChar' },
    { key: '`', ctrl: true, action: 'quickMenu' },
    { key: 'q', ctrl: true, action: 'quickSettings' },
    { key: 'q', ctrl: true, alt: true, action: 'toggleSidebarView' },
    { key: 'l', ctrl: true, action: 'toggleLog' },
    { key: 'u', ctrl: true, action: 'previewRequest' },
    { key: ' ', action: 'focusInput' },
    { key: 'g', ctrl: true, action: 'scrollToActiveChar' },
    { key: 'x', ctrl: true, action: 'popupEditor' },
]

const supportedHotkeyActions: ReadonlySet<string> = new Set(
    defaultHotkeys.map((hotkey) => hotkey.action),
)

export function isSupportedHotkey(hotkey: Hotkey): boolean {
    return supportedHotkeyActions.has(hotkey.action)
}
