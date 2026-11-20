import type { character } from './storage/database.svelte'
import { imageAssetExtensions } from './characterAssets'

/** Whether an additional-asset row is an image the asset prompt can show. */
export function isImageAsset([, path, ext]: [string, string, string]): boolean {
    const extension = (ext || path.split('.').pop() || '').toLowerCase()
    return imageAssetExtensions.includes(extension)
}

const separatorPattern = /[ _]/

/**
 * Writes the asset prompt's insertion rules and lists the way hand-written prompts
 * do: one character list and one keyword list, combined as `<assets src="Character Keyword">`.
 * Splits happen only at real spaces or underscores in the asset names.
 */
export function formatAssetPromptList(assetNames: string[]): string {
    const names = [...new Set(assetNames.filter(Boolean))]
    const isBaseName = (name: string) => names.some((other) =>
        other.length > name.length + 1 && other.startsWith(name) && separatorPattern.test(other[name.length]))

    const groups = new Map<string, { keyword: string, separator: string }[]>()
    for (const name of names) {
        const split = Math.max(name.lastIndexOf(' '), name.lastIndexOf('_'))
        if (isBaseName(name) || split <= 0 || split === name.length - 1) continue
        const character = name.slice(0, split)
        const members = groups.get(character) ?? []
        members.push({ keyword: name.slice(split + 1), separator: name[split] })
        groups.set(character, members)
    }

    // A multi-word keyword ("crying with eyes closed") splits too late; fold it
    // back into a shorter character that the name starts with.
    const characters = [...groups.keys()].sort((a, b) => a.length - b.length)
    for (const character of characters) {
        const owner = characters.find((candidate) => candidate.length < character.length
            && groups.has(candidate)
            && character.startsWith(candidate)
            && separatorPattern.test(character[candidate.length]))
        if (!owner) continue
        const rest = character.slice(owner.length + 1)
        groups.get(owner).push(...groups.get(character).map((member) => ({
            keyword: `${rest}${member.separator}${member.keyword}`,
            separator: character[owner.length],
        })))
        groups.delete(character)
    }

    const keywordOwners = new Map<string, number>()
    for (const members of groups.values()) {
        for (const keyword of new Set(members.map((member) => member.keyword))) {
            keywordOwners.set(keyword, (keywordOwners.get(keyword) ?? 0) + 1)
        }
    }
    // If every character has only an unshared keyword, use plain asset names.
    const isLone = (members: { keyword: string }[]) =>
        members.length === 1 && keywordOwners.get(members[0].keyword) === 1

    const insertWhen = 'When a character newly appears or their emotion or situation changes'

    // With no character structure every name is a plain keyword; otherwise names
    // that do not split into a character and a keyword are left out.
    if ([...groups.values()].every(isLone)) {
        if (names.length === 0) return ''
        return [
            `- ${insertWhen}, output an <assets src="Keyword"> tag between paragraphs.`,
            '- Use only the keywords listed below, exactly as written.',
            `- Example: <assets src="${names[0]}">`,
            '',
            '### Available Keywords',
            names.join(', '),
        ].join('\n')
    }

    const members = [...groups.values()].flat()
    const underscores = members.filter((member) => member.separator === '_').length
    const separator = underscores > members.length / 2 ? '_' : ' '
    const keywords = [...new Set(members.map((member) => member.keyword))]
    const grouped = new Set([...groups].flatMap(([character, members]) =>
        members.map((member) => `${character}${member.separator}${member.keyword}`)))
    const example = names.find((name) => grouped.has(name))
    return [
        `- ${insertWhen}, output an <assets src="Character${separator}Keyword"> tag between paragraphs.`,
        '- Combine only the characters and keywords listed below.',
        `- Example: <assets src="${example}">`,
        '',
        '### Available Characters',
        [...groups.keys()].join(', '),
        '',
        '### Available Keywords',
        keywords.join(', '),
    ].join('\n')
}

const assetListToken = '{{chardisplayasset::grouped}}'

export const prebuiltAssetCommand = `

## Asset Command Guide

### How to Insert Assets
- This session has pre-made character assets. Pick the ones that fit the scene and insert them.
${assetListToken}
`

type AssetPromptCharacter = Pick<character, 'additionalAssets' | 'prebuiltAssetExclude'>

/** The character's image assets as the asset prompt lists them, minus excluded ones. */
export function characterAssetPromptList(char: AssetPromptCharacter): string {
    const excludes = char.prebuiltAssetExclude ?? []
    return formatAssetPromptList((char.additionalAssets ?? [])
        .filter((asset) => !excludes.includes(asset[1]) && isImageAsset(asset))
        .map(([name]) => name))
}

/** The asset prompt as the model receives it. Its only CBS is the asset list. */
export function renderPrebuiltAssetCommand(char: AssetPromptCharacter): string {
    return prebuiltAssetCommand.replace(assetListToken, characterAssetPromptList(char)).trim()
}
