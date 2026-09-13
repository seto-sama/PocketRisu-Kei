// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import OverlayPortalEscapeHarness from './OverlayPortalEscapeHarness.test.svelte'
import { requestEscapeAction } from 'src/ts/gui/escapeKey'

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('OverlayPortal Escape handling', () => {
    it('closes from Escape even when an inner control stops bubbling', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onEscape = vi.fn()
        const component = mount(OverlayPortalEscapeHarness, {
            target,
            props: { onEscape },
        })
        mounted.push(component)
        await tick()

        document.querySelector<HTMLInputElement>('[data-testid="overlay-input"]')!.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        )

        expect(onEscape).toHaveBeenCalledTimes(1)
    })

    it('reports mobile Back Escape as handled', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onEscape = vi.fn()
        const component = mount(OverlayPortalEscapeHarness, {
            target,
            props: { onEscape },
        })
        mounted.push(component)
        await tick()
        document.querySelector<HTMLInputElement>('[data-testid="overlay-input"]')!.focus()

        expect(requestEscapeAction()).toBe(true)
        expect(onEscape).toHaveBeenCalledTimes(1)
    })

    it('closes exactly one overlay layer per Escape', async () => {
        const onOuterClose = vi.fn()
        const onInnerClose = vi.fn()
        const component = mount(OverlayPortalEscapeHarness, {
            target: document.body,
            props: { onOuterClose, onInnerClose },
        })
        mounted.push(component)
        await tick()

        expect(requestEscapeAction()).toBe(true)
        await tick()
        expect(onInnerClose).toHaveBeenCalledOnce()
        expect(onOuterClose).not.toHaveBeenCalled()

        expect(requestEscapeAction()).toBe(true)
        await tick()
        expect(onInnerClose).toHaveBeenCalledOnce()
        expect(onOuterClose).toHaveBeenCalledOnce()
    })
})
