// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import BackupNoteEditor from './BackupNoteEditor.svelte'

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('BackupNoteEditor', () => {
    it('renders as a portal dialog and submits the edited note', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onSave = vi.fn().mockResolvedValue(undefined)
        const component = mount(BackupNoteEditor, {
            target,
            props: { open: true, value: 'Before', onSave },
        })
        mounted.push(component)
        await tick()

        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
        const input = dialog?.querySelector<HTMLInputElement>('input')
        expect(dialog?.parentElement).toBe(document.body)
        expect(input?.value).toBe('Before')

        input!.value = 'After'
        input!.dispatchEvent(new InputEvent('input', { bubbles: true }))
        await tick()
        const buttons = dialog!.querySelectorAll<HTMLButtonElement>('button')
        buttons[buttons.length - 1].click()
        await tick()

        expect(onSave).toHaveBeenCalledWith('After')
    })
})
