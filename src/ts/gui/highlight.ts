import { getCBSDefinitions } from 'src/ts/cbs'

export type HighlightType = 'decorator'|'deprecated'|'cbsnest0'|'cbsnest1'|'cbsnest2'|'cbsnest3'|'cbsnest4'|'cbsdisplay'|'comment'

type HighLightRange = [number, number]
type HighlightInt = [HighLightRange, HighlightType]

const displayRelatedCBS = [
    'raw', 'img', 'video', 'audio', 'bg', 'emotion', 'asset', 'video-img', 'comment', 'image'
];

const cbsDefinitions = getCBSDefinitions().filter(definition => !definition.internalOnly)
const knownCBSNames = new Set<string>(['/'])
const deprecatedCBSNames = new Set<string>()

for (const definition of cbsDefinitions) {
    for (const name of [definition.name, ...definition.alias]) {
        const normalizedName = name.toLocaleLowerCase()
        knownCBSNames.add(normalizedName)
        // Deprecated block syntax remains valid and common in existing
        // presets. Keep its nesting color instead of presenting it as deleted.
        if (definition.deprecated && !normalizedName.startsWith('#')) {
            deprecatedCBSNames.add(normalizedName)
        }
        if (normalizedName.startsWith('#')) {
            const closingName = `/${normalizedName.slice(1)}`
            knownCBSNames.add(closingName)
        }
    }
}

export const decorators = [
    'activate_only_after', 'activate_only_every', 'keep_activate_after_match', 'dont_activate_after_match', 'depth', 'reverse_depth',
    'instruct_depth', 'reverse_instruct_depth', 'instruct_scan_depth', 'role', 'scan_depth', 'is_greeting', 'position', 'ignore_on_max_context',
    'additional_keys', 'exclude_keys', 'is_user_icon', 'activate', 'dont_activate', 'disable_ui_prompt', 'probability', 'exclude_keys_all', 'match_full_word', 'match_partial_word'
]

const deprecatedDecorators = [
    'end', 'assistant', 'user', 'system'
]

const highlighterSyntax = [
    {
        regex: /<(char|user|bot)>/gi,
        type: 'deprecated'
    },
    {
        regex: new RegExp(`@@@?(${decorators.join('|')})`, 'gi'),
        type: 'decorator'
    },
    {
        regex: new RegExp(`@@@?(${deprecatedDecorators.join('|')})`, 'gi'),
        type: 'deprecated'
    },
] as const


export function getCBSHighlightRanges(text:string): HighlightInt[] {
    const normalizedText = text.toLocaleLowerCase()
    const ranges = simpleCBSHighlightParser(normalizedText)

    for(const syntax of highlighterSyntax){
        syntax.regex.lastIndex = 0
        let match:RegExpExecArray | null
        while ((match = syntax.regex.exec(normalizedText)) !== null) {
            ranges.push([[match.index, match.index + match[0].length], syntax.type])
        }
    }

    return ranges
}

function simpleCBSHighlightParser(text:string){
    let depth = 0
    let pointer = 0
    const tokenStarts: number[] = []
    const segmentStarts: number[] = []
    const highlightMode: number[] = []

    const ranges:HighlightInt[] = []
    const excludesRanges:[number,number][] = []

    text = text.toLowerCase()

    const checkHighlight = (rangeEnd: number) => {
        if(depth !== 0 && highlightMode[depth] === 0){
            highlightMode[depth] = 10
            const upString = text.slice(tokenStarts[depth], pointer).trimStart()
            const token = upString.split(/::|\s/, 1)[0]
            const legacyToken = token.split(':', 1)[0]
            const resolvedName = knownCBSNames.has(token)
                ? token
                : knownCBSNames.has(legacyToken) ? legacyToken : ''

            if(upString.startsWith('//')){
                highlightMode[depth] = 4
            }
            else if (resolvedName && deprecatedCBSNames.has(resolvedName)) {
                highlightMode[depth] = 3
            }
            else if (resolvedName && displayRelatedCBS.includes(resolvedName)) {
                highlightMode[depth] = 2
            }
            else if (resolvedName) {
                highlightMode[depth] = 1
            }

            colorHighlight(rangeEnd)
        }
    }

    const colorHighlight = (rangeEnd: number) => {
        if(highlightMode[depth] !== 10){
            const range:HighLightRange = [segmentStarts[depth], rangeEnd]
            if (range[0] >= range[1]) return
            switch(highlightMode[depth]){
                case 1:
                    ranges.push([range, `cbsnest${depth % 5}` as HighlightType])
                    break;
                case 2:
                    ranges.push([range, 'cbsdisplay'])
                    break;
                case 3:
                    ranges.push([range, 'deprecated'])
                    break;
                case 4:
                    ranges.push([range, 'comment'])
                    break;
            }
        }
    }

    const finishSegment = (rangeEnd: number) => {
        if (highlightMode[depth] === 0) checkHighlight(rangeEnd)
        else colorHighlight(rangeEnd)
    }

    while(pointer < text.length){
        const c = text[pointer]
        const nextC = text[pointer + 1]
        if(c === '{' && nextC === '{'){
            if (depth !== 0) finishSegment(pointer)
            depth++
            pointer++
            tokenStarts[depth] = pointer + 1
            segmentStarts[depth] = pointer - 1
            highlightMode[depth] = 0
        }else if(c === '}' && nextC === '}'){
            finishSegment(pointer + 2)
            depth--
            pointer++
            segmentStarts[depth] = pointer + 1
        }
        pointer++
    }

    return ranges
}
