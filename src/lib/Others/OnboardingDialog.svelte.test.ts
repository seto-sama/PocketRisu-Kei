import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import type { character, Chat } from 'src/ts/storage/database.svelte'

const mocks = vi.hoisted(() => ({ applyOnboardingAnswers: vi.fn(async () => true) }))

vi.mock('src/ts/onboarding', async (importOriginal) => ({
    ...await importOriginal<typeof import('src/ts/onboarding')>(),
    applyOnboardingAnswers: mocks.applyOnboardingAnswers,
}))
vi.mock('src/ts/stores.svelte', () => ({ invalidateDisplay: vi.fn() }))
vi.mock('src/ts/process/triggerOrigin', () => ({}))
vi.mock('src/ts/parser/chatVar.svelte', () => ({
    getChatVarOf: (chat: Chat, key: string) => String(chat.scriptstate?.[`$${key}`] ?? ''),
    setChatVarOf: vi.fn(),
}))
vi.mock('src/ts/parser/parser.svelte', () => ({ parseOnboardingHTML: async (html: string) => html }))
vi.mock('src/ts/alert', () => ({ alertError: vi.fn() }))

import OnboardingDialog from './OnboardingDialog.svelte'

let component: ReturnType<typeof mount> | undefined

beforeEach(() => {
    mocks.applyOnboardingAnswers.mockClear()
})

afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.replaceChildren()
})

function button(label: string) {
    return Array.from(document.body.querySelectorAll('button')).find((el) => el.textContent?.trim() === label)!
}

function setup(onboarding: object, scriptstate?: Chat['scriptstate']) {
    const opened: Chat = { id: 'opened', message: [], note: '', name: '', localLore: [], ...(scriptstate && { scriptstate }) }
    const char = { chaId: 'char', name: 'Char', chats: [opened], onboarding: { enabled: true, ...onboarding } } as unknown as character
    return { opened, char }
}

it('requires answers before writing them to the chat it was opened for', async () => {
    const { opened, char } = setup({
        mode: 'form',
        questions: [{ id: 'q', title: 'Route', type: 'single', varName: 'route', required: true, options: [{ label: 'A', value: 'a' }] }],
    })
    const props = $state({ open: true, character: char, chat: opened as Chat | undefined })
    component = mount(OnboardingDialog, { target: document.body, props })
    await tick()

    button('Done').click()
    await tick()
    expect(mocks.applyOnboardingAnswers).not.toHaveBeenCalled()

    props.chat = { ...opened, id: 'selected-later' }
    flushSync()
    ;(document.body.querySelector('[role="radio"]') as HTMLElement).click()
    await tick()
    button('Done').click()
    await vi.waitFor(() => expect(mocks.applyOnboardingAnswers).toHaveBeenCalledWith(
        { characterId: 'char', chatId: 'opened' },
        { route: 'a' },
    ))
})

it('stores multiple-choice answers as a JSON array', async () => {
    const { opened, char } = setup({
        mode: 'form',
        questions: [{ id: 'q', title: 'Tags', type: 'multiple', varName: 'tags', required: false, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }],
    })
    component = mount(OnboardingDialog, { target: document.body, props: { open: true, character: char, chat: opened } })
    await tick()

    button('B').click()
    await tick()
    button('A').click()
    await tick()
    button('Done').click()
    await vi.waitFor(() => expect(mocks.applyOnboardingAnswers).toHaveBeenCalledWith(
        { characterId: 'char', chatId: 'opened' },
        { tags: '["b","a"]' },
    ))
})

it('updates HTML choices for the edited variable and submits the staged answers', async () => {
    const { opened, char } = setup({
        mode: 'html', questions: [],
        html: `
            <button risu-change-var-name="route" risu-change-var-value="a">A</button>
            <button risu-change-var-name="route" risu-change-var-value="b"><span>B</span></button>
            <input risu-change-var-name="name">
            <button risu-change-var-name="name" risu-change-var-value="Updated">Updated name</button>
        `,
    }, { $route: 'a', $name: 'Original' })
    const props = $state({ open: true, character: char, chat: opened })
    component = mount(OnboardingDialog, { target: document.body, props })
    await vi.waitFor(() => expect(button('A').classList.contains('x-risu-selected')).toBe(true))

    const input = document.body.querySelector('input')!
    expect(input.value).toBe('Original')
    button('B').querySelector('span')!.click()
    expect(button('A').classList.contains('x-risu-selected')).toBe(false)
    expect(button('B').classList.contains('x-risu-selected')).toBe(true)
    expect(input.value).toBe('Original')

    input.value = 'Updated'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(button('Updated name').classList.contains('x-risu-selected')).toBe(true)
    expect(opened.scriptstate).toEqual({ $route: 'a', $name: 'Original' })

    button('Done').click()
    await vi.waitFor(() => expect(mocks.applyOnboardingAnswers).toHaveBeenCalledWith(
        { characterId: 'char', chatId: 'opened' },
        { route: 'b', name: 'Updated' },
    ))

    props.open = false
    await tick()
    props.open = true
    await vi.waitFor(() => expect(button('A').classList.contains('x-risu-selected')).toBe(true))
    expect(document.body.querySelector('input')!.value).toBe('Original')
})
