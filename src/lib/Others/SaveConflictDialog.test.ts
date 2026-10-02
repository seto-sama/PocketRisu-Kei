// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SaveConflictDialog from './SaveConflictDialog.svelte'
import { language } from 'src/lang'
import { saveConflictDialog, type SaveConflictDialogState } from 'src/ts/storage/saveConflict'
import type { MergeConflict } from 'src/ts/storage/patchRebase'

const mounted: Array<{ component: ReturnType<typeof mount>, target: HTMLElement }> = []

async function settle() {
    await tick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await tick()
}

function showDialog(items: MergeConflict[], complete = vi.fn(), source?: unknown) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(SaveConflictDialog, { target })
    mounted.push({ component, target })
    const state: SaveConflictDialogState = {
        title: language.saveConflict.title,
        items,
        complete,
        source,
    }
    saveConflictDialog.set(state)
    return complete
}

function buttonsWithText(text: string) {
    return [...document.body.querySelectorAll('button')]
        .filter(button => button.textContent?.trim() === text)
}

afterEach(() => {
    for (const { component, target } of mounted.splice(0)) {
        unmount(component)
        target.remove()
    }
    saveConflictDialog.set(null)
    document.body.innerHTML = ''
})

describe('SaveConflictDialog', () => {
    it('keeps save disabled until every conflict is selected and returns each side choice', async () => {
        const complete = showDialog([
            { path: ['name'], base: 'Before', local: 'Mine', server: 'Theirs' },
            { path: ['description'], base: 'Before', local: 'My description', server: 'Their description' },
        ])
        await settle()

        const save = buttonsWithText(language.saveConflict.save)[0]
        expect(save?.disabled).toBe(true)

        const serverOptions = buttonsWithText(language.saveConflict.useServer)
        const localOptions = buttonsWithText(language.saveConflict.useLocal)
        serverOptions[0].click()
        localOptions[1].click()
        await tick()

        expect(save.disabled).toBe(false)
        save.click()
        expect(complete).toHaveBeenCalledWith(['server', 'local'])
    })

    it('distinguishes deletion from an empty string and renders HTML-like text as text', async () => {
        const unsafeText = '<img src=x onerror=alert(1)>'
        showDialog([
            { path: ['description'], base: 'Before', local: '', server: undefined },
            { path: ['name'], base: 'Before', local: unsafeText, server: 'Plain text' },
        ])
        await settle()

        expect(document.body.textContent).toContain(language.saveConflict.deleted)
        expect(document.body.textContent).toContain(language.saveConflict.empty)
        expect(document.body.textContent).toContain(unsafeText)
        expect(document.body.querySelector('img')).toBeNull()
    })

    it('shows one context line and expands hidden context without changing the selected version', async () => {
        const server = ['Hidden start', 'Earlier context', 'Context before', 'Server change', 'Context after', 'Later context', 'Hidden end']
        const local = [...server]
        local[3] = 'Local change'
        const complete = showDialog([
            { path: ['note'], base: 'Before', local: local.join('\n'), server: server.join('\n') },
        ])
        await settle()
        await vi.waitFor(() => expect(document.body.textContent).toContain('Server change'))

        expect(document.body.textContent).toContain('Context before')
        expect(document.body.textContent).toContain('Context after')
        expect(document.body.textContent).not.toContain('Earlier context')
        expect(document.body.textContent).not.toContain('Later context')

        buttonsWithText(language.saveConflict.useLocal)[0].click()
        const expand = document.body.querySelector<HTMLButtonElement>(`button[title="${language.promptDiff.expandHiddenLines}"]`)!
        expand.click()
        await tick()

        expect(document.body.textContent).toContain('Hidden start')
        expect(document.body.textContent).toContain('Earlier context')
        expect(document.body.textContent).not.toContain('Later context')
        buttonsWithText(language.saveConflict.save)[0].click()
        expect(complete).toHaveBeenCalledWith(['local'])
    })

    it('uses translated field names and keeps message names and roles outside the compared body', async () => {
        const source = { message: [{ chatId: 'message', name: 'Speaker', role: 'char', data: 'My message' }] }
        showDialog([
            { path: ['note'], base: 'Before', local: 'My note', server: 'Server note' },
            { path: ['savedToggleValues', 'toggle_prompt'], base: 'A', local: 'B', server: 'C' },
            { path: ['description'], base: 'Before', local: 'My description', server: 'Server description' },
            { path: ['message', { key: 'chatId', value: 'message' }], base: {},
                local: source.message[0], server: { ...source.message[0], data: 'Server message', disabled: true } },
        ], vi.fn(), source)
        await settle()
        await vi.waitFor(() => expect(document.body.textContent).toContain('Server message'))

        expect(document.body.textContent).toContain(language.authorNote)
        expect(document.body.textContent).toContain(`${language.toggleBindingLabel} › ${language.prompt}`)
        expect(document.body.textContent).toContain(language.description)
        expect(document.body.textContent).toContain('Speaker')
        expect(document.body.textContent).toContain(language.character)
        expect(document.body.textContent).toContain(language.disabled)
        expect(document.body.textContent).not.toContain(`${language.saveConflict.data}:`)
        expect(document.body.textContent).not.toContain('"role"')
        expect(document.body.textContent).not.toContain('"chatId"')
    })
})
