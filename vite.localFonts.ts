import { readdirSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)

interface FontkitAxis {
    min: number
    default: number
    max: number
}

interface FontkitFont {
    familyName?: string | null
    fullName?: string | null
    subfamilyName?: string | null
    italicAngle?: number
    variationAxes?: Record<string, FontkitAxis>
    getName?: (key: string) => string | null
    'OS/2'?: {
        usWeightClass?: number
        fsSelection?: {
            italic?: boolean
            oblique?: boolean
        }
    }
}

interface FontkitModule {
    openSync: (path: string) => FontkitFont
}

interface LocalFontFace {
    family: string
    path: string
    format: string
    style: 'normal' | 'italic'
    minWeight: number
    maxWeight: number
    variableWeight: boolean
}

interface LocalFontFamily {
    family: string
    variableWeight: boolean
}

interface LocalFontManifest {
    css: string
    families: LocalFontFamily[]
    warnings: string[]
}

const { openSync } = require('fontkit') as FontkitModule

const FONT_FORMATS = new Map([
    ['.woff2', 'woff2'],
    ['.woff', 'woff'],
    ['.ttf', 'truetype'],
    ['.otf', 'opentype'],
])

export const LOCAL_FONTS_CSS_ID = 'virtual:pocketrisu-local-fonts.css'
export const LOCAL_FONT_FAMILIES_ID = 'virtual:pocketrisu-local-font-families'

const RESOLVED_LOCAL_FONTS_CSS_ID = `\0${LOCAL_FONTS_CSS_ID}`
const RESOLVED_LOCAL_FONT_FAMILIES_ID = `\0${LOCAL_FONT_FAMILIES_ID}`

function listFontFiles(directory: string): string[] {
    try {
        return readdirSync(directory, { withFileTypes: true })
            .flatMap((entry) => {
                const path = resolve(directory, entry.name)
                if (entry.isDirectory()) {
                    return listFontFiles(path)
                }
                if (!entry.isFile() || !FONT_FORMATS.has(extname(entry.name).toLowerCase())) {
                    return []
                }
                return [path]
            })
            .sort((a, b) => a.localeCompare(b))
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
            return []
        }
        throw error
    }
}

function getPreferredName(font: FontkitFont, key: string): string | null {
    return font.getName?.(key)?.trim() || null
}

function resolveFamilyName(font: FontkitFont, hasWeightAxis: boolean): string {
    const preferredFamily = getPreferredName(font, 'preferredFamily')
        ?? getPreferredName(font, 'wwsFamilyName')
    const familyName = font.familyName?.trim()

    if (hasWeightAxis) {
        return preferredFamily ?? familyName ?? font.fullName?.trim() ?? ''
    }

    return familyName ?? preferredFamily ?? font.fullName?.trim() ?? ''
}

function normalizeWeight(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value)) {
        return fallback
    }
    return Math.min(1000, Math.max(1, value as number))
}

function detectStyle(font: FontkitFont): 'normal' | 'italic' {
    const selection = font['OS/2']?.fsSelection
    const subfamily = getPreferredName(font, 'preferredSubfamily') ?? font.subfamilyName ?? ''
    if (selection?.italic || selection?.oblique || font.italicAngle || /\b(?:italic|oblique)\b/i.test(subfamily)) {
        return 'italic'
    }
    return 'normal'
}

function escapeCssString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\d ')
        .replace(/\n/g, '\\a ')
}

function publicFontUrl(fontDirectory: string, path: string): string {
    const encodedPath = relative(fontDirectory, path)
        .split(/[\\/]/)
        .map((segment) => encodeURIComponent(segment))
        .join('/')
    return `/assets/fonts/${encodedPath}`
}

function createFontFace(fontDirectory: string, path: string): LocalFontFace {
    const font = openSync(path)
    const weightAxis = font.variationAxes?.wght
    const family = resolveFamilyName(font, Boolean(weightAxis))
    if (!family) {
        throw new Error('font family metadata is missing')
    }

    const staticWeight = normalizeWeight(font['OS/2']?.usWeightClass, 400)
    const minWeight = weightAxis ? normalizeWeight(weightAxis.min, staticWeight) : staticWeight
    const maxWeight = weightAxis ? normalizeWeight(weightAxis.max, staticWeight) : staticWeight

    return {
        family,
        path: publicFontUrl(fontDirectory, path),
        format: FONT_FORMATS.get(extname(path).toLowerCase()) as string,
        style: detectStyle(font),
        minWeight: Math.min(minWeight, maxWeight),
        maxWeight: Math.max(minWeight, maxWeight),
        variableWeight: Boolean(weightAxis),
    }
}

function renderFontFace(face: LocalFontFace): string {
    const weight = face.minWeight === face.maxWeight
        ? String(face.minWeight)
        : `${face.minWeight} ${face.maxWeight}`

    return [
        '@font-face {',
        `  font-family: "${escapeCssString(face.family)}";`,
        `  src: url("${escapeCssString(face.path)}") format("${face.format}");`,
        `  font-weight: ${weight};`,
        `  font-style: ${face.style};`,
        '  font-display: swap;',
        '}',
    ].join('\n')
}

export function scanLocalFonts(fontDirectory: string): LocalFontManifest {
    const faces: LocalFontFace[] = []
    const warnings: string[] = []

    for (const path of listFontFiles(fontDirectory)) {
        try {
            faces.push(createFontFace(fontDirectory, path))
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            warnings.push(`Could not read local font ${relative(fontDirectory, path)}: ${message}`)
        }
    }

    const familyMap = new Map<string, LocalFontFamily>()
    for (const face of faces) {
        const key = face.family.toLowerCase()
        const existing = familyMap.get(key)
        if (existing) {
            existing.variableWeight ||= face.variableWeight
        } else {
            familyMap.set(key, {
                family: face.family,
                variableWeight: face.variableWeight,
            })
        }
    }
    const families = [...familyMap.values()].sort((a, b) => a.family.localeCompare(b.family))

    return {
        css: faces.map(renderFontFace).join('\n\n'),
        families,
        warnings,
    }
}

export function localFontsPlugin(fontDirectory = resolve(process.cwd(), 'public/assets/fonts')): Plugin {
    let manifest: LocalFontManifest | undefined

    const getManifest = () => {
        manifest ??= scanLocalFonts(fontDirectory)
        return manifest
    }

    return {
        name: 'pocketrisu-local-fonts',
        buildStart() {
            for (const warning of getManifest().warnings) {
                this.warn(warning)
            }
        },
        resolveId(id) {
            if (id === LOCAL_FONTS_CSS_ID) {
                return RESOLVED_LOCAL_FONTS_CSS_ID
            }
            if (id === LOCAL_FONT_FAMILIES_ID) {
                return RESOLVED_LOCAL_FONT_FAMILIES_ID
            }
        },
        load(id) {
            if (id === RESOLVED_LOCAL_FONTS_CSS_ID) {
                return getManifest().css
            }
            if (id === RESOLVED_LOCAL_FONT_FAMILIES_ID) {
                return `export const localFontFamilies = ${JSON.stringify(getManifest().families)};`
            }
        },
    }
}
