import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { get } from 'svelte/store';
import ModelProfileBrowser from './modelProfileBrowser.svelte';
import { DBState, modelProfileReplaceTarget, openModelPresetEditId } from 'src/ts/stores.svelte';
import { alertConfirm } from 'src/ts/alert';
import { createModelPresetFromProfile } from 'src/ts/preset/profileUpdate';
import type { BaseProviderDefinition, ModelProfile, RegistryCache } from 'src/ts/preset/types';

vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store');
    return {
        DBState: { db: {} },
        modelProfileReplaceTarget: writable(null),
        openModelPresetEditId: writable(null),
    };
});
vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(), alertError: vi.fn(), notifySuccess: vi.fn(),
}));
vi.mock('src/ts/preset/apiKeyPool', () => ({ getDefaultApiKeyRef: () => undefined }));
vi.mock('src/ts/plugins/apiV3/v3.svelte', () => ({ customV3ProviderMetaStore: [] }));
vi.mock('src/ts/preset/registry', async () => ({
    ...await import('src/ts/preset/registry/providerFilter'),
    ...await import('src/ts/preset/registry/visibility'),
    getOfficialRegistry: () => registry,
    getOfficialRegistryId: () => 'catalog',
    syncRemoteRegistry: vi.fn(),
}));

const uiSchema = { groups: [], fields: [] };
const providers: BaseProviderDefinition[] = ['OpenAI', 'Anthropic'].map(displayName => ({
    id: displayName.toLowerCase(), displayName,
    adapterKind: 'openai-compatible', authKinds: ['bearer'], endpointKinds: ['static'],
    requestSchema: [], uiSchema, sourceUrls: [],
}));
const profiles: ModelProfile[] = ['Alpha', 'Beta', 'Hidden'].map((displayName, index) => ({
    id: displayName.toLowerCase(), displayName, modelId: displayName.toLowerCase(),
    providerBaseId: index === 2 ? 'anthropic' : 'openai', profileStatus: 'current',
    endpoint: { kind: 'static', url: 'https://example.test/v1/chat/completions' },
    auth: { kind: 'bearer', fields: ['apiKey'] }, defaults: {}, schema: [], uiSchema, sourceUrls: [],
}));
const registry: RegistryCache = {
    schemaVersion: 4,
    registries: { catalog: {
        fetchedAt: 0,
        baseProviders: Object.fromEntries(providers.map(provider => [provider.id, provider])),
        profiles: Object.fromEntries(profiles.map(profile => [profile.id, profile])),
    } },
};
const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
    DBState.db = {
        language: 'en', modelPresets: [], modelProfileVisibleProviderIds: ['openai'],
        modelProfileProviderFilterInitialized: true,
    } as typeof DBState.db;
    modelProfileReplaceTarget.set(null);
    openModelPresetEditId.set(null);
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(true);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component)));
    document.body.replaceChildren();
});

async function renderBrowser() {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(ModelProfileBrowser, { target }));
    await tick();
    return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

async function search(query: string) {
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
}

function modelButton(name: string) {
    return Array.from(document.querySelectorAll('button')).find(button =>
        button.textContent?.includes(name))!;
}

describe('model profile browser', () => {
    it('toggles provider folders and reveals search matches while respecting provider filters', async () => {
        const dialog = await renderBrowser();
        const folder = dialog.querySelector<HTMLElement>('[aria-expanded]')!;
        expect(folder.textContent).toContain('OpenAI');
        expect(folder.getAttribute('aria-expanded')).toBe('false');
        expect(dialog.textContent).not.toContain('Anthropic');
        expect(modelButton('Alpha')).toBeUndefined();

        folder.click();
        await tick();
        expect(modelButton('Alpha')).toBeDefined();
        folder.click();
        await tick();
        await search('beta');
        expect(modelButton('Beta')).toBeDefined();
        expect(modelButton('Alpha')).toBeUndefined();
        await search('Hidden');
        expect(dialog.querySelector('[data-slot="empty-state"]')).not.toBeNull();
        await search('');
        expect(dialog.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('creates a preset from a model row and opens it for editing', async () => {
        await renderBrowser();
        await search('Alpha');
        modelButton('Alpha').click();
        await tick();
        expect(DBState.db.modelPresets).toHaveLength(1);
        const preset = DBState.db.modelPresets[0];
        expect(preset.profileSnapshot.modelId).toBe('alpha');
        expect(get(openModelPresetEditId)).toBe(preset.id);
        await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    });

    it('keeps replacement open on cancellation and commits the chosen model after confirmation', async () => {
        const original = createModelPresetFromProfile({
            registry, registryId: 'catalog', profileId: 'alpha',
        }, { id: 'existing-preset' })!;
        DBState.db.modelPresets = [original];
        modelProfileReplaceTarget.set(original.id);
        vi.mocked(alertConfirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await renderBrowser();
        await search('Beta');
        modelButton('Beta').click();
        await vi.waitFor(() => expect(alertConfirm).toHaveBeenCalledTimes(1));
        expect(DBState.db.modelPresets[0].profileSnapshot.modelId).toBe('alpha');
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();

        modelButton('Beta').click();
        await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
        expect(DBState.db.modelPresets).toHaveLength(1);
        expect(DBState.db.modelPresets[0]).toMatchObject({
            id: original.id, name: original.name, profileSnapshot: { modelId: 'beta' },
        });
        expect(get(modelProfileReplaceTarget)).toBeNull();
    });
});
