// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { mount, tick, unmount } from 'svelte'
import CBSCodeEditor from './CBSCodeEditor.svelte'

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('CBSCodeEditor', () => {
    it('completes CBS names after opening braces', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(CBSCodeEditor, {
            target,
            props: { value: '{{ch', wordWrap: true },
        })
        mounted.push(component)
        await tick()

        const content = target.querySelector<HTMLElement>('.cm-content')!
        const editor = EditorView.findFromDOM(content)!
        editor.dispatch({ selection: { anchor: editor.state.doc.length } })
        content.focus()
        startCompletion(editor)
        await new Promise(resolve => setTimeout(resolve, 150))

        expect(completionStatus(editor.state)).toBe('active')
        expect(currentCompletions(editor.state).map(option => option.label)).toContain('char')

        content.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
        }))
        expect(editor.state.doc.toString()).toBe('{{char}}')
    })

    it('renders CBS highlighting and opens replace search with Ctrl+H', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(CBSCodeEditor, {
            target,
            props: { value: '{{char}}', wordWrap: true },
        })
        mounted.push(component)
        await tick()

        const content = target.querySelector<HTMLElement>('.cm-content')!
        expect(target.querySelector('.cm-cbs-type')?.textContent).toBe('{{char}}')

        content.focus()
        content.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'h',
            code: 'KeyH',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        }))
        await tick()

        expect(target.querySelector('input[name="search"]')).not.toBeNull()
        expect(target.querySelector('input[name="replace"]')).not.toBeNull()
    })
})
