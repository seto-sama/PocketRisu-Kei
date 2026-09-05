export const SIDEBAR_MENU_HOME = 'core:home'
export const SIDEBAR_MENU_CHARACTERS = 'core:characters'
export const SIDEBAR_MENU_BOOKMARKS = 'core:bookmarks'
export const SIDEBAR_MENU_SETTINGS = 'core:settings'
export const SIDEBAR_MENU_DEFAULT_DIVIDER = 'divider:plugins'

export const SIDEBAR_MENU_CORE_KEYS = [
    SIDEBAR_MENU_HOME,
    SIDEBAR_MENU_CHARACTERS,
    SIDEBAR_MENU_BOOKMARKS,
    SIDEBAR_MENU_SETTINGS,
] as const

export const DEFAULT_SIDEBAR_MENU_ORDER = [
    ...SIDEBAR_MENU_CORE_KEYS,
    SIDEBAR_MENU_DEFAULT_DIVIDER,
]

export function pluginSidebarMenuKey(id: string): string {
    return `plugin:${id}`
}

export function automaticPluginSidebarMenuKey(pluginName: string, menuName: string, index: number): string {
    return pluginSidebarMenuKey(
        `auto:${encodeURIComponent(pluginName)}:${encodeURIComponent(menuName)}:${index}`
    )
}

export function dividerSidebarMenuKey(id: string): string {
    return `divider:${id}`
}

export function isSidebarMenuDivider(key: string): boolean {
    return key.startsWith('divider:')
}

export function normalizeSidebarMenuOrder(value: unknown): string[] {
    const source = Array.isArray(value) ? value : DEFAULT_SIDEBAR_MENU_ORDER
    const unique = [...new Set(source.filter((key): key is string => typeof key === 'string' && key.length > 0))]
    const missingCore = SIDEBAR_MENU_CORE_KEYS.filter((key) => !unique.includes(key))
    const normalized = [...unique]
    for (const key of missingCore) {
        if (key === SIDEBAR_MENU_BOOKMARKS) {
            const settingsIndex = normalized.indexOf(SIDEBAR_MENU_SETTINGS)
            if (settingsIndex >= 0) {
                normalized.splice(settingsIndex, 0, key)
                continue
            }
        }
        normalized.push(key)
    }
    return normalized
}

export function normalizeSidebarMenuHidden(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((key): key is string => typeof key === 'string'))]
}

export function appendNewPluginMenuItems(order: string[], pluginKeys: string[]): string[] {
    const next = [...order]
    const known = new Set(next)
    for (const key of pluginKeys) {
        if (!known.has(key)) {
            next.push(key)
            known.add(key)
        }
    }
    return next
}

export function getVisibleSidebarMenuOrder(
    order: string[],
    pluginKeys: string[],
    editing: boolean,
    hiddenKeys: string[] = [],
): string[] {
    const availablePlugins = new Set(pluginKeys)
    const hidden = new Set(hiddenKeys)
    const available = order.filter((key) =>
        (SIDEBAR_MENU_CORE_KEYS.includes(key as typeof SIDEBAR_MENU_CORE_KEYS[number])
            || isSidebarMenuDivider(key)
            || availablePlugins.has(key))
        && (editing || !hidden.has(key))
    )
    if (editing) return available

    const compacted: string[] = []
    let pendingDivider: string | undefined
    for (const key of available) {
        if (isSidebarMenuDivider(key)) {
            if (compacted.length > 0 && !pendingDivider) pendingDivider = key
            continue
        }
        if (pendingDivider) compacted.push(pendingDivider)
        compacted.push(key)
        pendingDivider = undefined
    }
    return compacted
}

export function getSidebarMenuDisplayOrder(order: string[], bottom: boolean): string[] {
    return bottom ? [...order].reverse() : order
}

// Reorder rendered entries without discarding positions reserved for temporarily unloaded plugins.
export function mergeVisibleSidebarMenuOrder(storedOrder: string[], visibleOrder: string[]): string[] {
    const visibleKeys = new Set(visibleOrder)
    let visibleIndex = 0
    const merged = storedOrder.map((key) =>
        visibleKeys.has(key) ? visibleOrder[visibleIndex++] : key
    )
    return [...merged, ...visibleOrder.slice(visibleIndex)]
}

type SidebarMenuPersistence = {
    sidebarMenuOrder?: string[]
    sidebarMenuHidden?: string[]
    sidebarMenuPluginOwners?: Record<string, string>
}

export function rememberPluginSidebarMenuItem(
    state: SidebarMenuPersistence,
    menuKey: string,
    pluginName: string,
): void {
    state.sidebarMenuPluginOwners ??= {}
    if (state.sidebarMenuPluginOwners[menuKey] !== pluginName) {
        state.sidebarMenuPluginOwners[menuKey] = pluginName
    }
}

export function removeSidebarMenuKeys(state: SidebarMenuPersistence, keys: Iterable<string>): void {
    const removed = new Set(keys)
    if (removed.size === 0) return
    state.sidebarMenuOrder = (state.sidebarMenuOrder ?? []).filter((key) => !removed.has(key))
    state.sidebarMenuHidden = (state.sidebarMenuHidden ?? []).filter((key) => !removed.has(key))
    for (const key of removed) delete state.sidebarMenuPluginOwners?.[key]
}

export function removePluginSidebarMenuItems(state: SidebarMenuPersistence, pluginName: string): void {
    const ownedKeys = Object.entries(state.sidebarMenuPluginOwners ?? {})
        .filter(([, owner]) => owner === pluginName)
        .map(([key]) => key)
    removeSidebarMenuKeys(state, ownedKeys)
}
