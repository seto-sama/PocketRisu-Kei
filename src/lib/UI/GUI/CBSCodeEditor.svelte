<div class="risu-field-border h-full min-h-0 w-full overflow-hidden rounded-md bg-bgcolor text-textcolor" bind:this={editorRoot}></div>

<script lang="ts">
    import { autocompletion, closeCompletion, completionKeymap, completionStatus, type CompletionContext } from '@codemirror/autocomplete'
    import {
        SearchQuery,
        closeSearchPanel,
        findNext,
        findPrevious,
        getSearchQuery,
        openSearchPanel,
        replaceAll,
        replaceNext,
        search,
        searchKeymap,
        searchPanelOpen,
        setSearchQuery,
    } from '@codemirror/search'
    import { Compartment, EditorState } from '@codemirror/state'
    import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type Panel, type ViewUpdate } from '@codemirror/view'
    import { minimalSetup } from 'codemirror'
    import {
        CaseSensitiveIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        ChevronUpIcon,
        RegexIcon,
        ReplaceAllIcon,
        ReplaceIcon,
        WholeWordIcon,
        XIcon,
    } from '@lucide/svelte'
    import { createRawSnippet, mount, onDestroy, onMount, unmount, type Component } from 'svelte'
    import IconButton from './IconButton.svelte'
    import { AllCBS } from 'src/ts/cbs'
    import { getCBSHighlightRanges, type HighlightType } from 'src/ts/gui/highlight'
    import { language } from 'src/lang'

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
        cbsnest0: 'cm-cbs-depth-0',
        cbsnest1: 'cm-cbs-depth-1',
        cbsnest2: 'cm-cbs-depth-2',
        cbsnest3: 'cm-cbs-depth-3',
        cbsnest4: 'cm-cbs-depth-4',
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

    function createSearchPanel(view: EditorView): Panel {
        const dom = document.createElement('div')
        dom.className = 'risu-search-panel'

        const findInput = document.createElement('input')
        const replaceInput = document.createElement('input')
        const matchCount = document.createElement('span')
        matchCount.className = 'risu-search-count'
        const findField = document.createElement('div')
        const replaceRow = document.createElement('div')
        const mountedButtons: Record<string, unknown>[] = []
        let replaceExpanded = true

        const iconButton = (Icon: Component, label: string, action: () => void, className = '') => {
            const host = document.createElement('span')
            host.className = 'risu-search-button-host'
            const children = createRawSnippet(() => ({
                render: () => '<span></span>',
                setup: (target) => {
                    const icon = mount(Icon, {
                        target,
                        props: { size: 16, strokeWidth: 1.75, 'aria-hidden': true },
                    })
                    return () => { void unmount(icon) }
                },
            }))
            mountedButtons.push(mount(IconButton, {
                target: host,
                props: {
                    size: 'sm',
                    title: label,
                    'aria-label': label,
                    onclick: action,
                    className: `risu-search-action ${className}`.trim(),
                    children,
                },
            }))
            return {
                host,
                button: host.querySelector<HTMLButtonElement>('button')!,
            }
        }

        const commitQuery = () => {
            const current = getSearchQuery(view.state)
            view.dispatch({
                effects: setSearchQuery.of(new SearchQuery({
                    search: findInput.value,
                    replace: replaceInput.value,
                    caseSensitive: current.caseSensitive,
                    regexp: current.regexp,
                    wholeWord: current.wholeWord,
                    literal: current.literal,
                })),
            })
        }

        const toggleQueryOption = (option: 'caseSensitive' | 'wholeWord' | 'regexp') => {
            const current = getSearchQuery(view.state)
            view.dispatch({
                effects: setSearchQuery.of(new SearchQuery({
                    search: current.search,
                    replace: current.replace,
                    caseSensitive: option === 'caseSensitive' ? !current.caseSensitive : current.caseSensitive,
                    regexp: option === 'regexp' ? !current.regexp : current.regexp,
                    wholeWord: option === 'wholeWord' ? !current.wholeWord : current.wholeWord,
                    literal: current.literal,
                })),
            })
        }

        const caseControl = iconButton(CaseSensitiveIcon, language.popupEditorMatchCase, () => toggleQueryOption('caseSensitive'))
        const wordControl = iconButton(WholeWordIcon, language.popupEditorWholeWord, () => toggleQueryOption('wholeWord'))
        const regexControl = iconButton(RegexIcon, language.popupEditorUseRegex, () => toggleQueryOption('regexp'))

        const syncPanel = () => {
            const query = getSearchQuery(view.state)
            if (findInput.value !== query.search) findInput.value = query.search
            if (replaceInput.value !== query.replace) replaceInput.value = query.replace
            caseControl.button.setAttribute('aria-pressed', String(query.caseSensitive))
            wordControl.button.setAttribute('aria-pressed', String(query.wholeWord))
            regexControl.button.setAttribute('aria-pressed', String(query.regexp))

            if (!query.search || !query.valid) {
                matchCount.textContent = ''
                return
            }

            const matches: { from: number, to: number }[] = []
            const cursor = query.getCursor(view.state)
            for (let next = cursor.next(); !next.done; next = cursor.next()) matches.push(next.value)
            const selection = view.state.selection.main
            let currentIndex = matches.findIndex(match => match.from === selection.from && match.to === selection.to)
            if (currentIndex < 0) currentIndex = matches.findIndex(match => match.from >= selection.from)
            if (currentIndex < 0 && matches.length > 0) currentIndex = 0
            matchCount.textContent = language.popupEditorSearchCount(currentIndex + 1, matches.length)
        }

        const setReplaceExpanded = (expanded: boolean) => {
            replaceExpanded = expanded
            replaceRow.hidden = !expanded
            replaceRow.style.display = expanded ? 'contents' : 'none'
            toggleControl.button.style.gridRow = expanded ? '1 / span 2' : '1'
            toggleControl.button.setAttribute('aria-expanded', String(expanded))
        }

        const toggleControl = iconButton(
            ChevronRightIcon,
            language.popupEditorToggleReplace,
            () => setReplaceExpanded(!replaceExpanded),
            'risu-search-expand',
        )

        findInput.className = 'risu-search-input risu-search-find-input'
        findInput.name = 'search'
        findInput.placeholder = language.search
        findInput.setAttribute('aria-label', language.search)
        findInput.setAttribute('main-field', 'true')
        findInput.oninput = commitQuery
        findInput.onkeydown = (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            ;(event.shiftKey ? findPrevious : findNext)(view)
        }

        findField.className = 'risu-search-field'
        findField.append(findInput, caseControl.host, wordControl.host, regexControl.host)

        replaceInput.className = 'risu-search-input'
        replaceInput.name = 'replace'
        replaceInput.placeholder = language.popupEditorReplace
        replaceInput.setAttribute('aria-label', language.popupEditorReplace)
        replaceInput.oninput = commitQuery
        replaceInput.onkeydown = (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            replaceNext(view)
        }

        const findRow = document.createElement('div')
        findRow.className = 'risu-search-row'
        const findActions = document.createElement('div')
        findActions.className = 'risu-search-actions'
        findActions.append(
            iconButton(ChevronUpIcon, language.popupEditorPreviousMatch, () => { findPrevious(view) }).host,
            iconButton(ChevronDownIcon, language.popupEditorNextMatch, () => { findNext(view) }).host,
            iconButton(XIcon, language.close, () => { closeSearchPanel(view) }).host,
        )
        findRow.append(
            toggleControl.host,
            findField,
            matchCount,
            findActions,
        )

        replaceRow.className = 'risu-search-row risu-search-replace-row'
        const replaceActions = document.createElement('div')
        replaceActions.className = 'risu-search-actions risu-search-replace-actions'
        replaceActions.append(
            iconButton(ReplaceIcon, language.popupEditorReplace, () => { replaceNext(view) }).host,
            iconButton(ReplaceAllIcon, language.popupEditorReplaceAll, () => { replaceAll(view) }).host,
        )
        replaceRow.append(
            replaceInput,
            replaceActions,
        )

        dom.append(findRow, replaceRow)
        setReplaceExpanded(true)
        syncPanel()

        return {
            dom,
            top: true,
            mount: () => findInput.select(),
            update: syncPanel,
            destroy: () => {
                for (const button of mountedButtons) void unmount(button)
            },
        }
    }

    const editorTheme = EditorView.theme({
        '&': {
            height: '100%',
            position: 'relative',
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
        '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
            background: 'color-mix(in srgb, var(--risu-theme-primary) 12%, transparent) !important',
        },
        '.cm-line::selection, .cm-line *::selection': {
            backgroundColor: 'transparent !important',
            color: 'inherit !important',
        },
        '.cm-searchMatch': {
            backgroundColor: 'color-mix(in srgb, var(--risu-theme-primary) 16%, transparent)',
            outline: 'none',
        },
        '.cm-searchMatch-selected': {
            backgroundColor: 'color-mix(in srgb, var(--risu-theme-primary) 16%, transparent)',
            outline: '1px solid var(--risu-theme-primary)',
            borderRadius: '2px',
        },
        '.cm-panels': {
            backgroundColor: 'var(--risu-theme-bgcolor)',
            color: 'var(--risu-theme-textcolor)',
            borderColor: 'var(--risu-theme-borderc)',
        },
        '.cm-panels.cm-panels-top': {
            position: 'absolute',
            top: '0.375rem !important',
            right: '0.375rem',
            left: 'auto',
            zIndex: '20',
            width: 'min(22rem, calc(100% - 0.75rem))',
            overflow: 'hidden',
            border: '1px solid var(--risu-theme-darkborderc)',
            borderRadius: '0.375rem',
            boxShadow: '0 8px 24px var(--risu-black-50)',
        },
        '.cm-panel.risu-search-panel': {
            position: 'relative',
            display: 'grid',
            gridTemplateColumns: '1.125rem minmax(6rem, 1fr) minmax(2.25rem, auto) auto',
            gridAutoRows: '1.625rem',
            alignItems: 'center',
            columnGap: '0.125rem',
            rowGap: '0.125rem',
            padding: '0.25rem',
            backgroundColor: 'var(--risu-theme-darkbg)',
        },
        '.risu-search-row': {
            display: 'contents',
        },
        '.risu-search-button-host': {
            display: 'contents',
        },
        '.risu-search-actions': {
            display: 'flex',
            alignItems: 'center',
            gap: '0',
        },
        '.risu-search-expand': {
            alignSelf: 'stretch',
            width: '1.125rem',
            height: 'auto',
            padding: '0',
            border: '0',
            backgroundColor: 'transparent',
            color: 'var(--risu-theme-textcolor)',
            cursor: 'pointer',
        },
        '.risu-search-expand svg': {
            transition: 'transform 120ms ease',
        },
        '.risu-search-expand[aria-expanded="true"] svg': {
            transform: 'rotate(90deg)',
        },
        '.risu-search-field': {
            display: 'flex',
            minWidth: '0',
            height: '1.625rem',
            alignItems: 'center',
            paddingRight: '0.125rem',
            overflow: 'hidden',
            backgroundColor: 'var(--risu-theme-bgcolor)',
            border: '1px solid var(--risu-theme-darkborderc)',
            borderRadius: '0.25rem',
        },
        '.risu-search-input': {
            boxSizing: 'border-box',
            width: '100%',
            minWidth: '0',
            height: '1.625rem',
            padding: '0 0.375rem',
            backgroundColor: 'var(--risu-theme-bgcolor)',
            color: 'var(--risu-theme-textcolor)',
            border: '1px solid var(--risu-theme-darkborderc)',
            borderRadius: '0.25rem',
        },
        '.risu-search-find-input': {
            flex: '1 1 auto',
            border: '0',
            borderRadius: '0',
            backgroundColor: 'transparent',
            outline: 'none',
        },
        '.risu-search-action': {
            backgroundColor: 'transparent',
            color: 'var(--risu-theme-textcolor) !important',
            cursor: 'pointer',
        },
        '.risu-search-action:hover, .risu-search-action[aria-pressed="true"]': {
            backgroundColor: 'var(--risu-theme-selected)',
            color: 'var(--risu-theme-textcolor)',
        },
        '.risu-search-replace-row > .risu-search-input': { gridColumn: '2' },
        '.risu-search-replace-actions': { gridColumn: '3 / 5' },
        '.risu-search-count': {
            color: 'var(--risu-theme-textcolor2)',
            fontSize: '0.6875rem',
            whiteSpace: 'nowrap',
            textAlign: 'center',
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
        '.cm-cbs-depth-0': { color: 'var(--color-syntax-depth-0)' },
        '.cm-cbs-depth-1': { color: 'var(--color-syntax-depth-1)' },
        '.cm-cbs-depth-2': { color: 'var(--color-syntax-depth-2)' },
        '.cm-cbs-depth-3': { color: 'var(--color-syntax-depth-3)' },
        '.cm-cbs-depth-4': { color: 'var(--color-syntax-depth-4)' },
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
                    search({ createPanel: createSearchPanel, top: true }),
                    autocompletion({ override: [cbsCompletion], activateOnTyping: true }),
                    keymap.of([
                        { key: 'Mod-Enter', run: () => { onSave(); return true }, preventDefault: true },
                        { key: 'Mod-h', run: openSearchPanel, preventDefault: true },
                        {
                            key: 'Escape',
                            run: (view) => {
                                if (searchPanelOpen(view.state)) return closeSearchPanel(view)
                                if (completionStatus(view.state)) return closeCompletion(view)
                                return false
                            },
                            stopPropagation: true,
                        },
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
