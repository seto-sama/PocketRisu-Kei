<script lang="ts">
    import { onDestroy } from "svelte"
    import { XIcon } from "@lucide/svelte"
    import { getDatabase, type PromptDiffPrefs } from "../../ts/storage/database.svelte"
    import type { PromptItem, PromptItemPlain, PromptItemChatML, PromptItemTyped, PromptItemAuthorNote, PromptItemChat } from "src/ts/process/prompt.ts";
    import Checkbox from "../UI/components/Checkbox.svelte";
    import ChoiceGroup from "../UI/components/ChoiceGroup.svelte";
    import Slider from "../UI/components/Slider.svelte";
    import Dialog from "../UI/components/Dialog.svelte";
    import Badge from "../UI/components/Badge.svelte";
    import IconButton from "../UI/components/IconButton.svelte";
    import { language } from "src/lang";

    interface Props {
        firstPresetId: number;
        secondPresetId: number;
        onClose?: () => void;
    }
    let { firstPresetId, secondPresetId, onClose = () => {} }: Props = $props();


// Lazy-loaded diff module
// -----------------------------------------------------------------------------
    let diffModulePromise: Promise<typeof import("diff")> | null = null
    function loadDiffModule() {
        return (diffModulePromise ??= import("diff"))
    }

// Config / constants
// -----------------------------------------------------------------------------
    const SIM_THRESHOLD = 0.35
    const DEFAULT_BAND_MIN = 15
    const DEFAULT_BAND_RATIO = 0.15
    const FULL_DP_LIMIT = 100
    const BANDED_DP_LIMIT = 1000

// Types
// -----------------------------------------------------------------------------
    type DiffCounts = { modifiedCount: number; addedCount: number; removedCount: number }
    type PromptKind = 'plain' | 'chatml' | 'typed' | 'authorNote' | 'chat'
    type SimpleDiff = 'same' | 'add' | 'remove'

    type PromptCard = {
        kind: PromptKind
        role?: 'system' | 'bot' | 'user' | 'unknown'
        header: string
        name: string
        body: string | null
    }

    type PromptLine = {
        kind: PromptKind
        header: string
        name: string
        id: number
        lineRole: 'name' | 'header' | 'body'
        text: string
    }
    
    type WordToken = { t: SimpleDiff, v: string }

    type CardDiffSummaryPart = 
        | { k: SimpleDiff, card: PromptCard }
        | { k: 'modify'; left: PromptCard; right: PromptCard }

    type CardDiffSummary = {
        parts: CardDiffSummaryPart[]
        counts: DiffCounts
    }

    type CardBodyDiff =
        | { k: 'add' | 'remove'; bodyLines: DiffResult }
        | { k: 'same'; bodyLines: DiffResult }
        | { k: 'modify'; left: PromptCard; right: PromptCard; bodyLines: DiffResult }

    type CardDiffResult = { parts: CardBodyDiff[]; counts: DiffCounts; cardCounts: DiffCounts }
    
    type DiffPart =
        | { k: SimpleDiff; src: 'linebyline'; line: PromptLine }
        | { k: 'modify'; src: 'linebyline'; left: PromptLine; right: PromptLine; tokens: WordToken[] }

    type DiffResult = { parts: DiffPart[]; counts: DiffCounts }

    type ModifyPart = Extract<DiffPart, { k: 'modify' }>

    type SplitLineRole = 'name' | 'header' | 'body' | null

    type SplitCell =
        | { kind: 'empty'; role: SplitLineRole }
        | { kind: 'part'; side: Side; part: DiffPart; role: SplitLineRole }

    type SplitRow =
        | { kind: 'divider'; seg: Extract<DiffSegment, { kind: 'divider' }>; scope: string, key: string }
        | { kind: 'row'; left: SplitCell; right: SplitCell; key: string }

    type Side = 'left' | 'right'

    type RenderLine =
        | { kind: 'simple'; part: DiffPart }
        | { kind: 'modifyGroup'; parts: ModifyPart[] }

    type DiffSegment =
        | { kind: 'context' | 'changes'; parts: DiffPart[] }
        | { kind: 'divider'; pos: 'start' | 'between' | 'end'; omitted: number; id: string; from: number; to: number }

    type Pair = {
        leftIndex: number
        rightIndex: number
    }

    type PairCell = {
        leftIndex: number | null
        rightIndex: number | null
    }

    type BigramProfile = {
        counts: Map<number, number>
        total: number  // total: number of bigrams (len - 1), NOT string length
    }

    type PreparedLine = {
        raw: string
        norm: string
        rawLen: number
        normLen: number
        trimmedLen: number
        profile: BigramProfile
    }

    type ExpandedRange = { scope: string; from: number; to: number }
    type SegmentOptions = {
        showOnlyChanges: boolean
        contextRadius: number
        scope: string
        expandedRanges: ExpandedRange[]
    }

    type NonModifyPart = Exclude<DiffPart, { k: 'modify' }>
    type TokenClassPack = {add: string; remove: string; same: string}

    type DiffStyle = 'line' | 'intraline'
    type FormatStyle = 'raw' | 'card'
    type ViewStyle = 'unified' | 'split'
    
// UI state
// -----------------------------------------------------------------------------
    const DEFAULT_PROMPT_DIFF_PREFS: PromptDiffPrefs = {
        diffStyle: 'line',
        formatStyle: 'raw',
        viewStyle: 'unified',
        isGrouped: true,
        showOnlyChanges: false,
        contextRadius: 3,
    }

    const db = getDatabase()
    const prefs = db.promptDiffPrefs

    let diffStyle = $state<DiffStyle>(prefs?.diffStyle ?? DEFAULT_PROMPT_DIFF_PREFS.diffStyle)
    let formatStyle = $state<FormatStyle>(prefs?.formatStyle ?? DEFAULT_PROMPT_DIFF_PREFS.formatStyle)
    let viewStyle = $state<ViewStyle>(prefs?.viewStyle ?? DEFAULT_PROMPT_DIFF_PREFS.viewStyle)
    let isGrouped = $state(prefs?.isGrouped ?? DEFAULT_PROMPT_DIFF_PREFS.isGrouped)
    let showOnlyChanges = $state(prefs?.showOnlyChanges ?? DEFAULT_PROMPT_DIFF_PREFS.showOnlyChanges)
    let contextRadius = $state(prefs?.contextRadius ?? DEFAULT_PROMPT_DIFF_PREFS.contextRadius)

    let cardDiffResult = $state<CardDiffResult | null>(null)
    let expandedRanges = $state<ExpandedRange[]>([])

    function savePrefsToDB() {
        const db = getDatabase()

        db.promptDiffPrefs = {
            ...DEFAULT_PROMPT_DIFF_PREFS,
            diffStyle,
            formatStyle,
            viewStyle,
            isGrouped,
            showOnlyChanges,
            contextRadius,
        }
    }

    function handleClose() {
        savePrefsToDB()
        onClose()
    }

    function formatPromptDiffText(template: string, values: Record<string, string | number>) {
        let result = template
        for (const [key, value] of Object.entries(values)) {
            result = result.replaceAll(`{${key}}`, String(value))
        }
        return result
    }


// Derived values
// -----------------------------------------------------------------------------
    const cardlineFlatResult = $derived.by<DiffResult | null>(() => {
        if (!cardDiffResult) return null

        const parts: DiffPart[] = []

        for (const cardPart of cardDiffResult.parts) {
            parts.push(...cardPart.bodyLines.parts)
        }

        return {
          parts,
          counts: cardDiffResult.counts,
        }
    })

    const visibleCardParts = $derived.by<CardBodyDiff[]>(() => {
        if (!cardDiffResult) return []
        if (!showOnlyChanges) return cardDiffResult.parts

        return cardDiffResult.parts.filter((p) => {
            const c = p.bodyLines.counts
            return c.modifiedCount + c.addedCount + c.removedCount > 0
        })
    })

// UI option lists
// -----------------------------------------------------------------------------
    const diffOptions = [
        { value: 'line', label: language.promptDiff.line },
        { value: 'intraline', label: language.promptDiff.character },
    ]

    const formatOptions = [
        { value: 'raw', label: language.promptDiff.fullPrompt },
        { value: 'card', label: language.promptDiff.byBlock },
    ]

    const viewOptions = [
        { value: 'unified', label: language.promptDiff.defaultView },
        { value: 'split', label: language.promptDiff.splitView },
    ]

// Inputs
// -----------------------------------------------------------------------------
    const firstCards  = $derived.by(() => getPromptCards(firstPresetId))
    const secondCards = $derived.by(() => getPromptCards(secondPresetId))

// Effects (state invariants + diff recompute)
// -----------------------------------------------------------------------------
    $effect(() => {
        if (diffStyle !== 'line' && isGrouped) {
            isGrouped = false
        }
    })

    $effect(() => {
        if (!firstCards || !secondCards) return
        diffStyle
        expandedRanges = []
        void recomputeDiff(firstCards, secondCards)
    })

    $effect(() => {
        showOnlyChanges
        contextRadius
        expandedRanges = []
    })
 
// Style helpers (classnames)
// -----------------------------------------------------------------------------
    const diffLineBase = 'whitespace-pre-wrap'
    const diffLineCommon = 'border-l-4 rounded-sm pl-2'

    const diffSameClass = 'text-maintext'
    const diffAddClass = `${diffLineCommon} bg-success/10 border-success text-success`
    const diffRemoveClass = `${diffLineCommon} bg-danger/10 border-danger text-danger`

    const tokenAddClass = 'text-success bg-success/15 rounded-sm px-0.5'
    const tokenRemoveClass = 'text-danger bg-danger/15 rounded-sm px-0.5'
    const tokenSameClass = 'text-maintext'

    const lineRemoveClass = 'pl-2 border-l-4 border-danger bg-danger/10 text-danger rounded-sm'
    const lineAddClass    = 'pl-2 border-l-4 border-success bg-success/10 text-success rounded-sm'
    const lineModifyClass = 'pl-2 border-l-4 border-accent bg-accent/10 rounded-sm'

    const nameHeaderTagClass = 'ml-2 shrink-0 text-[10px] px-1.5 py-0.5 rounded-sm border border-darkborderc text-subtext bg-darkbg'

    const splitEmptyLineClass = `${diffLineBase} ${diffLineCommon} ` +
        'diff-empty-pattern border-darkborderc/50 text-transparent select-none'

    const tokenPackLineAdd: TokenClassPack = {
      add: 'bg-success/20 rounded-sm px-0.5',
      remove: '',
      same: 'text-success',
    }

    const tokenPackLineRemove: TokenClassPack = {
      add: '',
      remove: 'bg-danger/20 rounded-sm px-0.5',
      same: 'text-danger',
    }

    const tokenPackIntraline: TokenClassPack = {
      add: tokenAddClass,
      remove: tokenRemoveClass,
      same: tokenSameClass,
    }

    function lineClassOf(part: NonModifyPart) {
        if (part.k === 'same') return `${diffLineBase} ${diffSameClass}`
        if (part.k === 'add')  return `${diffLineBase} ${diffAddClass}`
        return `${diffLineBase} ${diffRemoveClass}`
    }

    function lineTextOf(part: NonModifyPart) {
        return part.line.text
    }

    function isLineby(part: DiffPart): part is Extract<DiffPart, { src: 'linebyline' }> {
        return part.src === 'linebyline'
    }

    function isNameLine(part: DiffPart) {
        return part.src === 'linebyline' && part.k !== 'modify' && part.line.lineRole === 'name'
    }

    function isHeaderLine(part: DiffPart) {
        return part.src === 'linebyline' && part.k !== 'modify' && part.line.lineRole === 'header'
    }

    function tagText(part: ModifyPart): string | null {
        if ((part.src === 'linebyline') && (part.right.lineRole === 'name' || part.right.lineRole === 'header')) {
            return part.right.lineRole === 'name' ? language.promptDiff.name : language.promptDiff.type
        }
        return null
    }

  

// Data shaping (prompt → cards/lines/raw)
// -----------------------------------------------------------------------------
    function getPromptCards(id: number): PromptCard[] {
        const isPromptItemPlain = (item: PromptItem): item is PromptItemPlain =>
            item.type === 'plain' || item.type === 'jailbreak' || item.type === 'cot'
       
        const isPromptItemChatML = (item: PromptItem): item is PromptItemChatML =>
            item.type === 'chatML'
        
        const isPromptItemTyped = (item: PromptItem): item is PromptItemTyped =>
            item.type === 'persona' ||
            item.type === 'description' ||
            item.type === 'lorebook' ||
            item.type === 'postEverything' ||
            item.type === 'memory'
        
        const isPromptItemAuthorNote = (item: PromptItem): item is PromptItemAuthorNote =>
            item.type === 'authornote'
        
        const isPromptItemChat = (item: PromptItem): item is PromptItemChat =>
            item.type === 'chat'
        
        const db = getDatabase()
        const formated = db.botPresets[id].promptTemplate
        const cards: PromptCard[] = []

        for(let i=0;i<formated.length;i++){
            const item = formated[i]

            switch (true) {
                case isPromptItemPlain(item):{
                    cards.push({
                        kind: 'plain',
                        name: item.name ?? formatPromptDiffText(language.promptDiff.unnamedPrompt, { type: item.type.toUpperCase() }),
                        role: item.role ?? 'unknown',
                        header: `${item.type}; ${item.type2}`,
                        body: item.text ? item.text : null,
                    })
                    break
                }

                case isPromptItemChatML(item):{
                    cards.push({
                        kind: 'chatml',
                        name: item.name ?? item.type.toUpperCase(),
                        header: `${item.type}`,
                        body: item.text ? item.text : null,
                    })
                    break
                }

                case isPromptItemTyped(item):{
                    cards.push({
                        kind: 'typed',
                        name: item.name ?? item.type.toUpperCase(),
                        header: `${item.type}`,
                        body: item.innerFormat ? item.innerFormat : null,
                    })
                    break
                }

                case isPromptItemAuthorNote(item):{
                    cards.push({
                        kind: 'authorNote',
                        name: item.name ?? item.type.toUpperCase(),
                        role: item.role ?? 'system',
                        header: `${item.type}`,
                        body: item.innerFormat ? item.innerFormat : null,
                    })
                    break
                }

                case isPromptItemChat(item):{
                    cards.push({
                        kind: 'chat',
                        name: item.name ?? item.type.toUpperCase(),
                        header: `${item.type}`,
                        body: `${item.rangeStart} - ${item.rangeEnd}`,
                    })
                    break
                }
            }

        }

        return cards
    }

    function cardsToLines(cards: PromptCard[]): PromptLine[] {
        const out: PromptLine[] = []

        for (const [id, c] of cards.entries()) {
            const meta = {
                kind: c.kind,
                header: c.header,
                name: c.name,
                id,
            }
            out.push({ ...meta, lineRole: 'name', text: c.name })
            out.push({ ...meta, lineRole: 'header', text: c.header })

            if (c.body != null) {
                for (const line of c.body.split('\n')) {
                    out.push({ ...meta, lineRole: 'body', text: line })
                }
            }
        }

        return out
    }

// Diff core
// -----------------------------------------------------------------------------
    let diffRunId = 0

    onDestroy(() => {
        diffRunId++
    })

    async function recomputeDiff(firstCards: PromptCard[], secondCards: PromptCard[]) {
        if (!firstCards || !secondCards) return
        const runId = ++diffRunId

        const cr = await computeCardViewDiff(firstCards, secondCards, diffStyle)
        if (runId !== diffRunId) return
        cardDiffResult = cr
    }

    async function computeCardViewDiff(prompt1: PromptCard[], prompt2: PromptCard[], style: DiffStyle): Promise<CardDiffResult> {
        const summary = await computeDiffCardLine(prompt1, prompt2)
        const out: CardBodyDiff[] = []

        let modifiedCount = 0
        let addedCount = 0
        let removedCount = 0

        for (const part of summary.parts) {
            if (part.k === 'same') {
                const lines = cardsToLines([part.card])
                const bodyLines: DiffResult = {
                  parts: lines.map((line) => ({
                    k: 'same' as const,
                    src: 'linebyline',
                    line,
                  })),
                  counts: { modifiedCount: 0, addedCount: 0, removedCount: 0 },
                }
                out.push({ k: 'same', bodyLines })
                continue
            }
            if (part.k === 'add') {
                const cardLines = cardsToLines([part.card])
                const bodyLines = await computeDiffLineByLine(
                  [],
                  cardLines,
                  style
                )
                out.push({ k: 'add', bodyLines })

                modifiedCount += bodyLines.counts.modifiedCount
                addedCount += bodyLines.counts.addedCount
                removedCount += bodyLines.counts.removedCount
                continue
            }
            if (part.k === 'remove') {
                const cardLines = cardsToLines([part.card])
                const bodyLines = await computeDiffLineByLine(
                  cardLines,
                  [],
                  style
                )
                out.push({ k: 'remove', bodyLines })

                modifiedCount += bodyLines.counts.modifiedCount
                addedCount += bodyLines.counts.addedCount
                removedCount += bodyLines.counts.removedCount
                continue
            }
            if (part.k === 'modify') {
                const leftLines = cardsToLines([part.left])
                const rightLines = cardsToLines([part.right])
                const bodyLines = await computeDiffLineByLine(leftLines, rightLines, style)

                out.push({ k: 'modify', left: part.left, right: part.right, bodyLines })

                modifiedCount += bodyLines.counts.modifiedCount
                addedCount += bodyLines.counts.addedCount
                removedCount += bodyLines.counts.removedCount
            }
        }

        return {
            parts: out,
            counts: { modifiedCount, addedCount, removedCount },
            cardCounts: summary.counts,
        }
    }

    async function computeDiffCardLine(prompt1: PromptCard[], prompt2: PromptCard[]): Promise<CardDiffSummary> {
        const diff = await loadDiffModule()
        const arrayDiffs = diff.diffArrays(prompt1, prompt2, {
            comparator: (x, y) => x.body === y.body && x.header === y.header && x.kind === y.kind && x.name === y.name
        })

        const parts: CardDiffSummaryPart[] = []
        let modifiedCount = 0, addedCount = 0, removedCount = 0

        for (let i = 0; i < arrayDiffs.length; i++) {
            const cardPart = arrayDiffs[i]

            if (cardPart.removed) {
                const nextPart = arrayDiffs[i + 1]

                if (nextPart?.added) {
                    const leftParts = cardPart.value
                    const rightParts = nextPart.value
                    const n = Math.min(leftParts.length, rightParts.length)

                    for (let j = 0; j < n; j++) {
                        const left = leftParts[j]
                        const right = rightParts[j]
                        if (left.header === right.header) {
                            parts.push({ k: 'modify', left, right })
                            modifiedCount++
                        }
                        else {
                            parts.push({ k: 'remove', card: left })
                            parts.push({ k: 'add', card: right })
                            removedCount++
                            addedCount++
                        }
                    }
                    for (let j = n; j < leftParts.length; j++) {
                        parts.push({ k: 'remove', card: leftParts[j]})
                        removedCount++
                    }
                    for (let j = n; j < rightParts.length; j++) {
                        parts.push({ k: 'add', card: rightParts[j]})
                        addedCount++
                    }
                    i++
                    continue
                }

                for (const card of cardPart.value) {
                    parts.push({ k: 'remove', card })
                    removedCount++
                }
                
                continue
            }

            if (cardPart.added) {
                for (const card of cardPart.value) {
                    parts.push({ k: 'add', card })
                    addedCount++
                }
                continue
            }

            for (const card of cardPart.value) {
                parts.push({ k: 'same', card })
            }
        }

        return { parts, counts: { modifiedCount, addedCount, removedCount }}
    }

    async function computeDiffLineByLine(prompt1: PromptLine[], prompt2: PromptLine[], style: DiffStyle): Promise<DiffResult> {
        const diff = await loadDiffModule()
        const arrayDiffs = diff.diffArrays(prompt1, prompt2, {
            comparator: (x, y) => x.text === y.text && x.lineRole === y.lineRole
        })

        const parts: DiffPart[] = []
        let modifiedCount = 0, addedCount = 0, removedCount = 0

        for (let i = 0; i < arrayDiffs.length; i++) {
            const linePart = arrayDiffs[i]

            if (linePart.removed) {
                const nextPart = arrayDiffs[i + 1]
                
                if (nextPart?.added) {
                    const leftLines = linePart.value
                    const rightLines = nextPart.value
                    const maxLen = Math.max(leftLines.length, rightLines.length)
                    if (maxLen > BANDED_DP_LIMIT) {
                    const n = Math.min(leftLines.length, rightLines.length)

                    for (let j = 0; j < n; j++) {
                        const left = leftLines[j]
                        const right = rightLines[j]
                        
                        const tokens = style === 'intraline'
                            ? await diffIntralineTokens(left.text, right.text)
                            : lineReplacementTokens(left.text, right.text)
                        parts.push({ k: 'modify', src: 'linebyline', left, right, tokens })

                        if (style === 'intraline') {
                            modifiedCount++
                        } else {
                            removedCount++
                            addedCount++       
                        }
                    }
                    for (let j = n; j < leftLines.length; j++) {
                        parts.push({ k: 'remove', src: 'linebyline', line: leftLines[j] })
                        removedCount++
                    }
                    for (let j = n; j < rightLines.length; j++) {
                        parts.push({ k: 'add', src: 'linebyline', line: rightLines[j] })
                        addedCount++
                    }
                    }
                    else {
                        const band =
                            maxLen <= FULL_DP_LIMIT
                            ? null
                            : Math.max(DEFAULT_BAND_MIN, Math.floor(maxLen * DEFAULT_BAND_RATIO))
                        const pairs = alignByDP(leftLines, rightLines, SIM_THRESHOLD, band)
                        const replaceBlockPairs = buildAlignmentFromAnchorPair(leftLines.length, rightLines.length, pairs)

                        for (const pair of replaceBlockPairs) {
                            const left = pair.leftIndex != null ? leftLines[pair.leftIndex] : null
                            const right = pair.rightIndex != null ? rightLines[pair.rightIndex] : null

                            if (left && right) {
                                const tokens = style === 'intraline'
                                    ? await diffIntralineTokens(left.text, right.text)
                                    : lineReplacementTokens(left.text, right.text)
                                parts.push({ k: 'modify', src: 'linebyline', left, right, tokens })

                                if (style === 'intraline') {
                                    modifiedCount++
                                } else {
                                    removedCount++
                                    addedCount++       
                                }
                            }
                            else if (left && !right) {
                                parts.push({ k: 'remove', src: 'linebyline', line: left })
                                removedCount++
                            }
                            else if (!left && right) {
                                parts.push({ k: 'add', src: 'linebyline', line: right })
                                addedCount++
                            }
                        }
                    }

                    i++
                    continue
                }

                for (const line of linePart.value) {
                    parts.push({ k: 'remove', src: 'linebyline', line })
                    removedCount++
                }
                
                continue
            }

            if (linePart.added) {
                for (const line of linePart.value) {
                    parts.push({ k: 'add', src: 'linebyline', line: line })
                    addedCount++
                }
                continue
            }

            for (const line of linePart.value) {
                parts.push({ k: 'same', src: 'linebyline', line })
            }
        }

        return { parts, counts: { modifiedCount, addedCount, removedCount }}

    }

    async function diffIntralineTokens(string1: string, string2: string): Promise<WordToken[]> {
        const diff = await loadDiffModule()
        const charDiffs = diff.diffWordsWithSpace(string1, string2)

        return charDiffs.map(charPart => {
            if (charPart.added) return { t: 'add', v: charPart.value }
            if (charPart.removed) return { t: 'remove', v: charPart.value }
            return { t: 'same', v: charPart.value }
        })
    }

    function lineReplacementTokens(left: string, right: string): WordToken[] {
        return [
            { t: 'remove', v: left },
            { t: 'add', v: right },
        ]
    }


// Line alignment (similarity + DP + pairing)
// -----------------------------------------------------------------------------
    function normalizeText(s: string): string {
        return s.trim().replace(/^[\s>*\-•]+/, "").replace(/\s+/g, " ").replace(/[!?.,]+$/, "").toLowerCase()
    }

    function buildBigramProfile(s: string): BigramProfile {
        const len = s.length
        const counts = new Map<number, number>()

        for (let i = 0; i < len - 1; i++) {
            const k = (s.charCodeAt(i) << 16) | s.charCodeAt(i + 1)
            counts.set(k, (counts.get(k) ?? 0) + 1)
        }

        return { counts, total: Math.max(0, len - 1) }
    }

    function prepareLines(lines: PromptLine[]): PreparedLine[] {
        return lines.map(l => {
            const norm = normalizeText(l.text)
            const profile = buildBigramProfile(norm)
            return {
                raw: l.text,
                norm,
                rawLen: l.text.length,
                normLen: norm.length,
                trimmedLen: l.text.trim().length,
                profile,
            }
        })
    }

    function diceFromProfiles(a: BigramProfile, b: BigramProfile): number {
        if (a.total === 0 || b.total === 0) return 0

        let small = a, large = b
        if (a.counts.size > b.counts.size) {
            small = b
            large = a
        }

        let inter = 0
        for (const [k, ca] of small.counts) {
            const cb = large.counts.get(k)
            if (cb) inter += Math.min(ca, cb)
        }

        return (2 * inter) / (a.total + b.total)
    }

    function prefixSuffixScore(a: string, b: string): number {
        const la = a.length
        const lb = b.length
        const minLen = Math.min(la, lb)
        if (!minLen) return la === lb ? 1 : 0

        let prefix = 0
        while (prefix < minLen && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++

        let suffix = 0
        while (suffix + prefix < minLen && a.charCodeAt(la - 1 - suffix) === b.charCodeAt(lb - 1 - suffix)) {
            suffix++
        }

        const maxLen = Math.max(la, lb)
        const edgeMatchCount = prefix + suffix  // Matching characters at both ends (prefix + suffix). 0 <= edgeMatchCount <= minLen
        const sMax = edgeMatchCount / maxLen    // Overlap relative to the longer string
        const sMin = edgeMatchCount / minLen    // Overlap relative to the shorter string
        const lengthRatio = minLen / maxLen     // How similar the lengths of the two strings are (1 = same length, 0 = very different)
        // Interpolate between sMax and sMin based on length similarity:
        // - When lengths are similar, the score is closer to sMin
        //   (rewarding full coverage of the shorter string).
        // - When lengths differ a lot (lengthRatio small), the score is closer to sMax
        //   (penalizing big length mismatches).
        const boosted = sMax + (sMin - sMax) * lengthRatio
        return boosted
    }

    const PS_WEIGHT = 0.4
    const DICE_WEIGHT = 0.6

    function mixScore(ps: number, dice: number): number {
        return PS_WEIGHT * ps + DICE_WEIGHT * dice
    }

    function lineSimilarity(a: PreparedLine, b: PreparedLine, threshold: number): number {
        if (a.trimmedLen === 0 || b.trimmedLen === 0) return 0
        if (a.raw === b.raw) return 1
        if (a.normLen === 0 || b.normLen === 0) return 0

        const minRaw = Math.min(a.rawLen, b.rawLen)
        const maxRaw = Math.max(a.rawLen, b.rawLen)
        const r = maxRaw > 0 ? (minRaw / maxRaw) : 1
        const psUpperBound = 2 * r - r * r

        const na = a.profile.total
        const nb = b.profile.total
        const hasBigrams = na > 0 && nb > 0
        const diceUpperBound = hasBigrams ? (2 * Math.min(na, nb)) / (na + nb) : 0

        if (mixScore(psUpperBound, diceUpperBound) < threshold) return 0

        const ps = prefixSuffixScore(a.raw, b.raw)

        if (a.norm === b.norm) {
            const sim = mixScore(ps, 1)
            return sim >= threshold ? sim : 0
        }

        const maxSim = mixScore(ps, diceUpperBound)
        if (maxSim < threshold) return 0
        const dice = hasBigrams ? diceFromProfiles(a.profile, b.profile) : 0

        return mixScore(ps, dice)
    }

    // 0: none, 1: up, 2: left, 3: diag
    // const DIR_NONE = 0
    const DIR_UP = 1
    const DIR_LEFT = 2
    const DIR_DIAG = 3
    
    function alignByDP(leftOrig: PromptLine[], rightOrig: PromptLine[], threshold:number, bandWidth: number | null): Pair[] {
        const left = prepareLines(leftOrig)
        const right = prepareLines(rightOrig)

        const n = left.length
        const m = right.length
        const size = (n + 1) * (m + 1)

        const dirs = new Uint8Array(size)
        let previousScores = new Float32Array(m + 1)
        let currentScores = new Float32Array(m + 1)

        const idx = (i: number, j: number) => i * (m + 1) + j

        const useBand = bandWidth !== null && bandWidth >= 0 && bandWidth < Math.max(n, m)
        const diagSlope = n > 0 ? m / n : 0

        for (let i = 1; i <= n; i++) {
            currentScores.fill(0)
            let jStart = 1
            let jEnd = m
            if (useBand) {
                const center = Math.round(i * diagSlope)
                jStart = Math.max(1, center - bandWidth)
                jEnd = Math.min(m, center + bandWidth)
            }

            for (let j = jStart; j <= jEnd; j++) {
                let best = previousScores[j]
                let from = DIR_UP

                if (currentScores[j - 1] > best) {
                    best = currentScores[j - 1]
                    from = DIR_LEFT
                }

                const aLine = left[i - 1]
                const bLine = right[j - 1]

                const sim = lineSimilarity(aLine, bLine, threshold)
                if (sim >= threshold) {
                    const cand = previousScores[j - 1] + sim
                    if (cand > best) {
                        best = cand
                        from = DIR_DIAG
                    }
                }

                const curIdx = idx(i, j)
                currentScores[j] = best
                dirs[curIdx] = from
            }

            const completedScores = previousScores
            previousScores = currentScores
            currentScores = completedScores
        }

        // backtrack
        const pairs: Pair[] = []
        let i = n
        let j = m

        outer: while (i > 0 && j > 0) {
            const d = dirs[idx(i, j)]
            switch (d) {
                case DIR_DIAG:
                    pairs.push({ leftIndex: i - 1, rightIndex: j - 1 })
                    i--; j--
                    break
                case DIR_UP:
                    i--
                    break
                case DIR_LEFT:
                    j--
                    break
                default:
                    break outer
            }
        }

        return pairs.reverse()
    }

    function buildAlignmentFromAnchorPair(nLeft: number, nRight: number, pairs: Pair[]): PairCell[] {
        const cells: PairCell[] = []
        const extPairs: Pair[] = [
            { leftIndex: -1, rightIndex: -1 },        // start sentinel
            ...pairs,                                 // anchor pairs selected by DP
            { leftIndex: nLeft, rightIndex: nRight }, // end sentinel
        ]

        for (let k = 0; k < extPairs.length - 1; k++) {
            const curr = extPairs[k]         // current anchor pair or sentinel
            const next = extPairs[k + 1]    // next next anchor pair or sentinel

            let i = curr.leftIndex + 1
            let j = curr.rightIndex + 1

            while (i < next.leftIndex && j < next.rightIndex) {
                cells.push({ leftIndex: i, rightIndex: j })
                i++; j++;
            }

            while (i < next.leftIndex) {
                cells.push({ leftIndex: i, rightIndex: null })
                i++
            }

            while (j < next.rightIndex) {
                cells.push({ leftIndex: null, rightIndex: j })
                j++
            }

            if (next.leftIndex < nLeft && next.rightIndex < nRight) {
                cells.push({ leftIndex: next.leftIndex, rightIndex: next.rightIndex })
            }
        }

        return cells
    }

// View helpers
// -----------------------------------------------------------------------------
    function buildSegments(parts: DiffPart[], opts: SegmentOptions): DiffSegment[] {
        const { showOnlyChanges, contextRadius, scope, expandedRanges } = opts
        const len = parts.length
        if (len === 0) return []

        const segs: DiffSegment[] = []
        let current: DiffSegment | null = null

        const isContext = (part: DiffPart) => part.k === 'same'
        const keep = new Array<boolean>(len).fill(!showOnlyChanges)

        if (showOnlyChanges) {
            for (let i = 0; i < len; i++) {
                if (isContext(parts[i])) continue

                const from = Math.max(0, i - contextRadius)
                const to   = Math.min(len - 1, i + contextRadius)

                for (let j = from; j <= to; j++) {
                    keep[j] = true
                }
            }
            if (!keep.some(Boolean)) return []
        }

        if (showOnlyChanges) {
            for (const r of expandedRanges) {
                if (r.scope !== scope) continue
                const from = Math.max(0, r.from)
                const to   = Math.min(len - 1, r.to)
                for (let j = from; j <= to; j++) keep[j] = true
            }
        }

        const flushCurrent = () => {
            if (current) {
                segs.push(current)
                current = null
            }
        }

        const pushDivider = (pos: 'start' | 'between' | 'end', from: number, to: number) => {
            if (from > to) {
                if (pos === 'start' || pos === 'end') {
                    segs.push({ kind: 'divider', pos, id: `${scope}-${pos}`, from, to, omitted: 0 })
                }
                return
            }
            segs.push({ kind: 'divider', pos, id: `${scope}:${from}-${to}`, from, to, omitted: to - from + 1 })
        }

        let inKeptRun = false
        let lastKeptIndex = -1
        let lastRunEnd = -1 

        for (let i = 0; i < len; i++) {
            if (!keep[i]) {
                if (inKeptRun) {
                    flushCurrent()
                    inKeptRun = false
                    lastRunEnd = i - 1
                }
            continue
            }
            
            lastKeptIndex = i

            const part = parts[i]
            const ctx = isContext(part)
            if (!inKeptRun) {
                if (showOnlyChanges) {
                    if (lastRunEnd >= 0) pushDivider('between', lastRunEnd + 1, i - 1)
                    else pushDivider('start', 0, i - 1)
                }
                inKeptRun = true
            }

            if (!current) {
                current = { kind: ctx ? 'context' : 'changes', parts: [part] }
                continue
            }

            if (ctx && current.kind === 'context') {
                current.parts.push(part)
                continue
            }

            if (!ctx && current.kind === 'changes') {
                current.parts.push(part)
                continue
            }

            flushCurrent()
            current = { kind: ctx ? 'context' : 'changes', parts: [part] }
        }

        flushCurrent()

        if (showOnlyChanges) {
            pushDivider('end', lastKeptIndex + 1, len - 1)
        }

        return segs
    }

    function buildLines(parts: DiffPart[]): RenderLine[] {
        if (!isGrouped) return parts.map((part) => ({ kind: 'simple', part}))

        const lines: RenderLine[] = []
        let buffer: ModifyPart[] = []

        const flushBuffer = () => {
            if (!buffer.length) return
            if (buffer.length === 1) {
                lines.push({ kind: 'simple', part: buffer[0] })
            }
            else {
                lines.push({ kind: 'modifyGroup', parts: buffer })
            }
            buffer = []
        }
        for (const part of parts) {
            if (part.k === 'modify') {
                buffer.push(part)
            }
            else {
                flushBuffer()
                lines.push({ kind: 'simple', part })
            }
        }
        flushBuffer()

        return lines
    }

    function toSplitRows(segments: DiffSegment[], scope: string): SplitRow[] {
        const roleOfPart = (part: DiffPart, side: Side): SplitLineRole => {
            if (part.src !== 'linebyline') return null
            if (part.k === 'modify') return side === 'left' ? part.left.lineRole : part.right.lineRole
            return part.line.lineRole
        }
        const rows: SplitRow[] = []
        let idx = 0

        for (const seg of segments) {
            if (seg.kind === 'divider') {
                rows.push({ kind: 'divider', seg, scope, key: seg.id })
                continue
            }

            for (const part of seg.parts) {
                if (part.k === 'same') {
                    rows.push({
                        kind: 'row',
                        key: `${scope}:r${idx++}`,
                        left: { kind: 'part', side: 'left', part, role: roleOfPart(part, 'left') },
                        right: { kind: 'part', side: 'right', part, role: roleOfPart(part, 'right') },
                    })
                } else if (part.k === 'remove') {
                    rows.push({
                        kind: 'row',
                        key: `${scope}:r${idx++}`,
                        left: { kind: 'part', side: 'left', part, role: roleOfPart(part, 'left') },
                        right: { kind: 'empty', role: roleOfPart(part, 'right') },
                    })
                } else if (part.k === 'add') {
                    rows.push({
                        kind: 'row',
                        key: `${scope}:r${idx++}`,
                        left: { kind: 'empty', role: roleOfPart(part, 'left') },
                        right: { kind: 'part', side: 'right', part, role: roleOfPart(part, 'right') },
                    })
                } else {
                    rows.push({
                        kind: 'row',
                        key: `${scope}:r${idx++}`,
                        left: { kind: 'part', side: 'left', part, role: roleOfPart(part, 'left') },
                        right: { kind: 'part', side: 'right', part, role: roleOfPart(part, 'right') },
                    })
                }
            }
        }

        return rows
    }

    function expandRange(scope: string, from: number, to: number) {
        if (from > to) return
        if (expandedRanges.some(r => r.scope === scope && r.from === from && r.to === to)) return
        expandedRanges = [...expandedRanges, { scope, from, to }]
    }

</script>

{#snippet renderCounts(counts: DiffCounts)}
  <div class="flex flex-wrap gap-3 text-xs text-subtext mb-3">
    <span class="inline-flex items-center gap-2">
      <span class="inline-block w-1 h-4 rounded-sm bg-accent"></span>
      {counts.modifiedCount}
    </span>
    <span class="inline-flex items-center gap-2">
      <span class="inline-block w-1 h-4 rounded-sm bg-success"></span>
      {counts.addedCount}
    </span>
    <span class="inline-flex items-center gap-2">
      <span class="inline-block w-1 h-4 rounded-sm bg-danger"></span>
      {counts.removedCount}
    </span>
  </div>
{/snippet}

{#snippet renderSimpleLine(part: NonModifyPart)}
  <div
    class={lineClassOf(part)}
    class:mt-5={isNameLine(part)}
    class:mb-5={isHeaderLine(part)}
  >
    {#if isLineby(part) && part.line.lineRole === 'body' && part.line.text === ''}
      <br />
    {:else}
      {lineTextOf(part)}{#if isLineby(part) && (part.line.lineRole === 'name' || part.line.lineRole === 'header')}
        <span class={nameHeaderTagClass}>
          {part.line.lineRole === 'name' ? language.promptDiff.name : language.promptDiff.type}
        </span>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet renderTokens(tokens: WordToken[], skip: SimpleDiff | null, pack: TokenClassPack)}
  {#each tokens as tok, j (j)}
    {#if skip === null || tok.t !== skip}
      <span class={tok.t === 'add' ? pack.add : tok.t === 'remove' ? pack.remove : pack.same}>
        {tok.v}
      </span>
    {/if}
  {/each}
{/snippet}

{#snippet renderModify(part: ModifyPart, idx: number)}
  {@const tag = tagText(part)}
  {#if diffStyle === 'line'}
    <!-- line diff -->
    <div
      class={`whitespace-pre-wrap ${lineRemoveClass}`}
      class:mt-5={isLineby(part) && part.right.lineRole === 'name' && idx > 0}
    >
      {@render renderTokens(part.tokens, 'add', tokenPackLineRemove)}{#if tag}<span class={nameHeaderTagClass}>{tag}</span>{/if}
    </div>

    <div
      class={`whitespace-pre-wrap ${lineAddClass}`}
      class:mb-5={isLineby(part) && part.right.lineRole === 'header'}
    >
      {#if part.src === 'linebyline' && part.right.text === ''}
        <span class="text-subtext/60 italic">{language.promptDiff.emptyLine}</span>
      {:else}
        {@render renderTokens(part.tokens, 'remove', tokenPackLineAdd)}{#if tag}<span class={nameHeaderTagClass}>{tag}</span>{/if}
      {/if}
    </div>

  {:else} <!-- intraline diff -->
    <div
      class={`whitespace-pre-wrap ${lineModifyClass}`}
      class:mt-5={isLineby(part) && part.right.lineRole === 'name' && idx > 0}
      class:mb-5={isLineby(part) && part.right.lineRole === 'header'}
    >
      {@render renderTokens(part.tokens, null, tokenPackIntraline)}{#if tag}<span class={nameHeaderTagClass}>{tag}</span>{/if}
    </div>
  {/if}
{/snippet}

{#snippet renderModifyGroup(parts: ModifyPart[])}
  {#if diffStyle === 'line'}
    <!-- grouped + line diff -->
    <div class={`whitespace-pre-wrap ${lineRemoveClass}`}>
    {#each parts as part, i (i)}
      {@render renderTokens(part.tokens, 'add', tokenPackLineRemove)}{#if tagText(part)}<span class={nameHeaderTagClass}>{tagText(part)}</span>{/if}

      {#if i < parts.length - 1}
        {'\n'}
      {/if}
    {/each}
    </div>

    <div class={`whitespace-pre-wrap ${lineAddClass}`}>
    {#each parts as part, i (i)}
      {#if part.src === 'linebyline' && part.right.text === ''}
        <span class="text-subtext/60 italic">{language.promptDiff.emptyLine}</span>
      {:else}
        {@render renderTokens(part.tokens, 'remove', tokenPackLineAdd)}{#if tagText(part)}<span class={nameHeaderTagClass}>{tagText(part)}</span>{/if}
      {/if}

      {#if i < parts.length - 1}
        {'\n'}
      {/if}
    {/each}
    </div>
  {/if}
{/snippet}

{#snippet renderCardMeta(part: DiffPart | null | undefined, type: string, side: Side | null)}
  <div class="flex min-w-0 items-start gap-2">
    <span class="text-[10px] uppercase tracking-wide text-subtext">{type}</span>

    <div class="min-w-0">
    {#if part && part.src === 'linebyline'}
      {#if part.k === 'modify'}
        {#if diffStyle === 'line'}
          <!-- line diff -->
          {#if side === null}
            <!-- unified -->
            <div class="whitespace-pre-wrap text-danger">
              {@render renderTokens(part.tokens, 'add', tokenPackLineRemove)}
            </div>
            <div class="whitespace-pre-wrap text-success">
              {@render renderTokens(part.tokens, 'remove', tokenPackLineAdd)}
            </div>
          {:else} <!-- split -->
            <div class={`whitespace-pre-wrap ${side === 'left' ? 'text-danger' : 'text-success'}`}>
              {@render renderTokens(
                part.tokens,
                side === 'left' ? 'add' : 'remove',
                side === 'left' ? tokenPackLineRemove : tokenPackLineAdd
              )}
            </div>
          {/if}

        {:else}
          <!-- intraline diff -->
          {#if side === null}
            <!-- unified intraline -->
            <div class="whitespace-pre-wrap">
              {@render renderTokens(part.tokens, null, tokenPackIntraline)}
            </div>
          {:else}
            <!-- split intraline: -->
            <div class={`whitespace-pre-wrap ${side === 'left' ? 'text-danger' : 'text-success'}`}>
              {@render renderTokens(
                part.tokens,
                side === 'left' ? 'add' : 'remove',
                tokenPackIntraline
              )}
            </div>
          {/if}
        {/if}

      {:else}
        <!-- same/add/remove -->
        <div
          class={`whitespace-pre-wrap ${
            part.k === 'same'
              ? 'text-maintext'
              : part.k === 'add'
              ? 'text-success'
              : 'text-danger'
          }`}
        >
          {part.line.text}
        </div>
      {/if}
    {:else}
      <div class="text-xs text-subtext italic">{formatPromptDiffText(language.promptDiff.missingField, { field: type })}</div>
    {/if}
    </div>
  </div>
{/snippet}

{#snippet renderDivider(d: Extract<DiffSegment, { kind: 'divider' }>, scope: string)}
  <div class="my-3 flex items-center gap-3 text-xs text-subtext/70">
    <div class="h-px flex-1 bg-darkborderc/50"></div>
    <button
      type="button"
      class={`px-2 py-0.5 rounded-sm border border-darkborderc bg-darkbg shadow-md
        ${d.omitted > 0 ? 'risu-interactive-border risu-interactive-foreground hover:shadow-lg cursor-pointer' : 'text-subtext/50 cursor-default'}`}
      disabled={d.omitted === 0}
      onclick={() => expandRange(scope, d.from, d.to)}
      title={d.omitted > 0 ? language.promptDiff.expandHiddenLines : ''}
    >
      {#if d.pos === 'start'}
        {#if d.omitted > 0}
          {formatPromptDiffText(language.promptDiff.linesAboveHidden, { count: d.omitted })}
        {:else}
          {language.promptDiff.startOfPrompt}
        {/if}

      {:else if d.pos === 'between'}
        {formatPromptDiffText(language.promptDiff.linesSkipped, { count: d.omitted })}

      {:else} <!-- end -->
        {#if d.omitted > 0}
          {formatPromptDiffText(language.promptDiff.linesBelowHidden, { count: d.omitted })}
        {:else}
          {language.promptDiff.endOfPrompt}
        {/if}
      {/if}
    </button>

    <div class="h-px flex-1 bg-darkborderc/50"></div>
  </div>
{/snippet}

{#snippet renderSplitCell(cell: SplitCell, idx: number)}
  {@const role = cell.role}
    {#if cell.kind === 'empty'}
      <div
        class={splitEmptyLineClass}
        class:mt-5={role === 'name' && idx > 0}
        class:mb-5={role === 'header'}
      >
        &nbsp;
      </div>

  {:else}
    {@const part = cell.part}
    {@const side = cell.side}
    {@const isLeft = side === 'left'}

    {#if part.k !== 'modify'}
      {@render renderSimpleLine(part)}

    {:else}
      {@const tag = tagText(part)}
      {@const sideText =
        isLineby(part) ? (isLeft ? part.left.text : part.right.text) : null}

      <div
        class={`whitespace-pre-wrap ${isLeft ? lineRemoveClass : lineAddClass}`}
        class:mt-5={role === 'name' && idx > 0}
        class:mb-5={role === 'header'}
      >
        {#if isLineby(part) && sideText === ''}
          <span class="text-subtext/60 italic">{language.promptDiff.emptyLine}</span>
        {:else}
          {@render renderTokens(part.tokens, isLeft ? 'add' : 'remove', diffStyle === 'line' ? (isLeft ? tokenPackLineRemove : tokenPackLineAdd) : tokenPackIntraline)}
        {/if}

        {#if tag}
          <span class={nameHeaderTagClass}>{tag}</span>
        {/if}
      </div>
    {/if}
  {/if}
{/snippet}

{#snippet renderCardStatus(cardPart: CardBodyDiff)}
  {@const c = cardPart.bodyLines?.counts ?? ({ modifiedCount: 0, addedCount: 0, removedCount: 0 })}
  {@const cardChangeCount = (c.modifiedCount ?? 0) + (c.addedCount ?? 0) + (c.removedCount ?? 0)}

  {@const statusLabel =
    cardPart.k === 'modify' ? language.promptDiff.modified
    : cardPart.k === 'add'  ? language.promptDiff.added
    : cardPart.k === 'remove' ? language.promptDiff.removed
    : language.promptDiff.unchanged}

  <div class="flex flex-col items-end gap-1 shrink-0">
    <Badge
      variant={cardPart.k === 'modify' ? 'info' : cardPart.k === 'add' ? 'success' : cardPart.k === 'remove' ? 'destructive' : 'secondary'}
      size="sm"
    >
      {statusLabel}
    </Badge>
    <div class="flex items-center gap-3 text-[11px] text-subtext">
      <span>{formatPromptDiffText(language.promptDiff.changeCount, { count: cardChangeCount })}</span>
      <span class="tabular-nums">~{c.modifiedCount ?? 0} / +{c.addedCount ?? 0} / -{c.removedCount ?? 0}</span>
    </div>
  </div>
{/snippet}


<Dialog
  open={true}
  size="xl"
  closable={false}
  closeOnEscape={false}
  closeOnOutsideClick={false}
  contentClass="gap-0 p-0"
  bodyClass="min-h-0 flex flex-col"
  ariaLabel={language.promptDiff.title}
>
    
    <div class="flex items-center gap-3 px-4 py-3 border-b border-darkborderc">
      <div class="flex min-w-0 flex-1 flex-nowrap items-center gap-4 overflow-x-auto">
        <div class="flex shrink-0 items-center gap-2">
          <span class="text-xs text-subtext">{language.promptDiff.viewMode}</span>
          <div class="flex items-center gap-1">
            <ChoiceGroup variant="pill" name="diffStyle" bind:value={diffStyle} options={diffOptions} />
            <ChoiceGroup variant="pill" name="formatStyle" bind:value={formatStyle} options={formatOptions} />
            <ChoiceGroup variant="pill" name="viewStyle" bind:value={viewStyle} options={viewOptions} />
          </div>
        </div>
        <Checkbox
          bind:check={isGrouped}
          disabled={diffStyle !== 'line' || viewStyle === 'split'}
          margin={false}
          grayText
          className="shrink-0 whitespace-nowrap text-xs"
          name={language.promptDiff.groupChanges}
        />
        <Checkbox
          bind:check={showOnlyChanges}
          margin={false}
          grayText
          className="shrink-0 whitespace-nowrap text-xs"
          name={language.promptDiff.onlyChanges}
        />
        {#if showOnlyChanges}
          <div class="flex shrink-0 items-center gap-2">
            <span class="text-xs text-subtext">{language.promptDiff.context}</span>
            <Slider
              className="w-28"
              min={0}
              max={5}
              step={1}
              bind:value={contextRadius}
              format={(value) => String(value)}
              inputWidth="w-4"
            />
          </div>
        {/if}
      </div>

      <IconButton
        onclick={handleClose}
        title={language.close}
        aria-label={language.close}
      >
        <XIcon size={20}/>
      </IconButton>
    </div>

    <div class="min-h-0 overflow-y-auto p-4">
      <!-- card view -->
      {#if formatStyle === 'card'}
        {#if cardDiffResult}
          <div class="mb-3 flex items-center gap-2 text-xs text-subtext">
            <span>{language.promptDiff.changedBlocks}:</span>
            <span class="tabular-nums">
              <span class="text-accent">~{cardDiffResult.cardCounts.modifiedCount}</span>
              <span aria-hidden="true"> / </span>
              <span class="text-success">+{cardDiffResult.cardCounts.addedCount}</span>
              <span aria-hidden="true"> / </span>
              <span class="text-danger">-{cardDiffResult.cardCounts.removedCount}</span>
            </span>
          </div>

          <div class="grid gap-3">
            {#each visibleCardParts as cardPart, idx (idx)}
              {#if viewStyle === 'unified'}
              {@const lines = cardPart.bodyLines.parts}
              {@const namePart = lines[0]}
              {@const headerPart = lines[1]}
              {@const bodyParts = lines.slice(2)}

              <div class="prompt-diff-hover bg-lightbg border border-darkborderc rounded-xl p-3 flex flex-col gap-2">
                <!-- name / header / card diff -->
                <div class="flex items-start justify-between gap-2">
                  <div class="flex min-w-0 flex-col gap-2">
                    {@render renderCardMeta(namePart, language.promptDiff.name, null)}
                    {@render renderCardMeta(headerPart, language.promptDiff.type, null)}
                  </div>

                  <!-- card diff -->
                  {@render renderCardStatus(cardPart)}
                </div>

                <!-- body -->
                <div class="mt-2 border-t border-darkborderc pt-2 font-mono text-sm leading-5">
                  {#if bodyParts.length === 0}
                    <div class="text-subtext italic">{language.promptDiff.noBodyContent}</div>
                  {:else}
                    {@const segments = buildSegments(bodyParts, { showOnlyChanges, contextRadius, scope: `card-${idx}`, expandedRanges })}
                    {#each segments as seg, sIdx (sIdx)}
                      {#if seg.kind === 'divider'}
                        {@render renderDivider(seg, `card-${idx}`)}
                      {:else if seg.kind === 'context'}
                        {#each seg.parts as part, idx (idx)}
                          {#if part.k !== 'modify'}
                            {@render renderSimpleLine(part)}
                          {/if}
                        {/each}
                      {:else} <!-- change segment -->
                        {@const lines = buildLines(seg.parts)}
                        {#each lines as line, idx (idx)}
                          {#if line.kind === 'simple'}
                          {@const part = line.part}
                            {#if part.k !== 'modify'}
                              {@render renderSimpleLine(part)}
                            {:else} <!-- modify -->
                              {@render renderModify(part, idx)}
                            {/if}
                          {:else} <!-- modifyGroup -->
                            {@render renderModifyGroup(line.parts)}
                          {/if}
                        {/each}
                      {/if}
                    {/each}
                  {/if}
                </div>
              </div>
              {:else} <!-- split view -->
                {@const scope = `card-${idx}`}
                {@const lines = cardPart.bodyLines?.parts ?? []}
                {@const namePart = lines[0] ?? null}
                {@const headerPart = lines[1] ?? null}
                {@const bodyParts = lines.slice(2)}

                {@const leftExists = cardPart.k !== 'add'}
                {@const rightExists = cardPart.k !== 'remove'}

                {@const segments = buildSegments(bodyParts, { showOnlyChanges, contextRadius, scope, expandedRanges })}
                {@const rows = toSplitRows(segments, scope)}

                <div class="relative">
                  <div class="absolute inset-0 grid grid-cols-2 gap-x-3 pointer-events-none">
                    <div class="bg-lightbg border border-darkborderc rounded-xl"></div>
                    <div class="bg-lightbg border border-darkborderc rounded-xl"></div>
                  </div>

                  <div class="relative z-10 grid grid-cols-2 gap-x-3 p-px">
                    <!-- left header -->
                    <div class="p-3">
                      {#if leftExists && namePart && headerPart}
                        <div class="flex items-start justify-between gap-2">
                          <div class="flex min-w-0 flex-col gap-2">
                            {@render renderCardMeta(namePart, language.promptDiff.name, 'left')}
                            {@render renderCardMeta(headerPart, language.promptDiff.type, 'left')}
                          </div>
                          {@render renderCardStatus(cardPart)}
                        </div>
                      {:else}
                        <div class="h-[70px] rounded-lg border border-dashed border-darkborderc/50 bg-darkbg/50 flex items-center justify-center">
                          <span class="text-subtext/60 italic text-xs select-none">-</span>
                        </div>
                      {/if}
                    </div>

                    <!-- right header -->
                    <div class="p-3">
                      {#if rightExists && namePart && headerPart}
                        <div class="flex items-start justify-between gap-2">
                          <div class="flex min-w-0 flex-col gap-2">
                            {@render renderCardMeta(namePart, language.promptDiff.name, 'right')}
                            {@render renderCardMeta(headerPart, language.promptDiff.type, 'right')}
                          </div>
                          {@render renderCardStatus(cardPart)}
                        </div>
                      {:else}
                        <div class="h-[70px] rounded-lg border border-dashed border-darkborderc/50 bg-darkbg/50 flex items-center justify-center">
                          <span class="text-subtext/60 italic text-xs select-none">-</span>
                        </div>
                      {/if}
                    </div>

                    <div class="h-px bg-darkborderc/50 mx-3"></div>
                    <div class="h-px bg-darkborderc/50 mx-3"></div>

                    <!-- body rows -->
                    {#each rows as r, rIdx (r.key)}
                      {#if r.kind === 'divider'}
                        <div class="col-span-2 px-2">
                          {@render renderDivider(r.seg, r.scope)}
                        </div>
                      {:else}
                        <div class="contents group">
                        <div class="px-3 py-0.5 font-mono text-sm leading-5 group-hover:bg-selected/30 group-hover:outline group-hover:outline-1 group-hover:outline-lightborderc/30">
                          {@render renderSplitCell(leftExists ? r.left : { kind: 'empty', role: r.left.role }, rIdx)}
                        </div>
                        <div class="px-3 py-0.5 font-mono text-sm leading-5 group-hover:bg-selected/30 group-hover:outline group-hover:outline-1 group-hover:outline-lightborderc/30">
                          {@render renderSplitCell(rightExists ? r.right : { kind: 'empty', role: r.right.role }, rIdx)}
                        </div>
                        </div>
                      {/if}
                    {/each}
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        {:else}
          <div class="text-subtext text-sm">{language.promptDiff.calculating}</div>
        {/if}
      {:else}<!-- raw view -->
        {#if cardlineFlatResult}
          {@const segments = buildSegments(cardlineFlatResult.parts, { showOnlyChanges, contextRadius, scope: 'raw', expandedRanges })}
          {@render renderCounts(cardlineFlatResult.counts)}

          {#if showOnlyChanges && segments.length === 0}
            <div class="flex items-center justify-center py-10">
              <div class="flex items-center gap-2 px-3 py-2 rounded-lg border border-darkborderc bg-lightbg text-subtext">
                <span class="inline-block w-2 h-2 rounded-full bg-success/70"></span>
                <span class="text-sm">{language.promptDiff.noChanges}</span>
              </div>
            </div>
          {:else if viewStyle === 'unified'}
          <div class="font-mono text-sm leading-5">
            {#each segments as seg, sIdx (sIdx)}
              {#if seg.kind === 'divider'}
                {@render renderDivider(seg, 'raw')}
              {:else if seg.kind === 'context'}
                {#each seg.parts as part, idx (idx)}
                  {#if part.k !== 'modify'}
                    {@render renderSimpleLine(part)}
                  {/if}
                {/each}
              {:else} <!-- change segment -->
                {@const lines = buildLines(seg.parts)}
                {#each lines as line, idx (idx)}
                  {#if line.kind === 'simple'}
                    {@const part = line.part}
                    {#if part.k !== 'modify'}
                      {@render renderSimpleLine(part)}
                    {:else} <!-- modify -->
                      {@render renderModify(part, idx)}
                    {/if}
                  {:else} <!-- modifyGroup -->
                    {@render renderModifyGroup(line.parts)}
                  {/if}
                {/each}
              {/if}
            {/each}
          </div>
          {:else} <!-- split view -->
            {@const rows = toSplitRows(segments, 'raw')}
            <div class="rounded-xl border border-darkborderc bg-lightbg overflow-hidden">
              <div class="grid grid-cols-[1fr_auto_1fr] gap-0 font-mono text-sm leading-5">
                {#each rows as r, idx (r.key)}
                  {#if r.kind === 'divider'}
                    <div class="col-span-3 px-2">
                      {@render renderDivider(r.seg, r.scope)}
                    </div>
                  {:else}
                    <div class="contents group">
                    <div class="px-3 py-0.5 bg-darkbg/50 group-hover:bg-selected/30 group-hover:outline group-hover:outline-1 group-hover:outline-lightborderc/30">
                      {@render renderSplitCell(r.left, idx)}
                    </div>
                    <div class="w-px bg-darkborderc/50"></div>
                    <div class="px-3 py-0.5 bg-darkbg/50 group-hover:bg-selected/30 group-hover:outline group-hover:outline-1 group-hover:outline-lightborderc/30">
                      {@render renderSplitCell(r.right, idx)}
                    </div>
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}
        {:else}
          <div class="text-subtext text-sm">{language.promptDiff.calculating}</div>
        {/if}
      {/if}
    </div>

</Dialog>

<style>
  :global(.diff-empty-pattern) {
    background-image: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--risu-theme-selected) 35%, transparent) 0 10px,
      color-mix(in srgb, var(--risu-theme-darkbg) 35%, transparent) 10px 20px
    );
  }
</style>
