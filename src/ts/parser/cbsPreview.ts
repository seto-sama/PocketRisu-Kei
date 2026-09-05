import { getCBSDefinitions, type CBSDefinition } from '../cbs'

export type CBSPreviewReference =
    | { kind:'expression', expression:string }
    | { kind:'chat', key:string }
    | { kind:'global', key:string }
    | { kind:'toggle', key:string }

type PreviewDefinition = CBSDefinition & { preview: NonNullable<CBSDefinition['preview']> }

const previewDefinitions = new Map<string, PreviewDefinition>()
for (const definition of getCBSDefinitions()) {
    if (!definition.preview) continue
    for (const name of [definition.name, ...definition.alias]) {
        previewDefinitions.set(name.toLocaleLowerCase(), definition as PreviewDefinition)
    }
}

function referenceGroup(reference:CBSPreviewReference):number {
    if (reference.kind === 'expression') return 0
    if (reference.kind === 'toggle') return 1
    return 2
}

function getWhenReferences(body:string):CBSPreviewReference[] {
    const parts = body.split('::').slice(1)
    const references:CBSPreviewReference[] = []

    for (let index = 0; index < parts.length; index++) {
        const operator = parts[index].toLocaleLowerCase()
        if ((operator === 'tis' || operator === 'tisnot') && parts[index - 1]) {
            references.push({ kind: 'toggle', key: parts[index - 1] })
        } else if ((operator === 'vis' || operator === 'visnot') && parts[index - 1]) {
            references.push({ kind: 'chat', key: parts[index - 1] })
        } else if (operator === 'toggle' && parts[index + 1]) {
            references.push({ kind: 'toggle', key: parts[index + 1] })
        } else if (operator === 'var' && parts[index + 1]) {
            references.push({ kind: 'chat', key: parts[index + 1] })
        }
    }

    return references
}

function referenceId(reference:CBSPreviewReference):string {
    return reference.kind === 'expression'
        ? `expression:${reference.expression}`
        : `${reference.kind}:${reference.key}`
}

function canonicalExpression(definition:PreviewDefinition):string {
    return `{{${definition.name}}}`
}

/** Collect preview-editable CBS values in group and source order. */
export function extractCBSPreviewReferences(text:string):CBSPreviewReference[] {
    const references = new Map<string, { reference:CBSPreviewReference, position:number }>()
    const starts:number[] = []

    const add = (reference:CBSPreviewReference, position:number) => {
        const id = referenceId(reference)
        const existing = references.get(id)
        if (!existing || position < existing.position) references.set(id, { reference, position })
    }

    for (let index = 0; index < text.length - 1; index++) {
        const pair = text.slice(index, index + 2)
        if (pair === '{{') {
            starts.push(index)
            index++
            continue
        }
        if (pair !== '}}' || starts.length === 0) continue

        const start = starts.pop()!
        const expression = text.slice(start, index + 2)
        const body = expression.slice(2, -2).trim()
        if (!body.includes('{{')) {
            const name = body.split(/::|:|\s/, 1)[0].toLocaleLowerCase()
            const definition = previewDefinitions.get(name)
            if (definition?.preview === 'condition') {
                for (const reference of getWhenReferences(body)) add(reference, start)
            } else if (definition?.preview === 'chatVariable' || definition?.preview === 'globalVariable') {
                const key = body.split('::')[1]
                if (key) {
                    if (definition.preview === 'chatVariable') {
                        add({ kind: 'chat', key }, start)
                    } else if (key.toLocaleLowerCase().startsWith('toggle_')) {
                        add({ kind: 'toggle', key: key.slice('toggle_'.length) }, start)
                    } else {
                        add({ kind: 'global', key }, start)
                    }
                }
            } else if (definition?.preview === 'expression') {
                add({ kind: 'expression', expression: canonicalExpression(definition) }, start)
            }
        }
        index++
    }

    for (const match of text.matchAll(/<(user|char|bot)>/gi)) {
        const definition = previewDefinitions.get(match[1].toLocaleLowerCase())
        if (definition?.preview === 'expression') {
            add({ kind: 'expression', expression: canonicalExpression(definition) }, match.index)
        }
    }

    return [...references.values()]
        .sort((a, b) => referenceGroup(a.reference) - referenceGroup(b.reference) || a.position - b.position)
        .map(item => item.reference)
}

/** Collect unique direct CBS expressions that can be overridden in a preview. */
export function extractCBSPreviewExpressions(text:string):string[] {
    return extractCBSPreviewReferences(text)
        .filter((reference):reference is Extract<CBSPreviewReference, {kind:'expression'}> => reference.kind === 'expression')
        .map(reference => reference.expression)
}

export function applyCBSPreviewValues(
    text:string,
    values:ReadonlyArray<{ expression:string, value:string }>,
):string {
    return values.reduce((result, item) => {
        if (item.expression === '{{char}}') {
            return result.replace(/\{\{\s*(?:char|bot)\s*\}\}|<(?:char|bot)>/gi, () => item.value)
        }
        if (item.expression === '{{user}}') {
            return result.replace(/\{\{\s*user\s*\}\}|<user>/gi, () => item.value)
        }
        return result.replaceAll(item.expression, item.value)
    }, text)
}
