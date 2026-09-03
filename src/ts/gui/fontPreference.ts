import { localFontFamilies } from 'virtual:pocketrisu-local-font-families'
import { resolveLocalFontSelection, type ResolvedFontSelection } from './fontSelection'

const FONT_PREFERENCE_KEY = 'risu-font'

function renderFont(selection: ResolvedFontSelection) {
    const root = document.documentElement
    root.style.setProperty('--risu-font-family', selection.family)
    if (selection.weight === null) root.style.removeProperty('font-weight')
    else root.style.setProperty('font-weight', String(selection.weight))
}

/** Apply the saved theme's font and remember only its presentation for startup. */
export function applyFontPreference(font: string, customFont: string) {
    let selection: ResolvedFontSelection
    switch (font) {
        case 'default':
            selection = { family: 'Arial, sans-serif', weight: null }
            break
        case 'timesnewroman':
            selection = { family: 'Times New Roman, serif', weight: null }
            break
        case 'custom':
            selection = resolveLocalFontSelection(customFont, localFontFamilies)
            break
        default:
            return
    }
    renderFont(selection)
    try {
        const serialized = JSON.stringify(selection)
        if (localStorage.getItem(FONT_PREFERENCE_KEY) !== serialized) {
            localStorage.setItem(FONT_PREFERENCE_KEY, serialized)
        }
    } catch {
        // Font rendering still works when browser storage is unavailable.
    }
}

/** Runs before mounting the app, without loading the database or modules. */
export function applyEarlyFontPreference() {
    try {
        const cached = localStorage.getItem(FONT_PREFERENCE_KEY)
        if (!cached) return
        const selection = JSON.parse(cached)
        if (typeof selection?.family !== 'string' || !selection.family.trim()) return
        if (selection.weight !== null && (
            typeof selection.weight !== 'number'
            || !Number.isFinite(selection.weight)
            || selection.weight < 1 || selection.weight > 1000
        )) return
        renderFont(selection)
    } catch {
        // Missing/invalid presentation cache must not interrupt startup.
    }
}
