'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LuaFactory } = require('wasmoon');
const {
    WAITING_CLIENT_PREFIX,
    parseWaitingClientError,
    resolveReplayAction,
    waitingClientError,
} = require('./replayAction.cjs');

require('sucrase/register/ts');
const { wrapRevenantLua } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'luaWrapper.ts',
));
const { renderRevenantTemplate } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'headlessParser.ts',
));
const { invokeLuaMode, registerLuaCoreApis, registerLuaEffectApis } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'luaCore.ts',
));
const {
    normalizeLuaLlmPrompt,
    normalizeLuaLlmResult,
    parseLuaLlmOptions,
    serializeLuaLlmResult,
} = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'luaLlmCore.ts',
));

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
    let pendingClientAction;
    const accessKey = 'revenant-server';
    const action = (kind, payload) => {
        const rawActionId = `${actionNamespace}.${kind}:${callIndex++}`;
        const result = resolveReplayAction(responses, rawActionId, kind, payload);
        if (result.available) return result.value;
        pendingClientAction ||= result.action;
        throw waitingClientError(result.action);
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
    const effectHandlers = {};
    const addEffect = (name, handler) => { effectHandlers[name] = handler; };

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
    registerLuaEffectApis(declare, () => ({
        canUseSafeApi: () => true,
        canUseLowLevelApi: () => lowLevelAccess,
        invoke: (name, args) => effectHandlers[name](...args),
    }));

    addEffect('alertError', (_id, value) => { foregroundEffects.push({ kind: 'alert', level: 'error', message: String(value) }); });
    addEffect('alertNormal', (_id, value) => { foregroundEffects.push({ kind: 'alert', level: 'normal', message: String(value) }); });
    addEffect('alertInput', (_id, value) => action('ui.input', { message: String(value) }));
    addEffect('alertSelect', (_id, values) => action('ui.select', { options: [...values] }));
    addEffect('alertConfirm', (_id, value) => action('ui.confirm', { message: String(value) }));
    addEffect('getTokens', async (_id, value) => action(
        'utility.tokenize', { text: String(value) },
    ));
    addEffect('sleep', async (_id, time) => new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(0, Number(time) || 0)))));
    addEffect('logMain', value => { foregroundEffects.push({ kind: 'log', value: String(value) }); });
    addEffect('reloadDisplay', () => { foregroundEffects.push({ kind: 'reload.display' }); });
    addEffect('reloadChat', (_id, index) => {
        foregroundEffects.push({ kind: 'reload.chat', index: Number(index) || 0 });
    });
    addEffect('similarity', async (_id, source, values) => action('utility.similarity-list', {
            source: String(source),
            values: values ? [...values].map(String) : [],
        }));
    addEffect('LLMMain', async (_id, prompt, useMultimodal, llmOptions) => {
        const provider = providerFor('model');
        const result = action('provider.llm', {
            backend: provider.backend,
            modelPreset: provider.modelPreset,
            prompt: normalizeLuaLlmPrompt(prompt),
            useMultimodal: useMultimodal === true,
            options: parseLuaLlmOptions(llmOptions),
        });
        return serializeLuaLlmResult(result);
    });
    addEffect('axLLMMain', async (_id, prompt, useMultimodal, llmOptions) => {
        const provider = providerFor('otherAx');
        const result = action('provider.axllm', {
            backend: provider.backend,
            modelPreset: provider.modelPreset,
            prompt: normalizeLuaLlmPrompt(prompt),
            useMultimodal: useMultimodal === true,
            options: parseLuaLlmOptions(llmOptions),
        });
        return serializeLuaLlmResult(result);
    });
    addEffect('simpleLLM', async (_id, prompt) => {
        return normalizeLuaLlmResult(action('provider.simplellm', {
            backend: recipe.providerBackend,
            modelPreset: recipe.modelPreset,
            prompt: String(prompt),
        }));
    });
    addEffect('request', async (_id, url) => action('network.request', { url: String(url) }));
    addEffect('generateImage', async (_id, prompt, negativePrompt = '') => (
        action('image.generate', { prompt: String(prompt), negativePrompt: String(negativePrompt) })
    ));
    addEffect('getCharacterImageMain', async () => action('asset.character-image', {}));
    addEffect('getPersonaImageMain', async () => action('asset.persona-image', {}));
    addEffect('getPersonaName', () => recipe.database.username ?? 'User');
    addEffect('getPersonaDescription', () => renderRevenantTemplate(
        recipe.database.personaPrompt ?? '', recipe, chat,
    ).text);
    addEffect('getLoreBooksMain', (_id, search) => {
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
    addEffect('upsertLocalLoreBook', (_id, name, content, options = {}) => {
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
    addEffect('loadLoreBooksMain', async (_id, reserve = 0) => (
        action('utility.lua-load-lorebooks', { reserve: Number(reserve) || 0 })
    ));
    addEffect('hash', async (_id, value) => crypto.createHash('sha256').update(String(value)).digest('hex'));

    try {
        await engine.doString(wrapRevenantLua(code));
        const invoked = await invokeLuaMode(engine.global, mode, accessKey, data, meta);
        data = invoked.data;
        if (invoked.result === false) stopped = true;
        if (pendingClientAction) {
            return {
                status: 'waiting_client', action: pendingClientAction,
                data, chat, stopped, foregroundEffects,
                ...(Object.keys(mutations).length > 0 ? { mutations } : {}),
            };
        }
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
