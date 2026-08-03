'use strict';

const fs = require('fs');
const path = require('path');
const { LuaFactory } = require('wasmoon');

require('sucrase/register/ts');
const { wrapRevenantLua } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'luaWrapper.ts',
));
const { renderRevenantTemplate } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'headlessParser.ts',
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

function normalizeRole(role) {
    return role === 'user' ? 'user' : 'char';
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
    const lowLevelAccess = options.lowLevelAccess ?? recipe.character?.lowLevelAccess === true;
    let stopped = false;
    let callIndex = 0;
    const accessKey = 'revenant-server';
    const requireLowLevel = () => lowLevelAccess;
    const action = (kind, payload) => {
        const actionId = `${actionNamespace}.${kind}:${callIndex++}`;
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
    const factory = await getFactory();
    const engine = await factory.createEngine({ injectObjects: true, functionTimeout: 5000 });
    const declare = (name, fn) => engine.global.set(name, fn);

    declare('getChatVar', (_id, key) => chatVar(key));
    declare('setChatVar', (_id, key, value) => setChatVar(key, value));
    declare('getGlobalVar', (_id, key) => String(recipe.database.globalChatVariables?.[key] ?? 'null'));
    declare('stopChat', () => { stopped = true; });
    declare('alertError', (_id, value) => { foregroundEffects.push({ kind: 'alert', level: 'error', message: String(value) }); });
    declare('alertNormal', (_id, value) => { foregroundEffects.push({ kind: 'alert', level: 'normal', message: String(value) }); });
    declare('alertInput', (_id, value) => requireLowLevel() ? action('ui.input', { message: String(value) }) : '');
    declare('alertSelect', (_id, values) => requireLowLevel() ? action('ui.select', { options: [...values] }) : '');
    declare('alertConfirm', (_id, value) => requireLowLevel() ? action('ui.confirm', { message: String(value) }) : false);
    declare('getChatMain', (_id, index) => {
        const message = chat.message.at(Number(index));
        return JSON.stringify(message ? { role: message.role, data: message.data, time: message.time ?? 0 } : null);
    });
    declare('setChat', (_id, index, value) => {
        const message = chat.message.at(Number(index));
        if (message) message.data = String(value);
    });
    declare('setChatRole', (_id, index, role) => {
        const message = chat.message.at(Number(index));
        if (message) message.role = normalizeRole(role);
    });
    declare('cutChat', (_id, start, end) => { chat.message = chat.message.slice(Number(start), Number(end)); });
    declare('removeChat', (_id, index) => { chat.message.splice(Number(index), 1); });
    declare('addChat', (_id, role, value) => { chat.message.push({ role: normalizeRole(role), data: String(value) }); });
    declare('insertChat', (_id, index, role, value) => {
        chat.message.splice(Number(index), 0, { role: normalizeRole(role), data: String(value) });
    });
    declare('getChatLength', () => chat.message.length);
    declare('getFullChatMain', () => JSON.stringify(chat.message.map(message => ({
        role: message.role, data: message.data, time: message.time ?? 0,
    }))));
    declare('setFullChatMain', (_id, value) => {
        const messages = JSON.parse(String(value));
        if (Array.isArray(messages)) chat.message = messages.map(message => ({
            role: normalizeRole(message?.role), data: String(message?.data ?? ''), time: message?.time,
        }));
    });
    declare('sleep', async (_id, time) => new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(0, Number(time) || 0)))));
    declare('cbs', value => renderRevenantTemplate(String(value), recipe, chat).text);
    declare('logMain', value => { foregroundEffects.push({ kind: 'log', value: String(value) }); });
    declare('reloadDisplay', () => { foregroundEffects.push({ kind: 'reload.display' }); });
    declare('reloadChat', () => { foregroundEffects.push({ kind: 'reload.chat' }); });
    declare('LLMMain', async (_id, prompt, useMultimodal, llmOptions) => {
        if (!requireLowLevel()) return JSON.stringify({ success: false, result: 'Low-level access is disabled' });
        const result = action('provider.llm', {
            backend: recipe.providerBackend,
            modelPreset: recipe.modelPreset,
            prompt: JSON.parse(String(prompt)),
            useMultimodal: useMultimodal === true,
            options: llmOptions ? JSON.parse(String(llmOptions)) : {},
        });
        return JSON.stringify(result);
    });
    declare('axLLMMain', async (_id, prompt, useMultimodal, llmOptions) => {
        if (!requireLowLevel()) return JSON.stringify({ success: false, result: 'Low-level access is disabled' });
        const result = action('provider.axllm', {
            backend: recipe.providerBackend,
            modelPreset: recipe.modelPreset,
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
    declare('getName', () => recipe.character.name ?? '');
    declare('setName', (_id, name) => { recipe.character.name = String(name); });
    declare('getDescription', () => recipe.character.desc ?? '');
    declare('setDescription', (_id, value) => { recipe.character.desc = String(value); });
    declare('getPersonaName', () => recipe.database.username ?? 'User');
    declare('getPersonaDescription', () => recipe.database.personaPrompt ?? '');
    declare('getLoreBooksMain', () => JSON.stringify((recipe.modules || []).flatMap(module => module?.lorebook || [])));
    declare('loadLoreBooksMain', async () => JSON.stringify((recipe.modules || []).flatMap(module => module?.lorebook || [])));
    declare('hash', async (_id, value) => require('crypto').createHash('sha256').update(String(value)).digest('hex'));

    try {
        await engine.doString(wrapRevenantLua(code));
        if (mode === 'editOutput') {
            const listener = engine.global.get('callListenMain');
            if (listener) data = JSON.parse(await listener(mode, accessKey, JSON.stringify(data), JSON.stringify(meta)));
        }
        else {
            const callback = engine.global.get(mode === 'output' ? 'onOutput' : mode);
            if (callback) {
                const result = await callback(accessKey);
                if (result === false) stopped = true;
            }
        }
        return { status: 'completed', data, chat, stopped, foregroundEffects };
    }
    catch (error) {
        const pendingAction = parseWaitingClientError(error);
        if (pendingAction) {
            return { status: 'waiting_client', action: pendingAction, data, chat, stopped, foregroundEffects };
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
