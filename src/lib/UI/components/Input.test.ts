// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import NumberInput from './NumberInput.svelte'
import Input from './Input.svelte'

const mounted: unknown[] = []

function target() {
    const node = document.createElement('div')
    document.body.appendChild(node)
    return node
}

afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('buffered inputs', () => {
    it('keeps intermediate number text local and commits once on blur', async () => {
        const onCommit = vi.fn()
        const root = target()
        mounted.push(mount(NumberInput, {
            target: root,
            props: { value: 512, onCommit },
        }))
        await tick()

        const input = root.querySelector<HTMLInputElement>('input')!
        input.focus()
        for (const value of ['1', '10', '102', '1024']) {
            input.value = value
            input.dispatchEvent(new Event('input', { bubbles: true }))
        }

        expect(input.value).toBe('1024')
        expect(onCommit).not.toHaveBeenCalled()

        input.blur()
        await tick()
        expect(onCommit).toHaveBeenCalledTimes(1)
        expect(onCommit).toHaveBeenCalledWith(1024)
    })

    it('commits an empty optional number as undefined', async () => {
        const onCommit = vi.fn()
        const root = target()
        mounted.push(mount(NumberInput, {
            target: root,
            props: { value: 42, allowEmpty: true, commitMode: 'input', onCommit },
        }))
        await tick()

        const input = root.querySelector<HTMLInputElement>('input')!
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()

        expect(input.value).toBe('')
        expect(onCommit).toHaveBeenCalledOnce()
        expect(onCommit).toHaveBeenCalledWith(undefined)
    })

    it('buffers persisted text fields until blur', async () => {
        const oncommit = vi.fn()
        const root = target()
        mounted.push(mount(Input, {
            target: root,
            props: { value: 'old', commitMode: 'blur', oncommit },
        }))
        await tick()

        const input = root.querySelector<HTMLInputElement>('input')!
        input.focus()
        input.value = 'new value'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        expect(oncommit).not.toHaveBeenCalled()

        input.blur()
        await tick()
        expect(oncommit).toHaveBeenCalledOnce()
        expect(oncommit).toHaveBeenCalledWith('new value')
    })

})
