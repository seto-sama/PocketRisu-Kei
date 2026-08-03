'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LuaFactory } = require('wasmoon');

require('sucrase/register/ts');
const { wrapRevenantLua } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'luaWrapper.ts',
));
const { renderRevenantTemplate } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'headlessParser.ts',
));
const { invokeLuaMode, registerLuaCoreApis } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'luaCore.ts',
));

const WAITING_CLIENT_PREFIX = 'RISU_REVENANT_WAITING_CLIENT:';
let factoryPromise;

async function getFactory() {
    if (!factoryPromise) {
        factoryPromise = (async () => {
            const factory = new LuaFactory();
            await factory.mountFile(
                'json.lua',
                fs.readFileSync(path.join(process.cwd(), 'public', 'lua', 'json.lua'), 'utf8'),
            );
            return factory;
        })();
    }
    return factoryPromise;
}

function waitingClientError(action) {
    return new Error(WAITING_CLIENT_PREFIX + Buffer.from(JSON.stringify(action)).toString('base64url'));
}

function parseWaitingClientError(error) {
    const message = String(error?.message || error || '');
    const offset = message.indexOf(WAITING_CLIENT_PREFIX);
    if (offset < 0) return undefined;
    const encoded = message.slice(offset + WAITING_CLIENT_PREFIX.length).split(/\s/)[0];
    try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { return undefined; }
}

async function executeRevenantLua(options) {
    const {
        code,
        mode,
        recipe,
        responses = {},
        meta = {},
        actionNamespace = 'lua',
    } = options;
    let data = options.data;
    let chat = structuredClone(options.chat || recipe.chat);
    const foregroundEffects = [];
    const mutations = {};
    const lowLevelAccess = options.lowLevelAccess ?? recipe.character?.lowLevelAccess === true;
    let stopped = false;
    let callIndex = 0;
    const accessKey = 'revenant-server';
    const requireLowLevel = () => lowLevelAccess;
    const action = (kind, payload) => {
        const rawActionId = `${actionNamespace}.${kind}:${callIndex++}`;
        const actionId = rawActionId.length <= 128
            ? rawActionId
            : `${rawActionId.slice(0, 94)}.${crypto.createHash('sha256').update(rawActionId).digest('hex').slice(0, 32)}`;
        if (Object.prototype.hasOwnProperty.call(responses, actionId)) return responses[actionId];
        throw waitingClientError({
            schemaVersion: 1,
            actionId,
            kind,
            payload,
        });
    };
    const chatVar = key => String(chat.scriptstate?.[`$${key}`] ?? 'null');
    const setChatVar = (key, value) => {
        chat.scriptstate ||= {};
        chat.scriptstate[`$${key}`] = String(value);
    };
    const providerFor = mode => recipe.auxProviders?.[mode] || {
        backend: recipe.providerBackend,
        modelPreset: recipe.modelPreset,
    };
    const factory = await getFactory();
    const engine = await factory.createEngine({ injectObjects: true, functionTimeout: 5000 });
    const declare = (name, fn) => engine.global.set(name, fn);

    registerLuaCoreApis(declare, () => ({
        canSetVariable: () => true,
        canMutate: () => true,
        getChat: () => chat,
        getCharacter: () => recipe.character,
        getVar: chatVar,
        setVar: setChatVar,
        getGlobalVar: key => String(recipe.database.globalChatVariables?.[key] ?? 'null'),
        stop: () => { stopped = true; },
        render: value => renderRevenantTemplate(value, recipe, chat).text,
        markCharacterMutation: (field, value) => {
            mutations.character ||= {};
            mutations.character[field] = value;
        },
    }));

    declare('alertError', (_id, value) => { foregroundEffects.push({ kind: 'alert', level: 'error', message: String(value) }); });
    declare('alertNormal', (_id, value) => { foregroundEffects.push({ kind: 'alert', level: 'normal', message: String(value) }); });
    declare('alertInput', (_id, value) => requireLowLevel() ? action('ui.input', { message: String(value) }) : '');
    declare('alertSelect', (_id, values) => requireLowLevel() ? action('ui.select', { options: [...values] }) : '');
    declare('alertConfirm', (_id, value) => requireLowLevel() ? action('ui.confirm', { message: String(value) }) : false);
    declare('getTokens', async (_id, value) => action(
        'utility.tokenize', { text: String(value) },
    ));
    declare('sleep', async (_id, time) => new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(0, Number(time) || 0)))));
    declare('logMain', value => { foregroundEffects.push({ kind: 'log', value: String(value) }); });
    declare('reloadDisplay', () => { foregroundEffects.push({ kind: 'reload.display' }); });
    declare('reloadChat', (_id, index) => {
        foregroundEffects.push({ kind: 'reload.chat', index: Number(index) || 0 });
    });
    declare('similarity', async (_id, source, values) => requireLowLevel()
        ? action('utility.similarity-list', {
            source: String(source),
            values: values ? [...values].map(String) : [],
        })
        : []);
    declare('LLMMain', async (_id, prompt, useMultimodal, llmOptions) => {
        if (!requireLowLevel()) return JSON.stringify({ success: false, result: 'Low-level access is disabled' });
        const provider = providerFor('model');
        const result = action('provider.llm', {
            backend: provider.backend,
            modelPreset: provider.modelPreset,
            prompt: JSON.parse(String(prompt)),
            useMultimodal: useMultimodal === true,
            options: llmOptions ? JSON.parse(String(llmOptions)) : {},
        });
        return JSON.stringify(result);
    });
    declare('axLLMMain', async (_id, prompt, useMultimodal, llmOptions) => {
        if (!requireLowLevel()) return JSON.stringify({ success: false, result: 'Low-level access is disabled' });
        const provider = providerFor('otherAx');
        const result = action('provider.axllm', {
            backend: provider.backend,
            modelPreset: provider.modelPreset,
            prompt: JSON.parse(String(prompt)),
            useMultimodal: useMultimodal === true,
            options: llmOptions ? JSON.parse(String(llmOptions)) : {},
        });
        return JSON.stringify(result);
    });
    declare('simpleLLM', async (_id, prompt) => {
        if (!requireLowLevel()) return { success: false, result: 'Low-level access is disabled' };
        return action('provider.simplellm', {
            backend: recipe.providerBackend,
            modelPreset: recipe.modelPreset,
            prompt: String(prompt),
        });
    });
    declare('request', async (_id, url) => requireLowLevel()
        ? action('network.request', { url: String(url) })
        : JSON.stringify({ status: 403, data: 'Low-level access is disabled' }));
    declare('generateImage', async (_id, prompt, negativePrompt = '') => requireLowLevel()
        ? action('image.generate', { prompt: String(prompt), negativePrompt: String(negativePrompt) })
        : '');
    declare('getCharacterImageMain', async () => action('asset.character-image', {}));
    declare('getPersonaImageMain', async () => action('asset.persona-image', {}));
    declare('getPersonaName', () => recipe.database.username ?? 'User');
    declare('getPersonaDescription', () => renderRevenantTemplate(
        recipe.database.personaPrompt ?? '', recipe, chat,
    ).text);
    declare('getLoreBooksMain', (_id, search) => {
        const sources = [
            chat.localLore || [],
            recipe.character.globalLore || [],
            ...(recipe.modules || []).map(module => module?.lorebook || []),
        ];
        const found = sources.flatMap(source => source)
            .filter(book => book?.comment === String(search ?? ''))
            .map(book => ({
                ...structuredClone(book),
                content: renderRevenantTemplate(String(book.content ?? ''), recipe, chat).text,
            }));
        return JSON.stringify(found);
    });
    declare('upsertLocalLoreBook', (_id, name, content, options = {}) => {
        chat.localLore ||= [];
        const normalized = options && typeof options === 'object' ? options : {};
        chat.localLore = chat.localLore.filter(book => book?.comment !== String(name));
        chat.localLore.push({
            alwaysActive: normalized.alwaysActive === true,
            comment: String(name),
            content: String(content),
            insertorder: Number(normalized.insertOrder) || 100,
            mode: 'normal',
            key: String(normalized.key ?? ''),
            secondkey: String(normalized.secondKey ?? ''),
            selective: !!normalized.secondKey,
            useRegex: normalized.regex === true,
        });
        return true;
    });
    declare('loadLoreBooksMain', async (_id, reserve = 0) => requireLowLevel()
        ? action('utility.lua-load-lorebooks', { reserve: Number(reserve) || 0 })
        : JSON.stringify([]));
    declare('hash', async (_id, value) => crypto.createHash('sha256').update(String(value)).digest('hex'));

    try {
        await engine.doString(wrapRevenantLua(code));
        const invoked = await invokeLuaMode(engine.global, mode, accessKey, data, meta);
        data = invoked.data;
        if (invoked.result === false) stopped = true;
        return {
            status: 'completed', data, chat, stopped, foregroundEffects,
            ...(Object.keys(mutations).length > 0 ? { mutations } : {}),
        };
    }
    catch (error) {
        const pendingAction = parseWaitingClientError(error);
        if (pendingAction) {
            return {
                status: 'waiting_client', action: pendingAction, data, chat, stopped, foregroundEffects,
                ...(Object.keys(mutations).length > 0 ? { mutations } : {}),
            };
        }
        throw error;
    }
    finally {
        engine.global.close();
    }
}

module.exports = {
    executeRevenantLua,
    parseWaitingClientError,
    WAITING_CLIENT_PREFIX,
};
