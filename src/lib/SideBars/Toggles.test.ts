import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import Toggles from './Toggles.svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import { language } from 'src/lang'
import { alertTogglePresets } from 'src/ts/alert'
import { getGlobalChatVar } from 'src/ts/parser/chatVar.svelte'
import { risuChatParser } from 'src/ts/parser/parser.svelte'
import { applyToggleValues, saveTogglesToChat } from 'src/ts/storage/database.svelte'

vi.mock('src/ts/globalApi.svelte', () => ({ downloadFile: () => {}, saveAsset: async () => '' }))
vi.mock('src/ts/storage/autoStorage', () => ({ forageStorage: { realStorage: null } }))
vi.mock('src/ts/characters', () => ({ createBlankChar: () => ({}), getCharImage: () => '' }))
vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(async () => true),
    alertTogglePresets: vi.fn(),
    notifySuccess: vi.fn(),
    alertError: vi.fn(),
}))

const mounted: ReturnType<typeof mount>[] = []

beforeEach(() => {
    selectedCharID.set(0)
    DBState.db = {
        characters: [{ chatPage: 0, chats: [{
            message: [],
        }] }],
        globalChatVariables: {},
        customPromptTemplateToggle: 'flag=Flag\nchoice=Choice=select=First,Second',
        promptTemplate: [], modules: [], enabledModules: [],
    } as any
    vi.clearAllMocks()
})

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component)))
    document.body.replaceChildren()
})

async function renderToggles() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(Toggles, { target }))
    await tick()
    return target
}

describe('toggle pin controls', () => {
    it('pins bound defaults and clears the change indicator when a switch returns to zero', async () => {
        const target = await renderToggles()
        expect(getGlobalChatVar('toggle_choice')).toBe('0')
        saveTogglesToChat()
        await tick()
        const save = [...target.querySelectorAll('button')].find(button => button.textContent?.trim() === language.togglePinUpdateLabel)!
        expect(save.disabled).toBe(true)

        const control = target.querySelector<HTMLButtonElement>('[role="switch"]')!
        control.click()
        await tick()
        expect(getGlobalChatVar('toggle_flag')).toBe('1')
        expect(save.disabled).toBe(false)
        expect(save.textContent?.trim()).toBe('1')

        control.click()
        await tick()
        expect(getGlobalChatVar('toggle_flag')).toBe('0')
        expect(save.disabled).toBe(true)
        expect(save.textContent?.trim()).toBe(language.togglePinUpdateLabel)
    })

    it('keeps the displayed select and CBS at zero after applying a preset without its key', async () => {
        const target = await renderToggles()
        DBState.db.globalChatVariables.toggle_choice = '1'
        await tick()
        expect(risuChatParser('[{{getglobalvar::toggle_choice}}]')).toBe('[1]')

        applyToggleValues({ toggle_flag: '1' })
        await tick()
        expect(target.querySelector('[data-slot="select-trigger"]')!.textContent?.trim()).toBe('First')
        expect(risuChatParser('[{{getglobalvar::toggle_choice}}]')).toBe('[0]')
    })

    it('keeps the preset picker available with chat binding disabled', async () => {
        DBState.db.disableToggleBinding = true
        DBState.db.customPromptTemplateToggle = ''
        const target = await renderToggles()
        target.querySelector<HTMLButtonElement>('button')!.click()
        await tick()
        expect(alertTogglePresets).toHaveBeenCalledOnce()
    })
})
