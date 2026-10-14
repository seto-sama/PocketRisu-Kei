import type { RisuModule } from '../process/modules'
import type { character, Database, loreBook } from '../storage/database.svelte'
import { createEntityId } from '../id'
import { getChatBoundPersona } from '../chatBindingState'
import { getChatPage } from '../storage/chatSelection.svelte'
import { language } from 'src/lang'
import { ensureImageStylePresetModule, IMAGE_STYLE_PRESET_MODULE_NAMESPACE } from './stylePresets'

const CHARACTER_TAG_LOREBOOK_NAME = 'lb-xnai.lb.extra'
const bundlePrefix = /^###(?!#)[\t ]*/

export interface ImageTagBundle {
    name: string
    content: string
    source: string
}

type BundleDatabase = { modules: RisuModule[] } & Partial<Pick<Database, 'username' | 'personas' | 'showPersonaInSidebar'>>
type BundleCharacter = Pick<character, 'name' | 'globalLore'> & Partial<Pick<character, 'nickname' | 'chats' | 'chaId'>>

function findBundleLorebook(module?: RisuModule): loreBook | undefined {
    if (!module?.imageTagBundleLorebookId) return undefined
    return module.lorebook?.find(book => book.mode !== 'folder'
        && book.extentions?.risu_imageTagBundleId === module.imageTagBundleLorebookId)
}

function parseImageTagBundles(content: string, source: string): ImageTagBundle[] {
    const headings = [...content.matchAll(/^###[\t ]+([^\r\n]+)\r?$/gm)]
    return headings.flatMap((heading, index) => {
        const name = heading[1].trim()
        const tags = content.slice(heading.index! + heading[0].length, headings[index + 1]?.index).trim()
        return name && tags ? [{ name, content: tags, source }] : []
    })
}

export function listImageTagBundles(db: BundleDatabase, currentCharacter?: BundleCharacter): ImageTagBundle[] {
    const persona = getChatBoundPersona({ personas: db.personas, showPersonaInSidebar: db.showPersonaInSidebar },
        currentCharacter?.chats?.[getChatPage(currentCharacter)])
    const names = { char: currentCharacter?.nickname || currentCharacter?.name, user: persona?.name ?? db.username ?? 'User' }
    const resolveNames = (text: string) => text.replace(/\{\{(char|user)\}\}/gi,
        (match, name: string) => names[name.toLowerCase() as keyof typeof names] ?? match)
    const sources = [
        ...(currentCharacter?.globalLore ?? [])
            .filter(book => book.mode !== 'folder' && book.comment.trim() === CHARACTER_TAG_LOREBOOK_NAME && !book.alwaysActive)
            .map(book => ({ book, source: currentCharacter!.name })),
        ...db.modules.flatMap(module => {
            const book = findBundleLorebook(module)
            return book ? [{ book, source: module.name }] : []
        }),
    ]
    const bundles = new Map<string, ImageTagBundle>()
    for (const { book, source } of sources) {
        for (const bundle of parseImageTagBundles(book.content, source)) {
            bundle.name = resolveNames(bundle.name)
            bundle.content = resolveNames(bundle.content)
            const key = bundle.name.toLowerCase()
            if (!bundles.has(key)) bundles.set(key, bundle)
        }
    }
    return [...bundles.values()]
}

export function isImageTagBundleQuery(query: string): boolean {
    return bundlePrefix.test(query)
}

export function searchImageTagBundles(query: string, bundles: ImageTagBundle[]): ImageTagBundle[] {
    const name = query.replace(bundlePrefix, '').trim().toLowerCase()
    return bundles.filter(bundle => bundle.name.toLowerCase().includes(name))
}

export function expandImageTagBundles(prompt: string, bundles: ImageTagBundle[]): { prompt: string; bundleNames: string[] } {
    if (!bundles.length || !prompt.includes('###')) return { prompt, bundleNames: [] }
    const byName = new Map(bundles.map(bundle => [bundle.name.toLowerCase(), bundle]))
    const names = [...byName.keys()].sort((left, right) => right.length - left.length)
        .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const references = new RegExp(`(?<!#)###[\\t ]*(${names.join('|')})(?=[\\t ]*(?:$|[,|.\\r\\n:}\\])]))`, 'gi')
    const bundleNames = new Set<string>()
    const expanded = prompt.replace(references, (_reference, name: string) => {
        const bundle = byName.get(name.toLowerCase())!
        bundleNames.add(bundle.name)
        return bundle.content
    })
    return { prompt: expanded, bundleNames: [...bundleNames] }
}

export function getImageTagBundleLorebook(db: BundleDatabase, moduleId?: string): loreBook | undefined {
    const module = db.modules.find(item => moduleId ? item.id === moduleId : item.namespace === IMAGE_STYLE_PRESET_MODULE_NAMESPACE)
    return findBundleLorebook(module)
}

export function saveImageTagBundleLorebook(db: BundleDatabase, content: string, moduleId?: string): void {
    const existing = getImageTagBundleLorebook(db, moduleId)
    if (existing) { existing.content = content; return }
    const module = db.modules.find(item => item.id === moduleId) ?? ensureImageStylePresetModule(db)
    module.lorebook ??= []
    const id = createEntityId()
    module.lorebook.push({
        key: '', secondkey: '', insertorder: 1000,
        comment: language.imageCharacterPreset, content,
        extentions: { risu_case_sensitive: false, risu_imageTagBundleId: id },
        mode: 'normal', alwaysActive: false, selective: false, useRegex: false,
    })
    module.imageTagBundleLorebookId = id
}
