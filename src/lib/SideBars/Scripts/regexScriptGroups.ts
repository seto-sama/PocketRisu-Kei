import type { customscript } from 'src/ts/storage/database.svelte'

export const activeRegexScriptTypes = [
    'editinput',
    'editoutput',
    'editprocess',
    'editdisplay',
    'edittrans',
] as const

export type ActiveRegexScriptType = typeof activeRegexScriptTypes[number]

export interface RegexScriptGroup {
    scripts: customscript[]
    indexes: number[]
}

const activeTypeSet = new Set<string>(activeRegexScriptTypes)

export function isActiveRegexScriptType(type: string): type is ActiveRegexScriptType {
    return activeTypeSet.has(type)
}

function scriptContentKey(script: customscript): string {
    const content = Object.entries(script)
        .filter(([key, value]) =>
            key !== 'type' &&
            key !== 'ableFlag' &&
            key !== 'flag' &&
            value !== undefined
        )
        .sort(([a], [b]) => a.localeCompare(b))

    content.push(['ableFlag', !!script.ableFlag])
    if (script.ableFlag) {
        content.push(['flag', script.flag || 'g'])
    }

    return JSON.stringify(content)
}

/**
 * Presents upstream-compatible, single-type regex records as logical multi-type
 * groups. Duplicate records of the same type are deliberately kept separate:
 * they may be intended to run more than once.
 */
export function groupRegexScripts(scripts: customscript[]): RegexScriptGroup[] {
    const groups: RegexScriptGroup[] = []
    const compatibleGroups = new Map<string, RegexScriptGroup[]>()

    scripts.forEach((script, index) => {
        if (!isActiveRegexScriptType(script.type)) {
            groups.push({ scripts: [script], indexes: [index] })
            return
        }

        const key = scriptContentKey(script)
        const candidates = compatibleGroups.get(key) ?? []
        const group = candidates.find((candidate) =>
            candidate.scripts.every((member) => member.type !== script.type)
        )

        if (group) {
            group.scripts.push(script)
            group.indexes.push(index)
            return
        }

        const newGroup = { scripts: [script], indexes: [index] }
        groups.push(newGroup)
        candidates.push(newGroup)
        compatibleGroups.set(key, candidates)
    })

    return groups
}

export function syncRegexScriptGroup(group: RegexScriptGroup): void {
    const [primary, ...rest] = group.scripts
    if (!primary) return

    const sharedEntries = Object.entries(primary).filter(([key]) => key !== 'type')
    for (const member of rest) {
        for (const key of Object.keys(member)) {
            if (key !== 'type') {
                delete (member as unknown as Record<string, unknown>)[key]
            }
        }
        Object.assign(member, Object.fromEntries(sharedEntries))
    }
}

function removeScripts(scripts: customscript[], removed: Set<customscript>): customscript[] {
    return scripts.filter((script) => !removed.has(script))
}

/**
 * Toggles one type while retaining a stable primary object for open/edit UI
 * state. The returned array still contains only the original single-type schema.
 */
export function toggleRegexScriptType(
    scripts: customscript[],
    group: RegexScriptGroup,
    type: ActiveRegexScriptType | 'disabled',
): customscript[] {
    const primary = group.scripts[0]
    if (!primary) return scripts

    if (type === 'disabled') {
        primary.type = 'disabled'
        return removeScripts(scripts, new Set(group.scripts.slice(1)))
    }

    const selected = group.scripts.find((script) => script.type === type)
    if (selected) {
        if (group.scripts.length === 1) {
            primary.type = 'disabled'
            return [...scripts]
        }

        if (selected === primary) {
            const replacement = group.scripts.find((script) => script !== primary)
            primary.type = replacement!.type
            return removeScripts(scripts, new Set([replacement!]))
        }

        return removeScripts(scripts, new Set([selected]))
    }

    if (!isActiveRegexScriptType(primary.type)) {
        primary.type = type
        return [...scripts]
    }

    const duplicate = { ...primary, type }
    const memberSet = new Set(group.scripts)
    let insertAt = -1
    scripts.forEach((script, index) => {
        if (memberSet.has(script)) insertAt = index
    })

    const next = [...scripts]
    next.splice(insertAt + 1, 0, duplicate)
    return next
}

export function removeRegexScriptGroup(
    scripts: customscript[],
    group: RegexScriptGroup,
): customscript[] {
    return removeScripts(scripts, new Set(group.scripts))
}

export function reorderRegexScriptGroups(
    groups: RegexScriptGroup[],
    firstIndexes: number[],
): customscript[] {
    const byFirstIndex = new Map(groups.map((group) => [group.indexes[0], group]))
    return firstIndexes.flatMap((index) => byFirstIndex.get(index)?.scripts ?? [])
}
