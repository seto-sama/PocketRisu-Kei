// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, mount, tick, unmount } from 'svelte'
import Dialog from './Dialog.svelte'
import { overlayLayerMinimum } from 'src/ts/gui/overlayStack'
import OverlayStackHarness from './overlay/OverlayStackHarness.test.svelte'
import OverlaySiblingDialogHarness from './overlay/OverlaySiblingDialogHarness.test.svelte'

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('Dialog close requests', () => {
    it('focuses the dialog content when it has no interactive controls', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Dialog, {
            target,
            props: { open: true, closable: false },
        })
        mounted.push(component)
        await tick()

        expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'))
    })

    it('tabs through regular controls, help triggers, then close', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const title = createRawSnippet(() => ({
            render: () => '<span data-risu-help role="button" tabindex="0" data-testid="title-help">?</span>',
        }))
        const children = createRawSnippet(() => ({
            render: () => `
                <div>
                    <button data-testid="first-control">First</button>
                    <span data-risu-help role="button" tabindex="0" data-testid="body-help">?</span>
                    <input data-testid="second-control" />
                </div>
            `,
        }))
        const footer = createRawSnippet(() => ({
            render: () => '<button data-testid="footer-control">Footer</button>',
        }))
        const component = mount(Dialog, {
            target,
            props: { open: true, closable: true, title, children, footer },
        })
        mounted.push(component)
        await tick()

        const order = [
            'first-control',
            'second-control',
            'footer-control',
            'title-help',
            'body-help',
        ]
        const first = document.querySelector<HTMLElement>('[data-testid="first-control"]')!
        expect(document.activeElement).toBe(first)
        first.focus()
        for (const testId of order.slice(1)) {
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            }))
            expect(document.activeElement).toBe(document.querySelector(`[data-testid="${testId}"]`))
        }
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        }))
        expect(document.activeElement).toBe(document.querySelector('[data-risu-dialog-close]'))
    })

    it('closes with Escape by default when outside click closing is enabled', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onOpenChange = vi.fn()
        const component = mount(Dialog, {
            target,
            props: { open: true, onOpenChange },
        })
        mounted.push(component)
        await tick()

        document.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        )
        await tick()

        expect(onOpenChange).toHaveBeenLastCalledWith(false)
    })

    it('uses the shared dynamic overlay layer', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Dialog, {
            target,
            props: { open: true },
        })
        mounted.push(component)
        await tick()

        const layer = Number(document.querySelector<HTMLElement>('[role="dialog"]')
            ?.style.getPropertyValue('--risu-overlay-z'))
        expect(layer).toBeGreaterThanOrEqual(overlayLayerMinimum)
    })

    it('opens a global sibling dialog above an existing portal overlay', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(OverlaySiblingDialogHarness, { target })
        mounted.push(component)
        await tick()

        const parentLayer = Number(document.querySelector<HTMLElement>('[data-testid="open-sibling-dialog"]')
            ?.closest<HTMLElement>('[data-risu-overlay-layer]')?.dataset.risuOverlayLayer)
        document.querySelector<HTMLButtonElement>('[data-testid="open-sibling-dialog"]')!.click()
        await tick()

        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
        expect(dialog).not.toBeNull()
        expect(Number(dialog?.dataset.risuOverlayLayer)).toBeGreaterThan(parentLayer)
    })

    it('intercepts Escape and the close button without closing the dialog', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onRequestClose = vi.fn()
        const component = mount(Dialog, {
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

    it('places a select opened from a dialog above its parent dialog', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(OverlayStackHarness, { target })
        mounted.push(component)
        await tick()

        document.querySelector<HTMLElement>('[data-slot="select-trigger"]')!.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }),
        )
        await tick()

        const dialogLayer = Number(document.querySelector<HTMLElement>('[role="dialog"]')
            ?.dataset.risuOverlayLayer)
        const selectLayerRoot = document.querySelector<HTMLElement>('[role="listbox"]')
            ?.closest<HTMLElement>('[data-risu-overlay-layer]')
        const selectLayer = Number(selectLayerRoot?.dataset.risuOverlayLayer)
        expect(selectLayer).toBeGreaterThan(dialogLayer)
        expect(selectLayerRoot?.style.position).toBe('fixed')
        expect(selectLayerRoot?.style.width).toBe('0px')
        expect(selectLayerRoot?.style.height).toBe('0px')
        expect(Number(selectLayerRoot?.style.zIndex)).toBe(selectLayer)
    })

    it('does not register a plain portal as an overlay', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(OverlayStackHarness, { target })
        mounted.push(component)
        await tick()

        const plainPortal = document.querySelector<HTMLElement>('[data-testid="plain-portal"]')!
        expect(plainPortal.parentElement).toBe(document.body)
        expect(plainPortal.closest('[data-risu-overlay-layer]')).toBeNull()
    })

    it('places a dropdown menu above its parent dialog', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(OverlayStackHarness, { target })
        mounted.push(component)
        await tick()

        document.querySelector<HTMLButtonElement>('[data-testid="menu-trigger"]')!.click()
        await tick()

        const dialogLayer = Number(document.querySelector<HTMLElement>('[role="dialog"]')
            ?.dataset.risuOverlayLayer)
        const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!
        const menuLayerRoot = menu.closest<HTMLElement>('[data-risu-overlay-layer]')!
        const menuLayer = Number(menuLayerRoot.dataset.risuOverlayLayer)
        expect(menuLayer).toBeGreaterThan(dialogLayer)
        expect(menuLayerRoot.hasAttribute('data-risu-dialog-interactive')).toBe(true)

        document.querySelector<HTMLElement>('[data-slot="dropdown-menu-item"]')!.click()
        await tick()
        expect(document.querySelector('[data-testid="menu-selections"]')?.textContent).toBe('1')
    })
})
