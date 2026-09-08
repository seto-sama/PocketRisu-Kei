import { defaultColorScheme, normalizeColorScheme, withLegacyColorSchemeAliases, exportColorSchemeWithAliases } from "../../../server/shared/colorScheme.js";
import { get, writable } from "svelte/store";
import { getDatabase, setDatabase } from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { BufferToText, selectSingleFile } from "../util";
import { notifyError } from "../alert";
import { CustomCSSStore, SafeModeStore } from "../stores.svelte";
import { normalizeTextTheme } from "./textTheme";
import { applyFontPreference } from "./fontPreference";

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


export { defaultColorScheme, normalizeColorScheme, withLegacyColorSchemeAliases };

// Definition order is the dropdown order. Metadata stays outside persisted colors.
export const colorSchemes = {
    "default": { label: "Default", legacy: false, colors: defaultColorScheme },
    "dark": {
        label: "Dark",
        legacy: false,
        colors: {
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
    },
    "light": {
        label: "Light",
        legacy: false,
        colors: {
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
    },
    "realblack": {
        label: "Real Black",
        legacy: false,
        colors: {
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
    },
    "monokai-light": {
        label: "Monokai Light",
        legacy: false,
        colors: {
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
    },
    "monokai-black": {
        label: "Monokai Black",
        legacy: false,
        colors: {
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
    },
    "catppuccin-mocha": {
        label: "Catppuccin Mocha",
        legacy: false,
        colors: {
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
    },
    "catppuccin-macchiato": {
        label: "Catppuccin Macchiato",
        legacy: false,
        colors: {
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
    },
    "catppuccin-frappe": {
        label: "Catppuccin Frappé",
        legacy: false,
        colors: {
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
    },
    "catppuccin-latte": {
        label: "Catppuccin Latte",
        legacy: false,
        colors: {
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
    },
    "gruvbox-dark": {
        label: "Gruvbox Dark",
        legacy: false,
        colors: {
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
    },
    "gruvbox-light": {
        label: "Gruvbox Light",
        legacy: false,
        colors: {
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
    },
    "cherry": {
        label: "Cherry",
        legacy: true,
        colors: {
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
    },
    "galaxy": {
        label: "Galaxy",
        legacy: true,
        colors: {
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
    },
    "nature": {
        label: "Nature",
        legacy: true,
        colors: {
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
    },
    "lite": {
        label: "Lite",
        legacy: true,
        colors: {
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
        },
    }

} as const satisfies Record<string, { label: string; legacy: boolean; colors: ColorScheme }>

export const ColorSchemeTypeStore = writable('dark' as 'dark'|'light')

const EARLY_COLOR_SCHEME_CACHE_KEY = 'risu-early-color-scheme'

function cacheColorSchemeForNextLoad(colorScheme: ColorScheme) {
    try {
        localStorage.setItem(EARLY_COLOR_SCHEME_CACHE_KEY, JSON.stringify(colorScheme))
    } catch (_) {
        // The theme still works when storage is unavailable; only the early-load
        // palette restoration in index.html is skipped.
    }
}

export const colorSchemeList = Object.keys(colorSchemes) as (keyof typeof colorSchemes)[]

export function changeColorScheme(colorScheme: string){
    try {
        let db = getDatabase()
        if(colorScheme !== 'custom'){
            db.colorScheme = safeStructuredClone(colorSchemes[colorScheme].colors)
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
        cacheColorSchemeForNextLoad(colorScheme)
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
    let json = JSON.stringify(exportColorSchemeWithAliases(db.colorScheme))
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
    let textTheme = normalizeTextTheme(db.textTheme)
    let colorScheme = db.colorScheme.type
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

    applyFontPreference(db.font, db.customFont)

    if(!get(SafeModeStore)){
        CustomCSSStore.set([db.customCSS, db.globalCustomCSS].filter(Boolean).join('\n'))
    }
    else{
        CustomCSSStore.set('')
    }
}
