<div class="risu-field-border h-full min-h-0 w-full overflow-hidden rounded-md bg-bgcolor text-textcolor" bind:this={editorRoot}></div>

<script lang="ts">
    import { autocompletion, completionKeymap, type CompletionContext } from '@codemirror/autocomplete'
    import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
    import { Compartment, EditorState } from '@codemirror/state'
    import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
    import { minimalSetup } from 'codemirror'
    import { onDestroy, onMount } from 'svelte'
    import { AllCBS, getCBSHighlightRanges, type HighlightType } from 'src/ts/gui/highlight'

    interface Props {
        value: string
        wordWrap?: boolean
        onSave?: () => void
    }

    let {
        value = $bindable(),
        wordWrap = true,
        onSave = () => {},
    }: Props = $props()

    let editorRoot: HTMLDivElement
    let editor: EditorView | undefined
    const wrapCompartment = new Compartment()

    const highlightClasses: Record<HighlightType, string> = {
        cbsnest0: 'cm-cbs-keyword',
        cbsnest1: 'cm-cbs-type',
        cbsnest2: 'cm-cbs-literal',
        cbsnest3: 'cm-cbs-variable',
        cbsnest4: 'cm-cbs-keyword',
        cbsdisplay: 'cm-cbs-type',
        comment: 'cm-cbs-comment',
        decorator: 'cm-cbs-keyword',
        deprecated: 'cm-cbs-deprecated',
    }

    function buildHighlights(view: EditorView): DecorationSet {
        const length = view.state.doc.length
        const decorations = getCBSHighlightRanges(view.state.doc.toString())
            .filter(([[from, to]]) => from >= 0 && to <= length && from < to)
            .map(([[from, to], type]) => Decoration.mark({ class: highlightClasses[type] }).range(from, to))

        return Decoration.set(decorations, true)
    }

    const cbsHighlights = ViewPlugin.fromClass(class {
        decorations: DecorationSet

        constructor(view: EditorView) {
            this.decorations = buildHighlights(view)
        }

        update(update: ViewUpdate) {
            if (update.docChanged) this.decorations = buildHighlights(update.view)
        }
    }, {
        decorations: (plugin) => plugin.decorations,
    })

    const completionOptions = AllCBS.map((label) => ({
        label,
        type: label.startsWith('#') || label.startsWith('/') ? 'keyword' : 'variable',
        apply: label.endsWith(':') ? `${label}:` : label.startsWith('#') ? `${label} ` : `${label}}}`,
    }))

    function cbsCompletion(context: CompletionContext) {
        const beforeCursor = context.state.sliceDoc(Math.max(0, context.pos - 100), context.pos)
        const match = /\{\{([#/]?[\w:]*)$/.exec(beforeCursor)
        if (!match) return null

        return {
            from: context.pos - match[1].length,
            options: completionOptions,
            validFor: /^[#/]?[\w:]*$/,
        }
    }

    const editorTheme = EditorView.theme({
        '&': {
            height: '100%',
            backgroundColor: 'transparent',
            color: 'var(--risu-theme-textcolor)',
        },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': {
            overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            lineHeight: '1.625',
        },
        '.cm-content': {
            minHeight: '100%',
            padding: '0.75rem',
            caretColor: 'var(--risu-theme-textcolor)',
        },
        '.cm-line': { padding: '0' },
        '.cm-cursor': { borderLeftColor: 'var(--risu-theme-textcolor)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
            backgroundColor: 'color-mix(in srgb, var(--risu-theme-primary) 30%, transparent)',
        },
        '.cm-panels': {
            backgroundColor: 'var(--risu-theme-bgcolor)',
            color: 'var(--risu-theme-textcolor)',
            borderColor: 'var(--risu-theme-borderc)',
        },
        '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--risu-theme-borderc)' },
        '.cm-search': { padding: '0.5rem' },
        '.cm-search input': {
            backgroundColor: 'var(--risu-theme-bgcolor)',
            color: 'var(--risu-theme-textcolor)',
            border: '1px solid var(--risu-theme-borderc)',
            borderRadius: '0.25rem',
        },
        '.cm-search button': {
            backgroundImage: 'none',
            backgroundColor: 'var(--risu-theme-darkbutton)',
            color: 'var(--risu-theme-textcolor)',
            border: '1px solid var(--risu-theme-borderc)',
            borderRadius: '0.25rem',
        },
        '.cm-tooltip': {
            backgroundColor: 'var(--risu-theme-bgcolor)',
            color: 'var(--risu-theme-textcolor)',
            border: '1px solid var(--risu-theme-borderc)',
        },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
            backgroundColor: 'var(--risu-theme-selected)',
            color: 'var(--risu-theme-textcolor)',
        },
        '.cm-cbs-comment': { color: 'var(--color-syntax-comment)', fontStyle: 'italic' },
        '.cm-cbs-type': { color: 'var(--color-syntax-type)' },
        '.cm-cbs-keyword': { color: 'var(--color-syntax-keyword)' },
        '.cm-cbs-variable': { color: 'var(--color-syntax-variable)' },
        '.cm-cbs-literal': { color: 'var(--color-syntax-literal)' },
        '.cm-cbs-deprecated': {
            color: 'var(--risu-theme-textcolor2)',
            textDecoration: 'line-through',
        },
    })

    onMount(() => {
        editor = new EditorView({
            parent: editorRoot,
            state: EditorState.create({
                doc: value ?? '',
                extensions: [
                    minimalSetup,
                    search(),
                    autocompletion({ override: [cbsCompletion], activateOnTyping: true }),
                    keymap.of([
                        { key: 'Mod-Enter', run: () => { onSave(); return true }, preventDefault: true },
                        { key: 'Mod-h', run: openSearchPanel, preventDefault: true },
                        ...completionKeymap,
                        ...searchKeymap,
                    ]),
                    wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
                    cbsHighlights,
                    editorTheme,
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) value = update.state.doc.toString()
                    }),
                ],
            }),
        })
    })

    $effect(() => {
        if (!editor) return
        const nextValue = value ?? ''
        const currentValue = editor.state.doc.toString()
        if (nextValue === currentValue) return

        editor.dispatch({
            changes: { from: 0, to: currentValue.length, insert: nextValue },
        })
    })

    $effect(() => {
        if (!editor) return
        editor.dispatch({
            effects: wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []),
        })
    })

    onDestroy(() => editor?.destroy())
</script>
