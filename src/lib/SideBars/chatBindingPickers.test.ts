import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { get } from 'svelte/store';
import PromptBind from './PromptBind.svelte';
import PersonaBind from './PersonaBind.svelte';
import { DBState, openPresetList, openPersonaList, presetSelectCallback, personaSelectCallback } from 'src/ts/stores.svelte';
import { bindPromptPresetToCurrentChat, bindPersonaToCurrentChat } from 'src/ts/chatBindings';
import { changeToPreset } from 'src/ts/storage/database.svelte';

vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store');
    return {
        DBState: { db: {} },
        selectedCharID: writable(0),
        openPresetList: writable(false),
        openPersonaList: writable(false),
        presetSelectCallback: writable(null),
        personaSelectCallback: writable(null),
    };
});
vi.mock('src/ts/storage/database.svelte', () => ({ changeToPreset: vi.fn() }));
vi.mock('src/ts/chatBindings', () => ({
    bindPromptPresetToCurrentChat: vi.fn(),
    bindPersonaToCurrentChat: vi.fn(),
}));
vi.mock('src/ts/parser/parser.svelte', () => ({ parseMarkdownSafe: (text: string) => text }));

const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)));
    document.body.innerHTML = '';
    vi.clearAllMocks();
});

describe('sidebar binding buttons', () => {
    it.each([false, true])('applies saved bindings only when shown=%s', async (shown) => {
        Object.assign(DBState.db, {
            showPresetInSidebar: shown,
            showPersonaInSidebar: shown,
            characters: [{ chatPage: 0, chats: [{
                bindedBotPreset: 'bound-prompt', bindedPersona: 'bound-persona',
            }] }],
            botPresets: [{ id: 'global-prompt', name: 'Global Prompt' }, { id: 'bound-prompt', name: 'Bound Prompt' }],
            botPresetsId: 0,
            personas: [{ id: 'global-persona', name: 'Global Persona' }, { id: 'bound-persona', name: 'Bound Persona' }],
            selectedPersona: 0,
        });
        const prompt = document.createElement('div');
        const persona = document.createElement('div');
        document.body.append(prompt, persona);
        mounted.push(mount(PromptBind, { target: prompt }), mount(PersonaBind, { target: persona }));
        await tick();

        expect(prompt.textContent).toContain(shown ? 'Bound Prompt' : 'Global Prompt');
        expect(persona.textContent).toContain(shown ? 'Bound Persona' : 'Global Persona');
        if (shown) expect(changeToPreset).toHaveBeenCalledWith(1);
        else expect(changeToPreset).not.toHaveBeenCalled();
        expect(DBState.db.characters[0].chats[0]).toMatchObject({
            bindedBotPreset: 'bound-prompt', bindedPersona: 'bound-persona',
        });
    });

    it.each([false, true])('opens both folder pickers directly when bound=%s', async (bound) => {
        Object.assign(DBState.db, {
            showPresetInSidebar: true,
            showPersonaInSidebar: true,
            characters: [{ chatPage: 0, chats: [{
                bindedBotPreset: bound ? 'prompt-id' : '',
                bindedPersona: bound ? 'persona-id' : '',
            }] }],
            botPresets: [{ id: 'prompt-id', name: 'Prompt' }],
            botPresetsId: 0,
            personas: [{ id: 'persona-id', name: 'Persona' }],
            selectedPersona: 0,
        });
        openPresetList.set(false);
        openPersonaList.set(false);
        presetSelectCallback.set(null);
        personaSelectCallback.set(null);

        const prompt = document.createElement('div');
        const persona = document.createElement('div');
        document.body.append(prompt, persona);
        mounted.push(mount(PromptBind, { target: prompt }), mount(PersonaBind, { target: persona }));
        await tick();
        prompt.querySelector('button')!.click();
        persona.querySelector('button')!.click();

        expect(get(openPresetList)).toBe(true);
        expect(get(openPersonaList)).toBe(true);
        expect(get(presetSelectCallback)).toBe(bindPromptPresetToCurrentChat);
        expect(get(personaSelectCallback)).toBe(bindPersonaToCurrentChat);
        expect(bindPromptPresetToCurrentChat).not.toHaveBeenCalled();
        expect(bindPersonaToCurrentChat).not.toHaveBeenCalled();
    });
});
