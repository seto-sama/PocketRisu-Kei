import { getCBSDefinitions } from 'src/ts/cbs'

export type HighlightType = 'decorator'|'deprecated'|'cbsnest0'|'cbsnest1'|'cbsnest2'|'cbsnest3'|'cbsnest4'|'cbsdisplay'|'comment'

type HighLightRange = [number, number]
type HighlightInt = [HighLightRange, HighlightType]
type HighlightIntRanged = [Range, HighlightType]

let highLights = new Map<number, HighlightIntRanged[]>();
const highlightStyleId = 'risu-cbs-highlight-style';

const ensureHighlightStyle = () => {
    if(document.getElementById(highlightStyleId)){
        return
    }

    const style = document.createElement('style')
    style.id = highlightStyleId
    style.textContent = `
::highlight(cbsnest3) { color: var(--color-amber-500); }
::highlight(cbsnest2) { color: var(--color-green-500); }
::highlight(cbsnest1) { color: var(--color-blue-500); }
::highlight(cbsnest0) { color: var(--color-purple-500); }
::highlight(cbsnest4) { color: var(--color-pink-500); }
::highlight(cbsdisplay) { color: var(--color-cyan-500); }
::highlight(comment) { color: var(--risu-theme-textcolor2); }
::highlight(decorator) { color: var(--risu-theme-draculared); }
::highlight(deprecated) { color: var(--risu-theme-textcolor2); text-decoration: line-through; }
`
    document.head.appendChild(style)
}

export const highlighter = (highlightDom:HTMLElement, id:number) => {
    try {
    
        if(highlightDom){
            if(!CSS.highlights){
                return
            }
            ensureHighlightStyle()
    
            const walker = document.createTreeWalker(highlightDom, NodeFilter.SHOW_TEXT)
            const nodes:Node[] = []
            const nodePointers:number[] = []
            let currentNode = walker.nextNode();
            let fullText = ''
            let pointer = 0
            while (currentNode) {
                pointer += currentNode.textContent.length;
                nodes.push(currentNode);
                nodePointers.push(pointer);
                fullText += currentNode.textContent;
                currentNode = walker.nextNode();
            }

            //this is because we need to match the text content case-insensitively
            fullText = fullText.toLocaleLowerCase()
    
            const ranges:HighlightIntRanged[] = []
            const parsed = getCBSHighlightRanges(fullText)

            const convertToDomRange = (start:number, end:number):Range[] => {
                const startNodeIndex = nodePointers.findIndex((pointer) => pointer >= start);
                const endNodeIndex = nodePointers.findIndex((pointer) => pointer >= end);

                if (startNodeIndex === -1 || endNodeIndex === -1) {
                    return [];
                }

                const startNode = nodes[startNodeIndex];
                const endNode = nodes[endNodeIndex];

                if(startNode === endNode){
                    const range = new Range();
                    range.setStart(startNode, start - (startNodeIndex > 0 ? nodePointers[startNodeIndex - 1] : 0));
                    range.setEnd(endNode, end - (endNodeIndex > 0 ? nodePointers[endNodeIndex - 1] : 0));
                    return [range];
                }
                else{
                    const startNodeRange = new Range();
                    const endNodeRange = new Range();
                    startNodeRange.setStart(startNode, start - (startNodeIndex > 0 ? nodePointers[startNodeIndex - 1] : 0));
                    startNodeRange.setEnd(startNode, startNode.textContent.length);
                    endNodeRange.setStart(endNode, 0);
                    endNodeRange.setEnd(endNode, end - (endNodeIndex > 0 ? nodePointers[endNodeIndex - 1] : 0));
                    return [startNodeRange, endNodeRange];
                }
            }
            
            for(let i=0;i<parsed.length;i++){
                const rinit = parsed[i]
                const r = rinit[0]
                const domRange = convertToDomRange(r[0], r[1]);
                for(const range of domRange){
                    ranges.push([range, rinit[1]]);
                }
            }

            highLights.set(id, ranges)
    
            runHighlight()
        }    
    } catch (error) {
        
    }
}

const runHighlight = () => {
    const formatedRanges:{[key:string]:Range[]} = {}
    for(const h of highLights){
        for(const range of h[1]){
            const type = range[1]
            if(!formatedRanges[type]){
                formatedRanges[type] = []
            }
            formatedRanges[type].push(range[0])
        }
    }

    for(const key in formatedRanges){
        const highlight = new Highlight(...formatedRanges[key]);
        CSS.highlights.set(key, highlight);
    }

}

let highlightIds = 0

export const getNewHighlightId = () => {
    return highlightIds++
}

export const removeHighlight = (id:number) => {
    highLights.delete(id)
}

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
        if (definition.deprecated) deprecatedCBSNames.add(normalizedName)
        if (normalizedName.startsWith('#')) {
            const closingName = `/${normalizedName.slice(1)}`
            knownCBSNames.add(closingName)
            if (definition.deprecated) deprecatedCBSNames.add(closingName)
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
    const depthStarts: number[] = []
    const highlightMode: number[] = []

    const ranges:HighlightInt[] = []
    const excludesRanges:[number,number][] = []

    text = text.toLowerCase()

    const checkHighlight = () => {
        if(depth !== 0 && highlightMode[depth] === 0){
            highlightMode[depth] = 10
            const upString = text.slice(depthStarts[depth], pointer).trimStart()
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

            colorHighlight()
        }
    }

    const colorHighlight = () => {
        if(highlightMode[depth] !== 10){
            const range:HighLightRange = [depthStarts[depth] - 2, pointer + 2]
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

    while(pointer < text.length){
        const c = text[pointer]
        const nextC = text[pointer + 1]
        if(c === '{' && nextC === '{'){
            checkHighlight()
            depth++
            pointer++
            depthStarts[depth] = pointer + 1
            highlightMode[depth] = 0
        }else if(c === '}' && nextC === '}'){
            if(highlightMode[depth] === 0){
                checkHighlight()
            }
            else{
                colorHighlight()
            }
            depth--
            pointer++
            depthStarts[depth] = pointer
        }
        pointer++
    }

    return ranges
}
