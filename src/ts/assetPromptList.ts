const imageExtensions = ['png', 'webp', 'jpeg', 'jpg', 'gif', 'svg', 'avif']

/** Whether an additional-asset row is an image the asset prompt can show. */
export function isImageAsset([, path, ext]: [string, string, string]): boolean {
    const extension = (ext || path.split('.').pop() || '').toLowerCase()
    return imageExtensions.includes(extension)
}

const separatorPattern = /[ _]/

/**
 * Lists asset names for the asset prompt the way hand-written prompts do: one
 * character list and one keyword list, combined as `<assets src="Character Keyword">`.
 * Splits happen only at real spaces or underscores, so joining a character and
 * one of its keywords always reproduces an existing asset name.
 */
export function formatAssetPromptList(assetNames: string[]): string {
    const names = [...new Set(assetNames.filter(Boolean))]
    const isBaseName = (name: string) => names.some((other) =>
        other.length > name.length + 1 && other.startsWith(name) && separatorPattern.test(other[name.length]))

    const others: string[] = []
    const groups = new Map<string, { keyword: string, separator: string }[]>()
    for (const name of names) {
        const split = Math.max(name.lastIndexOf(' '), name.lastIndexOf('_'))
        if (isBaseName(name) || split <= 0 || split === name.length - 1) {
            others.push(name)
            continue
        }
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
    // A lone asset whose keyword no other character shares is just a named image.
    for (const [character, members] of groups) {
        if (members.length === 1 && keywordOwners.get(members[0].keyword) === 1) {
            others.push(`${character}${members[0].separator}${members[0].keyword}`)
            groups.delete(character)
        }
    }

    if (groups.size === 0) {
        if (others.length === 0) return ''
        return [
            'Format: <assets src="Image Name">',
            `Images: ${others.join(', ')}`,
            `Example: <assets src="${others[0]}">`,
        ].join('\n')
    }

    const members = [...groups.values()].flat()
    const underscores = members.filter((member) => member.separator === '_').length
    const separator = underscores > members.length / 2 ? '_' : ' '
    const keywords = [...new Set(members.map((member) => member.keyword))]
    const [firstCharacter] = groups.keys()
    const [example] = groups.get(firstCharacter)
    return [
        `Format: <assets src="Character${separator}Keyword"> (one character and one keyword)`,
        `Characters: ${[...groups.keys()].join(', ')}`,
        `Keywords: ${keywords.join(', ')}`,
        ...(others.length > 0 ? [`Other images, used by name alone: ${others.join(', ')}`] : []),
        `Example: <assets src="${firstCharacter}${example.separator}${example.keyword}">`,
    ].join('\n')
}
