import { get, writable } from "svelte/store";
import { getDatabase, setDatabase } from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { BufferToText, selectSingleFile } from "../util";
import { notifyError } from "../alert";
import { isLite } from "../lite";
import { CustomCSSStore, SafeModeStore } from "../stores.svelte";
import { normalizeTextTheme } from "./textTheme";
import { localFontFamilies } from "virtual:pocketrisu-local-font-families";
import { resolveLocalFontSelection } from "./fontSelection";

export interface ColorScheme{
    lightbg: string;
    darkbg: string;
    lightborderc: string;
    selected: string;
    darkborderc: string;
    button: string;
    maintext: string;
    subtext: string;
    white?: string;
    black?: string;
    danger: string;
    highlight?: string;
    warning?: string;
    success?: string;
    primary: string;
    accent?: string;
    scoped?: string;
    type:'light'|'dark';
}

export interface LegacyColorSchemeAliases {
    /** @deprecated Use `lightbg`. */
    bgcolor: string;
    /** @deprecated Use `lightborderc`. */
    borderc: string;
    /** @deprecated Use `darkborderc`. */
    darkBorderc: string;
    /** @deprecated Use `button`. */
    darkbutton: string;
    /** @deprecated Use `maintext`. */
    textcolor: string;
    /** @deprecated Use `subtext`. */
    textcolor2: string;
    /** @deprecated Use `danger`. */
    draculared: string;
}

export type LegacyColorScheme = Omit<ColorScheme, 'lightbg' | 'lightborderc' | 'darkborderc' | 'button' | 'maintext' | 'subtext' | 'danger'> & LegacyColorSchemeAliases


export const defaultColorScheme: ColorScheme = {
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

/** Converts persisted/imported legacy schemes to the canonical token names. */
export function normalizeColorScheme(input: unknown): ColorScheme | null {
    if(input == null || typeof input !== 'object'){
        return null
    }

    const source = input as Record<string, unknown>
    const read = (key: string, legacyKey?: string) => {
        const value = source[key] ?? (legacyKey == null ? undefined : source[legacyKey])
        return typeof value === 'string' ? value : undefined
    }

    const lightbg = read('lightbg', 'bgcolor')
    const darkbg = read('darkbg')
    const lightborderc = read('lightborderc', 'borderc')
    const selected = read('selected')
    const darkborderc = read('darkborderc', 'darkBorderc')
    const button = read('button', 'darkbutton')
    const maintext = read('maintext', 'textcolor')
    const subtext = read('subtext', 'textcolor2')
    const danger = read('danger', 'draculared')
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

/** Adds read-compatible aliases at external API boundaries without polluting internal state. */
export function withLegacyColorSchemeAliases(colorScheme: ColorScheme): ColorScheme & LegacyColorSchemeAliases {
    return {
        ...colorScheme,
        bgcolor: colorScheme.lightbg,
        borderc: colorScheme.lightborderc,
        darkBorderc: colorScheme.darkborderc,
        darkbutton: colorScheme.button,
        textcolor: colorScheme.maintext,
        textcolor2: colorScheme.subtext,
        draculared: colorScheme.danger,
    }
}

// Built-in palette pack (Catppuccin / Gruvbox). Spread into colorShemes after
// the kept classics so they sit in the upper half of the scheme dropdown. Keys
// follow the existing kebab-case convention; display names live in
// colorSchemeLabels.
const newColorSchemes = {
    "catppuccin-mocha": {
        lightbg: "#1e1e2e",
        darkbg: "#181825",
        lightborderc: "#b4befe",
        selected: "#6c7086",
        darkborderc: "#9399b2",
        button: "#45475a",
        maintext: "#cdd6f4",
        subtext: "#a6adc8",
        danger: "#f38ba8",
        primary: "#cba6f7",
        type:'dark'
    },
    "catppuccin-macchiato": {
        lightbg: "#24273a",
        darkbg: "#1e2030",
        lightborderc: "#b7bdf8",
        selected: "#6e738d",
        darkborderc: "#8087a2",
        button: "#181926",
        maintext: "#cad3f5",
        subtext: "#a5adcb",
        danger: "#ee99a0",
        primary: "#f5bde6",
        type:'dark'
    },
    "catppuccin-frappe": {
        lightbg: "#303446",
        darkbg: "#292c3c",
        lightborderc: "#8caaee",
        selected: "#737994",
        darkborderc: "#949cbb",
        button: "#303446",
        maintext: "#c6d0f5",
        subtext: "#a5adce",
        danger: "#e78284",
        primary: "#85c1dc",
        type:'dark'
    },
    "catppuccin-latte": {
        lightbg: "#ccd0da",
        darkbg: "#bcc0cc",
        lightborderc: "#7287fd",
        selected: "#eff1f5",
        darkborderc: "#e6e9ef",
        button: "#dce0e8",
        maintext: "#4c4f69",
        subtext: "#5c5f77",
        danger: "#d20f39",
        primary: "#df8e1d",
        type:'light'
    },
    "gruvbox-dark": {
        lightbg: "#282828",
        darkbg: "#1d2021",
        lightborderc: "#3c3836",
        selected: "#504945",
        darkborderc: "#665c64",
        button: "#7c6f64",
        maintext: "#ebdbb2",
        subtext: "#fbf1c7",
        danger: "#fabd2f",
        primary: "#fe8019",
        type:'dark'
    },
    "gruvbox-light": {
        lightbg: "#fbf1c7",
        darkbg: "#f2e5bc",
        lightborderc: "#ebdbb2",
        selected: "#d5c4a1",
        darkborderc: "#bdae93",
        button: "#a89984",
        maintext: "#3c3836",
        subtext: "#282828",
        danger: "#d65d0e",
        primary: "#fe8019",
        type:'light'
    },
} as const

const colorShemes = {
    "default": defaultColorScheme,
    "dark": {
        lightbg: "#1a1a1a",
        darkbg: "#141414",
        lightborderc: "#525252",
        selected: "#3d3d3d",
        darkborderc: "#404040",
        button: "#2e2e2e",
        maintext: "#f5f5f5",
        subtext: "#a3a3a3",
        danger: "#ff5555",
        primary: "#3b82f6",
        type:'dark'
    },
    "light": {
        lightbg: "#ffffff",
        darkbg: "#f0f0f0",
        lightborderc: "#0f172a",
        selected: "#e0e0e0",
        darkborderc: "#d1d5db",
        button: "#e5e7eb",
        maintext: "#0f172a",
        subtext: "#64748b",
        danger: "#ff5555",
        primary: "#2563eb",
        type:'light'
    },
    "realblack": {
        lightbg: "#000000",
        darkbg: "#000000",
        lightborderc: "#6272a4",
        selected: "#44475a",
        darkborderc: "#4b5563",
        button: "#374151",
        maintext: "#f8f8f2",
        subtext: "#64748b",
        danger: "#ff5555",
        primary: "#3b82f6",
        type:'dark'
    },
    "monokai-light": {
        lightbg: "#f8f8f2",
        darkbg: "#e8e8e3",
        lightborderc: "#75715e",
        selected: "#d8d8d0",
        darkborderc: "#c0c0b8",
        button: "#d0d0c8",
        maintext: "#272822",
        subtext: "#75715e",
        danger: "#f92672",
        primary: "#f92672",
        type:'light'
    },
    "monokai-black": {
        lightbg: "#272822",
        darkbg: "#1e1f1a",
        lightborderc: "#75715e",
        selected: "#3e3d32",
        darkborderc: "#3e3d32",
        button: "#3e3d32",
        maintext: "#f8f8f2",
        subtext: "#a6a68a",
        danger: "#f92672",
        primary: "#f92672",
        type:'dark'
    },
    ...newColorSchemes,
    "cherry": {
        lightbg: "#450a0a",
        darkbg: "#7f1d1d",
        lightborderc: "#ea580c",
        selected: "#d97706",
        darkborderc: "#92400e",
        button: "#b45309",
        maintext: "#f8f8f2",
        subtext: "#fca5a5",
        danger: "#ff5555",
        primary: "#fb923c",
        type:'dark'
    },
    "galaxy": {
        lightbg: "#0f172a",
        darkbg: "#1f2a48",
        lightborderc: "#8be9fd",
        selected: "#457b9d",
        darkborderc: "#457b9d",
        button: "#1f2a48",
        maintext: "#f8f8f2",
        subtext: "#8be9fd",
        danger: "#ff5555",
        primary: "#a78bfa",
        type:'dark'
    },
    "nature": {
        lightbg: "#1b4332",
        darkbg: "#2d6a4f",
        lightborderc: "#a8dadc",
        selected: "#4d908e",
        darkborderc: "#457b9d",
        button: "#2d6a4f",
        maintext: "#f8f8f2",
        subtext: "#4d908e",
        danger: "#ff5555",
        primary: "#52b788",
        type:'dark'
    },
    "lite": {
        lightbg: "#1f2937",
        darkbg: "#1C2533",
        lightborderc: "#475569",
        selected: "#475569",
        darkborderc: "#030712",
        button: "#374151",
        maintext: "#f8f8f2",
        subtext: "#64748b",
        danger: "#ff5555",
        primary: "#3b82f6",
        type:'dark'
    }

} as const

export const ColorSchemeTypeStore = writable('dark' as 'dark'|'light')

export const colorSchemeList = Object.keys(colorShemes) as (keyof typeof colorShemes)[]

// Non-legacy schemes: the app default, the new palette pack, and the still-kept
// classics (dark / light / realblack / monokai). Everything else is a legacy
// scheme — hidden behind the "show legacy palettes" toggle and shown with a
// "(legacy)" suffix in the dropdown.
export const nonLegacyColorSchemes = new Set<string>([
    "default", "dark", "light", "realblack", "monokai-light", "monokai-black",
    ...Object.keys(newColorSchemes),
])

// Pretty display labels for the scheme keys (keys are kebab-case for data/code
// compatibility). "default" is localized separately via a lang key; any key
// without an entry falls back to the raw key.
export const colorSchemeLabels: Record<string, string> = {
    dark: "Dark",
    light: "Light",
    realblack: "Real Black",
    "monokai-light": "Monokai Light",
    "monokai-black": "Monokai Black",
    "catppuccin-mocha": "Catppuccin Mocha",
    "catppuccin-macchiato": "Catppuccin Macchiato",
    "catppuccin-frappe": "Catppuccin Frappé",
    "catppuccin-latte": "Catppuccin Latte",
    "gruvbox-dark": "Gruvbox Dark",
    "gruvbox-light": "Gruvbox Light",
    cherry: "Cherry",
    galaxy: "Galaxy",
    nature: "Nature",
    lite: "Lite",
}

export function changeColorScheme(colorScheme: string){
    try {
        let db = getDatabase()
        if(colorScheme !== 'custom'){
            db.colorScheme = safeStructuredClone(colorShemes[colorScheme])
        }
        db.colorSchemeName = colorScheme
        updateColorScheme()   
    } catch (error) {}
}

export function updateColorScheme(){
    try {
        let db = getDatabase()

        let colorScheme = db.colorScheme

        if(colorScheme == null){
            colorScheme = safeStructuredClone(defaultColorScheme)
            db.colorScheme = colorScheme
        }

        if(get(isLite)){
            colorScheme = safeStructuredClone(colorShemes.lite)
        }

        colorScheme.highlight ??= defaultColorScheme.highlight
        colorScheme.warning ??= defaultColorScheme.warning
        colorScheme.success ??= defaultColorScheme.success
        colorScheme.primary ??= defaultColorScheme.primary
        colorScheme.accent ??= defaultColorScheme.accent
        colorScheme.scoped ??= defaultColorScheme.scoped
        colorScheme.white ??= defaultColorScheme.white
        colorScheme.black ??= defaultColorScheme.black

        //set css variables
        document.documentElement.style.setProperty("--risu-theme-lightbg", colorScheme.lightbg);
        document.documentElement.style.setProperty("--risu-theme-darkbg", colorScheme.darkbg);
        document.documentElement.style.setProperty("--risu-theme-lightborderc", colorScheme.lightborderc);
        document.documentElement.style.setProperty("--risu-theme-selected", colorScheme.selected);
        document.documentElement.style.setProperty("--risu-theme-darkborderc", colorScheme.darkborderc);
        document.documentElement.style.setProperty("--risu-theme-button", colorScheme.button);
        document.documentElement.style.setProperty("--risu-theme-maintext", colorScheme.maintext);
        document.documentElement.style.setProperty("--risu-theme-subtext", colorScheme.subtext);
        document.documentElement.style.setProperty("--risu-theme-white", colorScheme.white);
        document.documentElement.style.setProperty("--risu-theme-black", colorScheme.black);
        document.documentElement.style.setProperty("--risu-theme-danger", colorScheme.danger);
        document.documentElement.style.setProperty("--risu-theme-highlight", colorScheme.highlight);
        document.documentElement.style.setProperty("--risu-theme-warning", colorScheme.warning);
        document.documentElement.style.setProperty("--risu-theme-success", colorScheme.success);
        document.documentElement.style.setProperty("--risu-theme-primary", colorScheme.primary);
        document.documentElement.style.setProperty("--risu-theme-accent", colorScheme.accent);
        document.documentElement.style.setProperty("--risu-theme-scoped", colorScheme.scoped);
        ColorSchemeTypeStore.set(colorScheme.type)
    } catch (error) {}
}

export function changeColorSchemeType(type: 'light'|'dark'){
    try {
        let db = getDatabase()
        db.colorScheme.type = type
        updateColorScheme()
        updateTextThemeAndCSS()
    } catch (error) {}
}

export function exportColorScheme(){
    let db = getDatabase()
    let json = JSON.stringify(db.colorScheme)
    downloadFile('colorScheme.json', json)
}

export async function importColorScheme(){
    const uarray = await selectSingleFile(['json'])
    if(uarray == null){
        return
    }
    const string = BufferToText(uarray.data)
    try{
        const colorScheme = normalizeColorScheme(JSON.parse(string))
        if(colorScheme == null){
            notifyError('Invalid color scheme')
            return
        }
        changeColorScheme('custom')
        let db = getDatabase()
        db.colorScheme = colorScheme
        updateColorScheme()
    }
    catch(e){
        notifyError('Invalid color scheme')
        return
    
    }
}

export function updateTextThemeAndCSS(){
    let db = getDatabase()
    const root = document.querySelector(':root') as HTMLElement;
    if(!root){
        return
    }
    let textTheme = normalizeTextTheme(get(isLite) ? 'standard' : db.textTheme)
    let colorScheme = get(isLite) ? 'dark' : db.colorScheme.type
    switch(textTheme){
        case "standard":{
            if(colorScheme === 'dark'){
                root.style.setProperty('--FontColorStandard', '#fafafa');
                root.style.setProperty('--FontColorItalic', '#8C8D93');
                root.style.setProperty('--FontColorBold', '#fafafa');
                root.style.setProperty('--FontColorItalicBold', '#8C8D93');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }else{
                root.style.setProperty('--FontColorStandard', '#0f172a');
                root.style.setProperty('--FontColorItalic', '#8C8D93');
                root.style.setProperty('--FontColorBold', '#0f172a');
                root.style.setProperty('--FontColorItalicBold', '#8C8D93');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            break
        }
        case "highcontrast":{
            if(colorScheme === 'dark'){
                root.style.setProperty('--FontColorStandard', '#f8f8f2');
                root.style.setProperty('--FontColorItalic', '#F1FA8C');
                root.style.setProperty('--FontColorBold', '#8BE9FD');
                root.style.setProperty('--FontColorItalicBold', '#FFB86C');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            else{
                root.style.setProperty('--FontColorStandard', '#0f172a');
                root.style.setProperty('--FontColorItalic', '#F1FA8C');
                root.style.setProperty('--FontColorBold', '#8BE9FD');
                root.style.setProperty('--FontColorItalicBold', '#FFB86C');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            break
        }
        case "custom":{
            root.style.setProperty('--FontColorStandard', db.customTextTheme.FontColorStandard);
            root.style.setProperty('--FontColorItalic', db.customTextTheme.FontColorItalic);
            root.style.setProperty('--FontColorBold', db.customTextTheme.FontColorBold);
            root.style.setProperty('--FontColorItalicBold', db.customTextTheme.FontColorItalicBold);
            root.style.setProperty('--FontColorQuote1', db.customTextTheme.FontColorQuote1 ?? '#8BE9FD');
            root.style.setProperty('--FontColorQuote2', db.customTextTheme.FontColorQuote2 ?? '#FFB86C');
            break
        }
    }

    switch(db.font){
        case "default":{
            root.style.setProperty('--risu-font-family', 'Arial, sans-serif');
            root.style.removeProperty('font-weight')
            break
        }
        case "timesnewroman":{
            root.style.setProperty('--risu-font-family', 'Times New Roman, serif');
            root.style.removeProperty('font-weight')
            break
        }
        case "custom":{
            const selection = resolveLocalFontSelection(db.customFont, localFontFamilies)
            root.style.setProperty('--risu-font-family', selection.family);
            if (selection.weight === null) {
                root.style.removeProperty('font-weight')
            } else {
                root.style.setProperty('font-weight', String(selection.weight))
            }
            break
        }
    }

    if(!get(SafeModeStore)){
        CustomCSSStore.set([db.customCSS, db.globalCustomCSS].filter(Boolean).join('\n'))
    }
    else{
        CustomCSSStore.set('')
    }
}
