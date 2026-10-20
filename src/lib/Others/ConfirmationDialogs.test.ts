import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import ConfirmationDialogs from './ConfirmationDialogs.svelte'
import { alertConfirm, alertConfirmMulti, alertTOS, confirmationDialogs, risuTosAccepted } from 'src/ts/alert'
import { language } from 'src/lang'

vi.mock('src/ts/util', () => ({ sleep: vi.fn() }))
vi.mock('src/ts/storage/database.svelte', () => ({ pocketKeiVer: 'test' }))
vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { alertStore: writable({ type: 'none', msg: '' }), togglePresetsOpenStore: writable(false) }
})
vi.mock('src/ts/log', () => ({ addLog: vi.fn() }))
vi.mock('src/ts/log-capture', () => ({ nativeConsoleError: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ openURL: vi.fn() }))

let component: ReturnType<typeof mount>

beforeEach(async () => {
    localStorage.clear()
    risuTosAccepted.set(false)
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(ConfirmationDialogs, { target })
    await tick()
})

afterEach(async () => {
    for (const dialog of get(confirmationDialogs)) dialog.complete(false)
    await tick()
    await unmount(component)
    document.body.replaceChildren()
})

function dialogs() {
    return [...document.querySelectorAll<HTMLElement>('[role="alertdialog"][data-state="open"]')]
}

async function key(key: string, repeat = false) {
    dialogs().at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, bubbles: true, cancelable: true }))
    await tick()
}

async function choose(label: string) {
    const button = [...dialogs().at(-1)!.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === label)
    expect(button).toBeDefined()
    button!.click()
    await tick()
}

it('gives each concurrent confirmation its own result and consumes one Enter per window', async () => {
    const firstResult = vi.fn()
    const first = alertConfirm('First').then(firstResult)
    const second = alertConfirm('Second')
    await tick()
    expect(dialogs()).toHaveLength(2)

    await key('Enter')
    await expect(second).resolves.toBe(true)
    expect(firstResult).not.toHaveBeenCalled()
    expect(dialogs()).toHaveLength(1)
    expect(dialogs()[0].textContent).toContain('First')

    await key('Enter', true)
    expect(firstResult).not.toHaveBeenCalled()
    await key('Escape')
    await first
    expect(firstResult).toHaveBeenCalledExactlyOnceWith(false)
    expect(dialogs()).toHaveLength(0)
})

it('keeps multi-choice results independent from a confirmation opened above it', async () => {
    const result = alertConfirmMulti('Select action', ['Keep', 'Replace'])
    const confirmation = alertConfirm('Continue?')
    await tick()
    await choose(language.no)
    await expect(confirmation).resolves.toBe(false)
    expect(dialogs()).toHaveLength(1)
    await choose('Replace')
    await expect(result).resolves.toBe(1)
})

it('uses the same isolated confirmation flow for terms and saves only its own acceptance', async () => {
    localStorage.setItem('risuTosRevision', 'old-revision')
    const terms = alertTOS()
    const confirmation = alertConfirm('Unrelated confirmation')
    await tick()
    await key('Enter')
    await expect(confirmation).resolves.toBe(true)
    expect(get(risuTosAccepted)).toBe(false)
    expect(localStorage.getItem('risuTosRevision')).toBe('old-revision')
    expect(dialogs()).toHaveLength(1)

    await choose(language.risuTosDecline)
    await expect(terms).resolves.toBe(false)
    const acceptedTerms = alertTOS()
    await tick()
    await key('Enter')
    await expect(acceptedTerms).resolves.toBe(true)
    expect(localStorage.getItem('risuTosRevision')).toBe('2026-04-11')
    expect(get(risuTosAccepted)).toBe(true)
    await expect(alertTOS()).resolves.toBe(true)
    expect(dialogs()).toHaveLength(0)
})
