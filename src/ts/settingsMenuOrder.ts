export const SETTINGS_MENU_SEARCH = 'core:search'
export const SETTINGS_MENU_LANGUAGE = 'core:10'

export const DEFAULT_SETTINGS_MENU_ORDER = [
    SETTINGS_MENU_SEARCH,
    'core:16',
    'core:17',
    'core:12',
    'core:2',
    SETTINGS_MENU_LANGUAGE,
    'core:4',
    'core:3',
    'core:11',
    'core:25',
    'core:6',
    'core:23',
    'core:21',
    'core:22',
    'core:24',
] as const

const settingsMenuKeys = new Set<string>(DEFAULT_SETTINGS_MENU_ORDER)

export function settingsMenuKey(route: number): string {
    return `core:${route}`
}

export function normalizeSettingsMenuOrder(value: unknown): string[] {
    if (!Array.isArray(value)) return [...DEFAULT_SETTINGS_MENU_ORDER]

    const normalized = [...new Set(value.filter(
        (key): key is string => typeof key === 'string' && settingsMenuKeys.has(key),
    ))]
    for (const key of DEFAULT_SETTINGS_MENU_ORDER) {
        if (!normalized.includes(key)) normalized.push(key)
    }
    return normalized
}

export function getVisibleSettingsMenuOrder(order: string[], lite: boolean): string[] {
    const visibleKeys = lite
        ? new Set([SETTINGS_MENU_SEARCH, SETTINGS_MENU_LANGUAGE])
        : settingsMenuKeys
    return order.filter((key) => visibleKeys.has(key))
}

// Preserve the positions of entries hidden by the Lite UI while reordering visible entries.
export function mergeVisibleSettingsMenuOrder(storedOrder: string[], visibleOrder: string[]): string[] {
    const visibleKeys = new Set(visibleOrder)
    let visibleIndex = 0
    return storedOrder.map((key) =>
        visibleKeys.has(key) ? visibleOrder[visibleIndex++] : key
    )
}
