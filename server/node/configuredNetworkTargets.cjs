'use strict';

const path = require('path');
require('sucrase/register/ts');

const source = file => require(path.join(__dirname, '../../src/ts', file));
const { compileModelPreset } = source('preset/runtime/compilePreset.ts');
const { resolveModelPresetCredential } = source('preset/runtime/credential.ts');
const { resolveEndpointUrl } = source('preset/adapter/buildRequest.ts');
const { applyOpenAiApiModeEndpoint } = source('preset/adapter/openaiApiMode.ts');
const { createComfyUrl, COMFY_HTTP_ROUTES } = source('network/comfyUrl.ts');

function normalizeConfiguredHttpUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return undefined;
    try {
        const url = new URL(raw);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:')
            || url.username
            || url.password) {
            return undefined;
        }
        url.hash = '';
        return url.toString();
    } catch {
        return undefined;
    }
}

function addConfiguredUrl(targets, raw) {
    const normalized = normalizeConfiguredHttpUrl(raw);
    if (normalized) targets.add(normalized);
}

function addModelPresetTargets(targets, database) {
    if (!Array.isArray(database.modelPresets)) return;

    for (const preset of database.modelPresets) {
        try {
            if (!preset || typeof preset !== 'object') continue;
            const compiled = compileModelPreset(preset);
            if (compiled.backend !== 'http') continue;

            const requestPreset = compiled.preset;
            const credential = resolveModelPresetCredential(requestPreset, database.apiKeyPool ?? {});
            const serviceAccountJson = typeof credential?.apiKey === 'string'
                ? credential.apiKey
                : undefined;
            const endpoint = resolveEndpointUrl(
                requestPreset.profileSnapshot,
                requestPreset.userValues ?? {},
                serviceAccountJson,
            );
            const prepared = { url: endpoint };
            if (compiled.adapterKind === 'openai-compatible' || compiled.adapterKind === 'openai-responses') {
                applyOpenAiApiModeEndpoint(requestPreset, prepared);
            }
            addConfiguredUrl(targets, prepared.url);
        } catch {
            // A malformed imported preset must not hide other configured URLs.
        }
    }
}

function addCustomEmbeddingTarget(targets, database) {
    const configured = database.hypaCustomSettings?.url;
    if (typeof configured !== 'string' || !configured.trim()) return;
    const base = configured.trim();
    const endpoint = base.endsWith('/embeddings')
        ? base
        : `${base.replace(/\/$/, '')}/embeddings`;
    addConfiguredUrl(targets, endpoint);
}

function addTtsTargets(targets, database) {
    if (!Array.isArray(database.ttsPresets)) return;
    for (const preset of database.ttsPresets) {
        if (preset?.settings?.provider !== 'gptsovits') continue;
        const configured = preset.settings.gptSoVits?.url;
        if (typeof configured !== 'string' || !configured.trim()) continue;
        const base = configured.trim().replace(/\/+$/, '');
        if (base) addConfiguredUrl(targets, `${base}/tts`);
    }
}

function addCurrentComfyTargets(targets, database) {
    const presets = database.imageGenerationPresets;
    if (!Array.isArray(presets) || presets.length === 0) return;
    const index = Number.isInteger(database.imageGenerationPresetId)
        ? database.imageGenerationPresetId
        : 0;
    const preset = presets[index] ?? presets[0];
    if (preset?.settings?.sdProvider !== 'comfyui') return;

    const base = preset.settings.comfyUiUrl;
    if (typeof base !== 'string' || !base) return;
    try {
        for (const [requestPath] of COMFY_HTTP_ROUTES) {
            addConfiguredUrl(targets, createComfyUrl(base, requestPath).toString());
        }
    } catch {
        // Invalid ComfyUI configuration contributes no proxy authorization.
    }
}

function getConfiguredLocalUrls(database) {
    if (!database || typeof database !== 'object') return [];
    const targets = new Set();
    addModelPresetTargets(targets, database);
    addCustomEmbeddingTarget(targets, database);
    addTtsTargets(targets, database);
    addCurrentComfyTargets(targets, database);
    return [...targets];
}

function createConfiguredLocalUrlProvider(appDataStore) {
    let revision;
    let urls;
    return () => {
        const currentRevision = appDataStore.getState().revision;
        if (currentRevision !== revision) {
            urls = getConfiguredLocalUrls(appDataStore.exportProjection({ includeMessages: false }));
            revision = currentRevision;
        }
        return urls;
    };
}

module.exports = { getConfiguredLocalUrls, createConfiguredLocalUrlProvider };
