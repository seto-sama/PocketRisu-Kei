// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import ShDialog from './ShDialog.svelte'

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('ShDialog close requests', () => {
    it('intercepts Escape and the close button without closing the dialog', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onRequestClose = vi.fn()
        const component = mount(ShDialog, {
            target,
            props: {
                open: true,
                closeOnEscape: true,
                onRequestClose,
            },
        })
        mounted.push(component)
        await tick()

        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
        dialog.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
        }))
        await tick()

        expect(onRequestClose).toHaveBeenCalledTimes(1)
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()

        document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
        await tick()

        expect(onRequestClose).toHaveBeenCalledTimes(2)
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    })
})
