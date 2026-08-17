// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import ShCombobox from './ShCombobox.svelte'

const mounted: unknown[] = []

function renderCombobox(value = '') {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(ShCombobox, {
        target,
        props: {
            value,
            options: ['SUIT Variable', 'Example Thin'],
        },
    })
    mounted.push(component)
    return target
}

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('ShCombobox', () => {
    it('shows only matching option names below the input', async () => {
        const target = renderCombobox()
        const input = target.querySelector('input')!
        input.focus()
        await tick()

        expect(target.querySelector('[role="listbox"]')).toBeNull()
        expect(document.querySelector('[role="listbox"]')).not.toBeNull()
        expect([...document.querySelectorAll('[role="option"]')].map(option => option.textContent?.trim()))
            .toEqual(['SUIT Variable', 'Example Thin'])

        input.value = 'suit'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()

        expect([...document.querySelectorAll('[role="option"]')].map(option => option.textContent?.trim()))
            .toEqual(['SUIT Variable'])
    })

    it('selects the highlighted suggestion with the keyboard', async () => {
        const target = renderCombobox('suit')
        const input = target.querySelector('input')!
        input.focus()
        await tick()

        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await tick()

        expect(input.value).toBe('SUIT Variable')
        expect(document.querySelector('[role="listbox"]')).toBeNull()
    })

    it('selects a suggestion with a click', async () => {
        const target = renderCombobox()
        const input = target.querySelector('input')!
        input.focus()
        await tick()

        const options = document.querySelectorAll<HTMLButtonElement>('[role="option"]')
        options[1].click()
        await tick()

        expect(input.value).toBe('Example Thin')
        expect(document.querySelector('[role="listbox"]')).toBeNull()
    })

    it('anchors the suggestion list to the input width', async () => {
        const target = renderCombobox()
        const input = target.querySelector('input')!
        input.getBoundingClientRect = () => new DOMRect(24, 40, 280, 40)
        input.focus()
        await tick()
        await tick()

        const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!
        expect(listbox.style.left).toBe('24px')
        expect(listbox.style.top).toBe('82px')
        expect(listbox.style.width).toBe('280px')
    })
})
