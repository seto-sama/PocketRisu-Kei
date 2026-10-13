import { afterEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import Textarea from './Textarea.svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'

vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { DBState: { db: {} }, selectedCharID: writable(-1), showPopupEditor: vi.fn() }
})
vi.mock('src/ts/gui/guisize', async () => {
    const { writable } = await import('svelte/store')
    return { textAreaSize: writable(0), textAreaTextSize: writable(0) }
})
vi.mock('src/ts/alert', () => ({ alertConfirm: vi.fn() }))
vi.mock('src/ts/storage/autoStorage', () => ({ forageStorage: { createAuth: async () => 'test-token' } }))

const mounted: unknown[] = []
const longHair = { name: 'long hair', category: 0, count: 100, description: '긴 머리, 장발' }

async function render(value = '') {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const oncommit = vi.fn()
    mounted.push(mount(Textarea, {
        target,
        props: { value, imageTags: true, commitMode: 'input', oncommit, actionBar: false },
    }))
    await tick()
    return { input: target.querySelector('textarea')!, oncommit }
}

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    vi.unstubAllGlobals()
    document.body.replaceChildren()
    Object.assign(DBState.db, { characters: [], modules: [] })
    selectedCharID.set(-1)
})

it('shows Korean descriptions and commits the completed prefix while preserving following prompt text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tags: [longHair] }))))
    const { input, oncommit } = await render('1girl, (장발 out:1.2), blue eyes')
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 360, 80))
    input.setSelectionRange(10, 10)
    input.focus()
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('긴 머리, 장발'))
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector<HTMLElement>('.risu-completion-list')?.style.getPropertyValue('--risu-completion-width')).toBe('360px')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await tick()
    expect(input.value).toBe('1girl, (long hair, out:1.2), blue eyes')
    expect(oncommit).toHaveBeenLastCalledWith(input.value)
    expect(input.selectionStart).toBe(input.value.indexOf('out'))
    expect(document.querySelector('[role="listbox"]')).toBeNull()
})

it('offers current-character bundles after the marker and inserts a name without downloading or expanding tags', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    Object.assign(DBState.db, {
        modules: [],
        characters: [{ name: 'Hatsune Miku', globalLore: [{
            comment: 'lb-xnai.lb.extra', mode: 'normal', alwaysActive: false,
            content: '### Miku\nboy, black hair',
        }] }],
    })
    selectedCharID.set(0)
    const { input } = await render('###')
    input.focus()
    input.setSelectionRange(3, 3)
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('### Miku'))
    expect(document.querySelector('.risu-completion-detail')?.textContent).toBe('Hatsune Miku')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await tick()
    expect(input.value).toBe('### Miku, ')
    expect(fetch).not.toHaveBeenCalled()
})

it('keeps focus when using the list, dismisses with Escape, navigates and accepts a pointer selection', async () => {
    const veryLongHair = { ...longHair, name: 'very long hair' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tags: [longHair, veryLongHair] }))))
    const { input } = await render('장발')
    input.setSelectionRange(2, 2)
    input.focus()
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2))
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    list.dispatchEvent(mouseDown)
    expect(mouseDown.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(document.querySelector('[role="listbox"]')).toBe(list)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('장발')
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await tick()
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('very long hair')
    const option = document.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')!
    option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    option.click()
    await tick()
    expect(input.value).toBe('very long hair, ')
    expect(document.activeElement).toBe(input)
})

it('searches the active Korean syllable without accepting the Enter that confirms composition', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ tags: [longHair] })))
    vi.stubGlobal('fetch', fetch)
    const { input } = await render()
    input.focus()
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.value = '1.3::장발'
    input.setSelectionRange(6, 7)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    expect(new URL(fetch.mock.calls[0][0] as string, location.href).searchParams.get('q')).toBe('장발')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })
    input.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    expect(input.value).toBe('1.3::장발')

    input.setSelectionRange(7, 7)
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await tick()
    expect(input.value).toBe('1.3::long hair, ')
})

it('opens only after typing and discards a pending search when the user clicks to move the cursor', async () => {
    let resolveResponse: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve }))
    vi.stubGlobal('fetch', fetch)
    const { input } = await render('장발')
    input.focus()
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    input.setSelectionRange(2, 2)
    input.click()
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(fetch).not.toHaveBeenCalled()

    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    resolveResponse!(new Response(JSON.stringify({ tags: [longHair] })))
    await tick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(input.value).toBe('장발')
})

it('never opens an empty loading list and does not repeat an unchanged query', async () => {
    let resolveResponse: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve }))
    vi.stubGlobal('fetch', fetch)
    const { input } = await render('unmatched phrase')
    input.setSelectionRange(input.value.length, input.value.length)
    input.focus()
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('Downloading'))
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="listbox"]')).toBeNull()

    resolveResponse!(new Response(JSON.stringify({ tags: [] })))
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull())
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(fetch).toHaveBeenCalledOnce()
    expect(input.getAttribute('aria-expanded')).toBe('false')
})
