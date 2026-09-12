import { createEntityId } from '../id'
import type { RisuModule } from '../process/modules'
import type { loreBook } from '../storage/database.svelte'

export const IMAGE_STYLE_PRESET_MODULE_NAMESPACE = 'Kei_Img_Preset'
export const IMAGE_STYLE_PRESET_MODULE_NAME = '그림체 프리셋'
export const IMAGE_STYLE_PRESET_PREFIX = '프리셋 '

export interface ImageStylePresetEntry {
    id: string
    moduleId: string
    moduleName: string
    lorebookIndex: number
    name: string
    content: string
    lorebookFolder?: string
}

interface ImageGenerationBindingDatabase {
    imageGenerationPresets: { id: string }[]
    imageGenerationPresetId: number
}

interface ImageStylePresetDatabase {
    modules: RisuModule[]
    enabledModules: string[]
}

function canUseSecondaryKeyAsPresetId(lorebook: loreBook): boolean {
    return !(lorebook.key ?? '').trim() && !lorebook.alwaysActive && !lorebook.selective
}

function isImageStylePresetLorebook(lorebook: loreBook): boolean {
    const comment = lorebook.comment?.trim() ?? ''
    return lorebook.mode !== 'folder'
        && comment.startsWith(IMAGE_STYLE_PRESET_PREFIX)
        && (/\[Positive\]/i.test(lorebook.content ?? '') || /\[Negative\]/i.test(lorebook.content ?? ''))
}

export function getImageStylePresetId(module: RisuModule, lorebook: loreBook): string {
    if (!(lorebook.secondkey ?? '').trim() && canUseSecondaryKeyAsPresetId(lorebook)) {
        lorebook.secondkey = lorebook.id || createEntityId()
    }
    return JSON.stringify([module.id, lorebook.id || lorebook.secondkey || lorebook.comment])
}

export function normalizeImageStylePresetName(name: string): string {
    const trimmed = name.trim()
    return trimmed.startsWith(IMAGE_STYLE_PRESET_PREFIX)
        ? trimmed.slice(IMAGE_STYLE_PRESET_PREFIX.length).trim()
        : trimmed
}

export function listImageStylePresets(db: Pick<ImageStylePresetDatabase, 'modules'>): ImageStylePresetEntry[] {
    return (db.modules ?? []).flatMap(module => (module.lorebook ?? []).flatMap((lorebook, lorebookIndex) => {
        const comment = lorebook.comment?.trim() ?? ''
        if (!isImageStylePresetLorebook(lorebook)) return []
        return [{
            id: getImageStylePresetId(module, lorebook),
            moduleId: module.id,
            moduleName: module.name,
            lorebookIndex,
            name: comment.slice(IMAGE_STYLE_PRESET_PREFIX.length).trim() || comment,
            content: lorebook.content,
            lorebookFolder: lorebook.folder,
        }]
    }))
}

export function ensureImageStylePresetModule(db: ImageStylePresetDatabase): RisuModule {
    let module = db.modules.find(item => item.namespace === IMAGE_STYLE_PRESET_MODULE_NAMESPACE)
    if (!module) {
        module = {
            id: createEntityId(),
            name: IMAGE_STYLE_PRESET_MODULE_NAME,
            description: '이미지 생성 그림체 프리셋',
            namespace: IMAGE_STYLE_PRESET_MODULE_NAMESPACE,
            lorebook: [],
        }
        db.modules.push(module)
    }
    module.lorebook ??= []
    if (!db.enabledModules.includes(module.id)) db.enabledModules.push(module.id)
    return module
}

export function formatImageStylePresetContent(
    positive: string,
    negative: string,
    imageGenerationPresetId = '',
    preamble = '',
): string {
    const sections = `[Positive]\n${positive.trim()}\n\n[Negative]\n${negative.trim()}`
    const binding = imageGenerationPresetId ? `[Binding]\n${imageGenerationPresetId}\n\n` : ''
    const prefix = preamble.trim() ? `${preamble.trim()}\n\n` : ''
    return `${prefix}${binding}${sections}`
}

export function createImageStylePreset(
    db: ImageStylePresetDatabase,
    name: string,
    positive: string,
    negative: string,
    target: {
        moduleId?: string
        lorebookFolder?: string
        imageGenerationPresetId?: string
    } = {},
): ImageStylePresetEntry {
    const module = db.modules.find(item => item.id === target.moduleId)
        ?? ensureImageStylePresetModule(db)
    module.lorebook ??= []
    const trimmedName = normalizeImageStylePresetName(name)
    if (!trimmedName) throw new Error('Image style preset name is required')
    const lorebook: loreBook = {
        key: '',
        secondkey: createEntityId(),
        insertorder: 1000,
        comment: `${IMAGE_STYLE_PRESET_PREFIX}${trimmedName}`,
        content: formatImageStylePresetContent(positive, negative, target.imageGenerationPresetId),
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        useRegex: false,
        folder: target.lorebookFolder,
    }
    module.lorebook.push(lorebook)
    return {
        id: getImageStylePresetId(module, lorebook),
        moduleId: module.id,
        moduleName: module.name,
        lorebookIndex: module.lorebook.length - 1,
        name: trimmedName,
        content: lorebook.content,
        lorebookFolder: lorebook.folder,
    }
}

export function createImageStyleLorebookFolder(
    db: Pick<ImageStylePresetDatabase, 'modules'>,
    moduleId: string,
    name: string,
): string | undefined {
    const module = db.modules.find(item => item.id === moduleId)
    if (!module) return undefined
    const trimmedName = name.trim()
    if (!trimmedName) return undefined
    module.lorebook ??= []
    const key = `\uf000folder:${createEntityId()}`
    module.lorebook.push({
        key,
        secondkey: '',
        insertorder: 1000,
        comment: trimmedName,
        content: '',
        mode: 'folder',
        alwaysActive: false,
        selective: false,
        useRegex: false,
    })
    return key
}

export function parseImageStylePresetContent(content: string): {
    preamble: string
    positive: string
    negative: string
    imageGenerationPresetId: string
} {
    const positiveMarkerIndex = content.search(/\[Positive\]/i)
    const rawPreamble = positiveMarkerIndex >= 0 ? content.slice(0, positiveMarkerIndex) : ''
    const bindingMatch = rawPreamble.match(
        /\[Binding\][\t ]*\r?\n[\t ]*([^\r\n]+)\s*$/i,
    )
    const preamble = (bindingMatch?.index === undefined
        ? rawPreamble
        : rawPreamble.slice(0, bindingMatch.index)).trim()
    const positive = content.match(/\[Positive\]\s*([\s\S]*?)(?=\s*\[Negative\]|$)/i)?.[1]?.trim() ?? ''
    const negative = content.match(/\[Negative\]\s*([\s\S]*?)$/i)?.[1]?.trim() ?? ''
    const imageGenerationPresetId = bindingMatch?.[1]?.trim() ?? ''
    return { preamble, positive, negative, imageGenerationPresetId }
}

export function applyImageStylePresetBinding(
    db: ImageGenerationBindingDatabase,
    content: string,
): boolean {
    const { imageGenerationPresetId } = parseImageStylePresetContent(content)
    if (!imageGenerationPresetId) return false
    const index = db.imageGenerationPresets.findIndex(preset => preset.id === imageGenerationPresetId)
    if (index < 0) return false
    db.imageGenerationPresetId = index
    return true
}

function joinPrompt(prefix: string, input: string): string {
    if (!prefix) return input.trim()
    if (!input.trim()) return prefix.trim()
    return `${prefix.trim()}${prefix.trimEnd().endsWith(',') ? '\n' : ',\n'}${input.trim()}`
}

function fillPositiveTemplate(template: string, input: string): string {
    const hasInputSlot = template.includes('{prompt}') || template.includes('{setup}')
    let result = template
        .replaceAll('{prompt}', input.trim())
        .replaceAll('{setup}', input.trim())
        .replaceAll('{char}', '')
        .replaceAll('{supplement}', '')
        .trim()
    if (!hasInputSlot) result = joinPrompt(result, input)
    return result.replace(/\n{3,}/g, '\n\n')
}

function fillNegativeTemplate(template: string, input: string): string {
    const hasInputSlot = template.includes('{prompt}')
    let result = template
        .replaceAll('{prompt}', input.trim())
        .replaceAll('{setup}', '')
        .replaceAll('{char}', '')
        .replaceAll('{supplement}', '')
        .trim()
    if (!hasInputSlot) result = joinPrompt(result, input)
    return result.replace(/\n{3,}/g, '\n\n')
}

export function applyImageStylePreset(
    content: string,
    prompt: string,
    negativePrompt: string,
): { prompt: string, negativePrompt: string } {
    const parsed = parseImageStylePresetContent(content)
    return {
        prompt: fillPositiveTemplate(parsed.positive, prompt),
        negativePrompt: fillNegativeTemplate(parsed.negative, negativePrompt),
    }
}
