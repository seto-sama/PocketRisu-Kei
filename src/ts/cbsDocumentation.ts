import { getCBSDefinitions } from './cbs'

export type CBSDocumentationItem = {
    name:string
    description:string
    aliases:string[]
}

let cachedDocumentation:CBSDocumentationItem[]|null = null

export function getCBSDocumentation():CBSDocumentationItem[]{
    if(cachedDocumentation) return cachedDocumentation

    cachedDocumentation = getCBSDefinitions()
        .filter(definition => !definition.internalOnly)
        .map(definition => ({
            name: definition.name,
            description: definition.description,
            aliases: definition.alias ?? [],
        }))
    return cachedDocumentation
}
