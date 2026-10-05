import { language } from 'src/lang'
import { valuesEqual } from '../../../shared/guardedDelta.mjs'
import type { MergeConflict, MergePath } from '../storage/patchRebase'

type Preview = { name: string, type: string, text: string }
type ConflictBlock = { server: Preview, local: Preview }

const fieldAliases: Record<string, keyof typeof language> = {
    characters: 'characterList',
    chats: 'chatList',
    personas: 'persona',
    savedToggleValues: 'toggleBindingLabel',
    globalChatVariables: 'chatVariables',
    localLore: 'loreBook',
    bindedPersona: 'personaBindingLabel',
    bindedBotPreset: 'promptBindingLabel',
    usePromptPresetParams: 'promptPresetParamsUse',
    botPresets: 'promptPresets',
    hypaV3Data: 'longTermMemory',
}

const isObject = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

function format(template: string, index: number) {
    return template.replaceAll('{index}', String(index + 1))
}

function fieldLabel(field: string, path: MergePath, source: unknown) {
    if (field === 'message') return language.saveConflict.messages
    if (field === 'note' && (path.includes('chats') || isObject(source) && Array.isArray(source.message))) return language.authorNote
    const parent = path.at(-2)
    if (field === 'data' && typeof parent !== 'string' && parent?.key === 'chatId') return language.saveConflict.data
    const toggleKey = path.includes('savedToggleValues') || path.includes('globalChatVariables')
        ? field.replace(/^toggle_/, '') : field
    const key = fieldAliases[field] ?? toggleKey
    const namespace = path.slice(0, -1).reduce<any>((current, part) =>
        typeof part === 'string' ? current?.[part] : current, language)
    for (const candidate of [namespace?.[key], (language as Record<string, unknown>)[key],
        (language.formating as Record<string, unknown>)[key], (language.triggerInputLabels as Record<string, unknown>)[key]]) {
        if (typeof candidate === 'string') return candidate
    }
    return toggleKey
}

function conflictPathLabel(path: MergePath, source: unknown, index: number): string {
    let current: any = source
    const labels: string[] = []
    for (let position = 0; position < path.length; position++) {
        const part = path[position]
        const next = path[position + 1]
        if (typeof part === 'string') {
            if (!(part === 'message' && typeof next !== 'string' && next?.key === 'chatId')) {
                labels.push(fieldLabel(part, path.slice(0, position + 1), source))
            }
            current = current?.[part]
        } else {
            const itemIndex = Array.isArray(current) ? current.findIndex(item => item?.[part.key] === part.value) : -1
            current = itemIndex >= 0 ? current[itemIndex] : undefined
            labels.push(current?.name || (part.key === 'chatId'
                ? format(language.saveConflict.message, itemIndex >= 0 ? itemIndex : index)
                : format(language.saveConflict.item, itemIndex >= 0 ? itemIndex : index)))
        }
    }
    return labels.join(' › ')
}

function valueType(value: unknown) {
    if (value === undefined) return language.saveConflict.deleted
    if (value === null) return language.saveConflict.valueTypes.null
    if (Array.isArray(value)) return language.saveConflict.valueTypes.list
    return language.saveConflict.valueTypes[typeof value as 'string' | 'number' | 'boolean' | 'object']
}

function valueText(value: unknown) {
    if (value === undefined) return language.saveConflict.deleted
    if (typeof value === 'string') return value || language.saveConflict.empty
    return JSON.stringify(value, null, 2) ?? String(value)
}

function roleLabel(value: unknown) {
    return value === 'user' ? language.user : value === 'char' ? language.character : valueText(value)
}

export function presentSaveConflict(conflict: MergeConflict, index: number, source?: unknown) {
    const label = conflictPathLabel(conflict.path, source, index)
    const message = conflict.path.some(part => typeof part !== 'string' && part.key === 'chatId')
    const blocks: ConflictBlock[] = []
    const preview = (value: unknown, path: MergePath, side: 'server' | 'local'): Preview => {
        const relative = path.slice(conflict.path.length)
        const name = relative.length ? relative.map((field, position) =>
            typeof field === 'string' ? fieldLabel(field, path.slice(0, conflict.path.length + position + 1), source) : field.value,
        ).join(' › ') : label
        const parentPath = path.at(-2)
        if (path.at(-1) === 'data' && typeof parentPath !== 'string' && parentPath?.key === 'chatId') {
            const parent = conflict[side]
            const type = parent?.kind === 'imageGeneration' ? language.imageGeneration
                : parent?.role ? roleLabel(parent.role) : valueType(value)
            return {
                name: parent?.name || parent?.saying || label,
                type: value === undefined ? language.saveConflict.deleted : type,
                text: valueText(value),
            }
        }
        const text = path.at(-1) === 'role' && message ? roleLabel(value) : valueText(value)
        return { name, type: valueType(value), text }
    }
    const collect = (server: any, local: any, path: MergePath) => {
        if (valuesEqual(server, local)) return
        if ((isObject(server) || server === undefined) && (isObject(local) || local === undefined)) {
            const keys = new Set([...Object.keys(server ?? {}), ...Object.keys(local ?? {})])
            if (keys.size > 0) {
                for (const key of keys) collect(server?.[key], local?.[key], [...path, key])
                return
            }
        }
        blocks.push({ server: preview(server, path, 'server'), local: preview(local, path, 'local') })
    }
    if (conflict.kind === 'order') {
        const ids = [...new Set([...(conflict.base ?? []), ...conflict.local, ...conflict.server])]
        const names = new Map(ids.map((id, index) => [id, format(language.saveConflict.item, index)]))
        const text = (value: string[]) => value.map(id => names.get(id)).join('\n') || language.saveConflict.empty
        blocks.push({
            server: { name: language.saveConflict.changedOrder, type: valueType(conflict.server), text: text(conflict.server) },
            local: { name: language.saveConflict.changedOrder, type: valueType(conflict.local), text: text(conflict.local) },
        })
    } else {
        collect(conflict.server, conflict.local, conflict.path)
    }
    return { label, blocks }
}
