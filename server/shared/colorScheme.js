/** @typedef {import("../../src/ts/gui/colorscheme").ColorScheme} ColorScheme */
/** @typedef {import("../../src/ts/gui/colorscheme").LegacyColorSchemeAliases} LegacyColorSchemeAliases */

const legacyAliases = {
    lightbg: 'bgcolor',
    lightborderc: 'borderc',
    darkborderc: 'darkBorderc',
    button: 'darkbutton',
    maintext: 'textcolor',
    subtext: 'textcolor2',
    danger: 'draculared',
};

/** @type {ColorScheme} */
export const defaultColorScheme = {
    lightbg: "#282a36",
    darkbg: "#21222c",
    lightborderc: "#6272a4",
    selected: "#44475a",
    darkborderc: "#4b5563",
    button: "#374151",
    maintext: "#f8f8f2",
    subtext: "#64748b",
    white: "#ffffff",
    black: "#000000",
    danger: "#ff5555",
    highlight: "#f59e0b",
    warning: "#ffca1e",
    success: "#4ade80",
    primary: "#3b82f6",
    accent: "#7581ff",
    scoped: "#a470ff",
    type:'dark'
}

/**
 * Converts persisted/imported legacy schemes to the canonical token names.
 * @param {unknown} input
 * @returns {ColorScheme | null}
 */
export function normalizeColorScheme(input) {
    if(input == null || typeof input !== 'object'){
        return null
    }

    const source = /** @type {Record<string, unknown>} */ (input)
    const read = (key) => {
        const value = source[key] ?? source[legacyAliases[key]]
        return typeof value === 'string' ? value : undefined
    }

    const lightbg = read('lightbg')
    const darkbg = read('darkbg')
    const lightborderc = read('lightborderc')
    const selected = read('selected')
    const darkborderc = read('darkborderc')
    const button = read('button')
    const maintext = read('maintext')
    const subtext = read('subtext')
    const danger = read('danger')
    const type = source.type

    if(
        lightbg == null || darkbg == null || lightborderc == null || selected == null ||
        darkborderc == null || button == null || maintext == null || subtext == null ||
        danger == null || (type !== 'light' && type !== 'dark')
    ){
        return null
    }

    return {
        lightbg,
        darkbg,
        lightborderc,
        selected,
        darkborderc,
        button,
        maintext,
        subtext,
        danger,
        white: read('white') ?? defaultColorScheme.white,
        black: read('black') ?? defaultColorScheme.black,
        highlight: read('highlight') ?? defaultColorScheme.highlight,
        warning: read('warning') ?? defaultColorScheme.warning,
        success: read('success') ?? defaultColorScheme.success,
        primary: read('primary') ?? defaultColorScheme.primary,
        accent: read('accent') ?? defaultColorScheme.accent,
        scoped: read('scoped') ?? defaultColorScheme.scoped,
        type,
    }
}

/**
 * Adds read-compatible aliases at external API boundaries without polluting internal state.
 * @param {ColorScheme} colorScheme
 * @returns {ColorScheme & LegacyColorSchemeAliases}
 */
export function withLegacyColorSchemeAliases(colorScheme) {
    return {
        ...colorScheme,
        .../** @type {LegacyColorSchemeAliases} */ (Object.fromEntries(Object.entries(legacyAliases).map(([key, alias]) => [alias, colorScheme[key]]))),
    }
}

/** Normalize only an export copy, retaining extension tokens and repairing partial saves. */
export function exportColorSchemeWithAliases(input) {
    const source = input && typeof input === 'object' ? input : {};
    // Legacy-only values must take precedence over defaults, but canonical values win
    // over stale aliases.
    const repaired = { ...source };
    for (const [key, value] of Object.entries(defaultColorScheme)) {
        if (typeof repaired[key] !== 'string') {
            const alias = legacyAliases[key];
            repaired[key] = typeof source[alias] === 'string' ? source[alias] : value;
        }
    }
    if (repaired.type !== 'light' && repaired.type !== 'dark') repaired.type = defaultColorScheme.type;
    const normalized = normalizeColorScheme(repaired);
    return withLegacyColorSchemeAliases({ ...source, ...normalized });
}

/** Copy the database/preset color boundaries only; never mutate stored objects. */
export function withExportColorSchemes(data) {
    const copy = { ...data, colorScheme: exportColorSchemeWithAliases(data.colorScheme) };
    if (Array.isArray(data.themePresets)) {
        copy.themePresets = data.themePresets.map(preset =>
            preset && typeof preset === 'object' ? withExportColorSchemes(preset) : preset);
    }
    return copy;
}
