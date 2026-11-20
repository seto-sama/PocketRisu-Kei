<script lang="ts">
    import { onDestroy } from 'svelte'
    import Dialog from 'src/lib/UI/components/Dialog.svelte'
    import Button from 'src/lib/UI/components/Button.svelte'
    import ChoiceGroup from 'src/lib/UI/components/ChoiceGroup.svelte'
    import Checkbox from 'src/lib/UI/components/Checkbox.svelte'
    import Badge from 'src/lib/UI/components/Badge.svelte'
    import { language } from 'src/lang'
    import { loadDiffModule, visibleDiffLines } from 'src/ts/gui/textDiff'
    import { saveConflictDialog } from 'src/ts/storage/saveConflict'
    import type { ConflictSelection } from 'src/ts/storage/saveConflict'

    type DiffToken = { value: string, kind: 'same' | 'removed' | 'added' }
    type DiffRow = { server: DiffToken[], local: DiffToken[], changed: boolean }
    type VisibleRow = { kind: 'row', row: DiffRow } | { kind: 'hidden', from: number, to: number }

    const activeDialog = $derived($saveConflictDialog)
    let open = $state(false)
    let choices = $state<ConflictSelection[]>([])
    let diffModule = $state<typeof import('diff') | null>(null)
    let expandedRanges = $state<Array<{ scope: string, from: number, to: number }>>([])

    const choiceOptions = $derived([
        { value: 'server', label: language.saveConflict.useServer },
        { value: 'local', label: language.saveConflict.useLocal },
    ])
    const comparisonSides = ['server', 'local'] as const

    $effect(() => {
        const nextDialog = activeDialog
        open = nextDialog !== null
        choices = nextDialog?.items.map(() => null) ?? []
        expandedRanges = []

        if (!nextDialog) return
        let current = true
        void loadDiffModule().then(module => {
            if (current) diffModule = module
        }).catch(error => {
            console.error('[save-conflict] Could not load text diff module', error)
        })
        return () => { current = false }
    })

    onDestroy(() => {
        activeDialog?.complete(null)
    })

    function setChoice(index: number, value: string) {
        if (value !== 'server' && value !== 'local') return
        choices[index] = value
    }

    function sideSelected(index: number, side: 'server' | 'local') {
        const choice = choices[index]
        return choice === side || activeDialog?.multiple === true && choice === 'both'
    }

    function withSideSelected(choice: ConflictSelection, side: 'server' | 'local', selected: boolean): ConflictSelection {
        const hasServer = choice === 'server' || choice === 'both'
        const hasLocal = choice === 'local' || choice === 'both'
        const nextServer = side === 'server' ? selected : hasServer
        const nextLocal = side === 'local' ? selected : hasLocal
        return nextServer && nextLocal ? 'both' : nextServer ? 'server' : nextLocal ? 'local' : null
    }

    function setSideChoice(index: number, side: 'server' | 'local', selected: boolean) {
        choices[index] = withSideSelected(choices[index], side, selected)
    }

    function setSideForAll(side: 'server' | 'local', selected: boolean) {
        if (!activeDialog) return
        if (!activeDialog.multiple) {
            choices = choices.map(choice => selected ? side : choice === side ? null : choice)
            return
        }
        choices = choices.map(choice => withSideSelected(choice, side, selected))
    }

    function cancel() {
        activeDialog?.complete(null)
    }

    function submit() {
        if (!activeDialog || !canSubmit) return
        activeDialog.complete(choices)
    }

    const canSubmit = $derived(
        activeDialog !== null
        && choices.length === activeDialog.items.length
        && (activeDialog.multiple === true || choices.every(choice => choice === 'server' || choice === 'local')),
    )

    function splitLines(text: string) {
        return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(line => line.replace(/\r?\n$/, ''))
    }

    function buildDiffRows(serverText: string, localText: string): DiffRow[] {
        if (!diffModule) {
            return []
        }

        const changes = diffModule.diffLines(serverText, localText)
        const rows: DiffRow[] = []
        let partIndex = 0
        while (partIndex < changes.length) {
            const part = changes[partIndex]
            if (!part.added && !part.removed) {
                for (const line of splitLines(part.value)) {
                    const tokens: DiffToken[] = [{ value: line, kind: 'same' }]
                    rows.push({ server: tokens, local: tokens, changed: false })
                }
                partIndex++
                continue
            }

            const removed: string[] = []
            const added: string[] = []
            while (partIndex < changes.length && (changes[partIndex].added || changes[partIndex].removed)) {
                const change = changes[partIndex++]
                if (change.removed) removed.push(...splitLines(change.value))
                if (change.added) added.push(...splitLines(change.value))
            }

            const changedLineCount = Math.max(removed.length, added.length)
            for (let lineIndex = 0; lineIndex < changedLineCount; lineIndex++) {
                const serverLine = removed[lineIndex]
                const localLine = added[lineIndex]
                if (serverLine !== undefined && localLine !== undefined) {
                    const words = diffModule.diffWordsWithSpace(serverLine, localLine)
                    rows.push({
                        server: words.filter(word => !word.added).map<DiffToken>(word => ({ value: word.value, kind: word.removed ? 'removed' : 'same' })),
                        local: words.filter(word => !word.removed).map<DiffToken>(word => ({ value: word.value, kind: word.added ? 'added' : 'same' })),
                        changed: true,
                    })
                } else if (serverLine !== undefined) {
                    rows.push({ server: [{ value: serverLine, kind: 'removed' }], local: [], changed: true })
                } else if (localLine !== undefined) {
                    rows.push({ server: [], local: [{ value: localLine, kind: 'added' }], changed: true })
                }
            }
        }
        return rows
    }

    const conflictPreviews = $derived(activeDialog?.items ?? [])

    function visibleRows(rows: DiffRow[], scope: string): VisibleRow[] {
        const visible = visibleDiffLines(rows.map(row => row.changed), true, 1,
            expandedRanges.filter(range => range.scope === scope))
        const result: VisibleRow[] = []
        for (let index = 0; index < rows.length; index++) {
            if (visible[index]) {
                result.push({ kind: 'row', row: rows[index] })
            } else {
                const from = index
                while (index + 1 < rows.length && !visible[index + 1]) index++
                result.push({ kind: 'hidden', from, to: index })
            }
        }
        return result
    }

    const visibleDiffs = $derived.by(() => conflictPreviews.map((presentation, conflictIndex) =>
        presentation.blocks.map((block, blockIndex) => ({
            ...block,
            scope: `${conflictIndex}:${blockIndex}`,
            rows: visibleRows(buildDiffRows(block.server.text, block.local.text), `${conflictIndex}:${blockIndex}`),
        })),
    ))

    function lineClass(tokens: DiffToken[]) {
        if (tokens.some(token => token.kind === 'removed')) return 'border-danger bg-danger/10'
        if (tokens.some(token => token.kind === 'added')) return 'border-success bg-success/10'
        return 'border-transparent'
    }

    function tokenClass(token: DiffToken) {
        if (token.kind === 'removed') return 'rounded-sm bg-danger/20 text-danger'
        if (token.kind === 'added') return 'rounded-sm bg-success/20 text-success'
        return 'text-maintext'
    }
</script>

{#snippet renderLine(tokens: DiffToken[])}
    <div class={`min-h-5 whitespace-pre-wrap break-words rounded-sm border-l-4 pl-2 ${lineClass(tokens)}`}>
        {#each tokens as token}<span class={tokenClass(token)}>{token.value}</span>{/each}{#if tokens.length === 0 || tokens.every(token => token.value === '')}<span aria-hidden="true">&nbsp;</span>{/if}
    </div>
{/snippet}

<Dialog
    bind:open
    size="xl"
    onRequestClose={cancel}
    ariaLabel={language.saveConflict.title}
    contentClass="h-[90dvh] max-h-[90dvh] overflow-hidden"
    bodyClass="min-h-0 grow overflow-y-auto"
>
    {#snippet title()}
        {activeDialog?.title || language.saveConflict.title}
    {/snippet}
    {#snippet description()}
        {activeDialog?.description ?? language.saveConflict.description}
    {/snippet}
    <div class="flex min-h-0 flex-col gap-4 pr-1">
        <div class="grid grid-cols-2 gap-x-3">
            {#each comparisonSides as side}
                {const label = $derived(side === 'server'
                    ? activeDialog?.serverLabel ?? language.saveConflict.server
                    : activeDialog?.localLabel ?? language.saveConflict.local)}
                {const selectedCount = $derived(choices.filter((_, index) => sideSelected(index, side)).length)}
                <div class="flex min-w-0 items-center rounded-xl border border-darkborderc bg-lightbg px-3 py-2">
                    <Checkbox
                        name={label}
                        check={choices.length > 0 && selectedCount === choices.length}
                        indeterminate={selectedCount > 0 && selectedCount < choices.length}
                        onChange={checked => setSideForAll(side, checked)}
                        disabled={!choices.length}
                        margin={false}
                        className="text-sm font-semibold"
                    />
                </div>
            {/each}
        </div>
        {#each conflictPreviews as presentation, index (index)}
            <section aria-labelledby={`save-conflict-${index}`}>
                <h3 id={`save-conflict-${index}`} class="mb-2 text-sm font-semibold text-maintext">
                    {presentation.label}
                </h3>
                {#if activeDialog?.multiple}
                    <div class="mb-2 grid grid-cols-2 gap-x-3">
                        {#each comparisonSides as side}
                            {const label = $derived(side === 'server'
                                ? activeDialog.serverLabel ?? language.saveConflict.server
                                : activeDialog.localLabel ?? language.saveConflict.local)}
                            <Checkbox
                                name={label}
                                check={sideSelected(index, side)}
                                onChange={checked => setSideChoice(index, side, checked)}
                                margin={false}
                            />
                        {/each}
                    </div>
                {/if}
                <div class="flex flex-col gap-3">
                    {#each visibleDiffs[index] ?? [] as block (block.scope)}
                        <div class="relative">
                            <div class="pointer-events-none absolute inset-0 grid grid-cols-2 gap-x-3" aria-hidden="true">
                                <div class="rounded-xl border border-darkborderc bg-lightbg"></div>
                                <div class="rounded-xl border border-darkborderc bg-lightbg"></div>
                            </div>
                            <div class="relative grid grid-cols-2 gap-x-3 p-px pb-3">
                                {#each [block.server, block.local] as preview, sideIndex}
                                    <div class="min-w-0 p-3">
                                        <h4 class="mb-2 text-xs text-subtext">{sideIndex === 0
                                            ? activeDialog?.serverLabel ?? language.saveConflict.server
                                            : activeDialog?.localLabel ?? language.saveConflict.local}</h4>
                                        <div class="flex flex-wrap items-center justify-between gap-2 text-sm text-maintext">
                                            <span class="min-w-0 break-words font-semibold">{preview.name}</span>
                                            <Badge variant="secondary" size="xs">{preview.type}</Badge>
                                        </div>
                                    </div>
                                {/each}
                                {#if !diffModule}
                                    <div class="col-span-full px-3 py-3 text-sm text-subtext">{language.promptDiff.calculating}</div>
                                {/if}
                                {#each block.rows as item, rowIndex (rowIndex)}
                                    {#if item.kind === 'hidden'}
                                        <div class="col-span-full my-3 flex items-center gap-3 px-3 text-xs text-subtext/70">
                                            <div class="h-px flex-1 bg-darkborderc/50"></div>
                                            <button type="button" class="risu-interactive-border risu-interactive-foreground rounded-sm border border-darkborderc bg-darkbg px-2 py-0.5"
                                                title={language.promptDiff.expandHiddenLines}
                                                onclick={() => expandedRanges = [...expandedRanges, { scope: block.scope, from: item.from, to: item.to }]}>
                                                {language.promptDiff.linesSkipped.replaceAll('{count}', String(item.to - item.from + 1))}
                                            </button>
                                            <div class="h-px flex-1 bg-darkborderc/50"></div>
                                        </div>
                                    {:else}
                                        <div class="contents group">
                                            <div class="min-w-0 px-3 py-0.5 font-mono text-sm leading-5 group-hover:bg-selected/30">{@render renderLine(item.row.server)}</div>
                                            <div class="min-w-0 px-3 py-0.5 font-mono text-sm leading-5 group-hover:bg-selected/30">{@render renderLine(item.row.local)}</div>
                                        </div>
                                    {/if}
                                {/each}
                            </div>
                        </div>
                    {/each}
                </div>
                {#if !activeDialog?.multiple}
                    <ChoiceGroup
                        value={choices[index] ?? ''}
                        onValueChange={value => setChoice(index, value)}
                        options={choiceOptions}
                        variant="grid"
                        activeColor="selected"
                        size="sm"
                        className="mt-3"
                    />
                {/if}
            </section>
        {/each}
    </div>
    {#snippet footer()}
        <Button variant="outline" onclick={cancel}>{language.saveConflict.cancel}</Button>
        <Button variant="primary" disabled={!canSubmit} onclick={submit}>{activeDialog?.submitLabel ?? language.saveConflict.save}</Button>
    {/snippet}
</Dialog>
