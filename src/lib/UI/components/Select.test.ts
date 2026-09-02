// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SelectHarness from './SelectHarness.test.svelte'

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('Select', () => {
    it('selects an option through the bits-ui listbox', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(SelectHarness, { target }))
        await tick()

        const trigger = target.querySelector<HTMLElement>('[data-slot="select-trigger"]')!
        expect(trigger.textContent).toContain('First')

        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        await tick()
        const options = document.querySelectorAll<HTMLElement>('[role="option"]')
        expect([...options].map(option => option.textContent?.trim())).toEqual(['First', 'Second'])

        options[1].dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        await tick()
        expect(target.querySelector('[data-testid="value"]')?.textContent).toBe('second')
        expect(target.querySelector('[data-testid="changes"]')?.textContent).toBe('1')
    })
})
