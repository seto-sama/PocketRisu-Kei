// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import AlertDialog from './AlertDialog.svelte'

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('AlertDialog keyboard actions', () => {
    it('confirms with Enter and cancels with Escape', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onConfirm = vi.fn()
        const onCancel = vi.fn()
        const component = mount(AlertDialog, {
            target,
            props: {
                open: true,
                onConfirm,
                onCancel,
            },
        })
        mounted.push(component)
        await tick()

        const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!
        dialog.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
        }))
        expect(onConfirm).toHaveBeenCalledTimes(1)
        expect(onCancel).not.toHaveBeenCalled()

        dialog.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
        }))
        await tick()
        expect(onCancel).toHaveBeenCalledTimes(1)
    })

    it('does not confirm during IME composition', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onConfirm = vi.fn()
        const component = mount(AlertDialog, {
            target,
            props: { open: true, onConfirm },
        })
        mounted.push(component)
        await tick()

        document.querySelector<HTMLElement>('[role="alertdialog"]')!.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                isComposing: true,
                bubbles: true,
                cancelable: true,
            }),
        )
        expect(onConfirm).not.toHaveBeenCalled()
    })
})
