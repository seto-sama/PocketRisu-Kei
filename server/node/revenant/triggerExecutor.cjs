'use strict';

const path = require('path');
const crypto = require('crypto');
const { executeRevenantLua } = require('./luaExecutor.cjs');
const { resolveReplayAction } = require('./replayAction.cjs');

require('sucrase/register/ts');
const { renderRevenantTemplate } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'postprocess', 'headlessParser.ts',
));
const { evaluateTriggerConditions } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'triggerConditionCore.ts',
));
const { migrateTriggersToCurrentV2 } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'triggerDeprecatedV2Migration.ts',
));
const { runRevenantTriggerProgram } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'trigger', 'runtime.ts',
));

function triggerVar(chat, recipe, key) {
    const current = chat.scriptstate?.[`$${key}`];
    if (current !== undefined && current !== null) return String(current);
    const defaults = `${recipe.character.defaultVariables || ''}\n${recipe.database.templateDefaultVariables || ''}`;
    for (const line of defaults.split('\n')) {
        const separator = line.indexOf('=');
        if (separator >= 0 && line.slice(0, separator).trim() === key) {
            return line.slice(separator + 1).trim();
        }
    }
    return 'null';
}

function setTriggerVar(chat, key, value) {
    chat.scriptstate ||= {};
    chat.scriptstate[`$${key}`] = String(value);
}

function passesConditions(trigger, recipe, chat) {
    return evaluateTriggerConditions({
        conditions: trigger.conditions || [],
        getVar: key => triggerVar(chat, recipe, key),
        render: value => renderRevenantTemplate(String(value ?? ''), recipe, chat).text,
        messages: chat.message,
    });
}

function deterministicInteger(seed, min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    const low = Math.min(Math.trunc(min), Math.trunc(max));
    const high = Math.max(Math.trunc(min), Math.trunc(max));
    const value = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
    return low + (value % (high - low + 1));
}

async function executeRevenantOutputTriggers(options) {
    const { recipe, responses = {} } = options;
    const actionPrefix = options.actionPrefix || 'trigger';
    const recursionDepth = Number(options.recursionDepth) || 0;
    let chat = structuredClone(options.chat || recipe.chat);
    const character = structuredClone(recipe.character || {});
    const database = structuredClone(recipe.database || {});
    const foregroundEffects = [];
    const errors = [];
    const mutations = {};
    let resend = false;
    const persistedTriggers = [
        ...(recipe.character.triggerscript || []).map(trigger => ({
            ...trigger,
            lowLevelAccess: recipe.character.lowLevelAccess === true,
        })),
        ...(recipe.moduleTriggers || []),
    ];
    const hadPersistedV2Header = persistedTriggers[0]?.effect?.[0]?.type === 'v2Header';
    const triggers = migrateTriggersToCurrentV2(persistedTriggers);
    const syntheticHeaderOffset = !hadPersistedV2Header
        && triggers[0]?.effect?.[0]?.type === 'v2Header' ? 1 : 0;

    const waitFor = (actionId, kind, payload) => {
        return resolveReplayAction(responses, actionId, kind, payload);
    };
    const outcome = (status, action) => ({
        status,
        ...(action ? { action } : {}),
        chat,
        resend,
        foregroundEffects,
        errors,
        ...(Object.keys(mutations).length > 0 ? { mutations } : {}),
    });
    const providerFor = mode => recipe.auxProviders?.[mode] || {
        backend: recipe.providerBackend,
        modelPreset: recipe.modelPreset,
    };

    for (const [triggerIndex, trigger] of triggers.entries()) {
        if (trigger.effect?.[0]?.type === 'v2Header') continue;
        const replayTriggerIndex = triggerIndex - syntheticHeaderOffset;
        const lua = trigger.effect?.[0]?.type === 'triggerlua';
        if (!lua && options.manualName) {
            if (trigger.type !== 'manual' || trigger.comment !== options.manualName) continue;
        }
        else if (!lua && trigger.type !== 'output') continue;
        if (!passesConditions(trigger, { ...recipe, character, database }, chat)) continue;
        const effects = trigger.effect || [];
        const localScopes = {};
        let currentIndent = 0;
        const getLocalVar = key => {
            for (let indent = currentIndent; indent >= 0; indent--) {
                if (localScopes[indent]?.[key] !== undefined) return localScopes[indent][key];
            }
            return undefined;
        };
        const getVar = key => getLocalVar(key) ?? triggerVar(chat, { ...recipe, character, database }, key);
        const setVar = (key, value) => {
            for (let indent = currentIndent; indent >= 0; indent--) {
                if (localScopes[indent]?.[key] !== undefined) {
                    localScopes[indent][key] = String(value ?? 'null');
                    return;
                }
            }
            setTriggerVar(chat, key, value);
        };
        const declareLocal = (key, value, indent) => {
            localScopes[indent] ||= {};
            localScopes[indent][key] = String(value ?? 'null');
        };
        const clearLocals = indent => {
            for (const key of Object.keys(localScopes)) {
                if (Number(key) >= indent) delete localScopes[key];
            }
        };
        const render = (value) => renderRevenantTemplate(
            String(value ?? ''), { ...recipe, character, database }, chat,
        ).text;
        const coreChat = {};
        Object.defineProperties(coreChat, {
            id: { get: () => chat.id },
            fmIndex: { get: () => chat.fmIndex },
            note: { get: () => chat.note, set: value => { chat.note = value; } },
            message: { get: () => chat.message, set: value => { chat.message = value; } },
        });
        const stopProgram = Symbol('stop-trigger-program');
        let terminalOutcome;
        const effectActionPrefix = ({ effectIndex, visit }) => (
            `${actionPrefix}.${replayTriggerIndex}.${effectIndex}`
            + (visit === 1 ? '' : `.visit-${visit}`)
        );

        await runRevenantTriggerProgram({
            effects,
            core: {
                render,
                getVar,
                setVar,
                declareLocal,
                clearLocals,
                chat: coreChat,
                character,
                database,
                globalVar: key => database.globalChatVariables?.[key] ?? 'null',
                randomInteger: (minimum, maximum, effectIndex, visit) => deterministicInteger([
                    recipe.messageChatId || chat.id || '', replayTriggerIndex, effectIndex,
                    visit, minimum, maximum,
                ].join(':'), minimum, maximum),
            },
            lowLevelAccess: trigger.lowLevelAccess === true,
            onIndent: indent => { currentIndent = indent; },
            onMutations: patch => {
                if (patch.character) {
                    mutations.character = {
                        ...(mutations.character || {}), ...patch.character,
                    };
                }
                if (patch.database) {
                    mutations.database = {
                        ...(mutations.database || {}), ...patch.database,
                    };
                }
            },
            shouldStopAfterAction: result => result === stopProgram,
            executeAction: async (triggerAction, context) => {
                const payload = triggerAction.payload;
                const prefix = effectActionPrefix(context);
                switch (triggerAction.kind) {
                        case 'log':
                            foregroundEffects.push({ kind: 'log', value: payload.value });
                            break;
                        case 'ui.alert':
                            foregroundEffects.push({
                                kind: 'alert', level: payload.level || 'normal', message: String(payload.message ?? ''),
                            });
                            break;
                        case 'ui.reload-display':
                            foregroundEffects.push({ kind: 'reload.display' });
                            break;
                        case 'ui.reload-chat':
                            foregroundEffects.push({ kind: 'reload.chat', index: Number(payload.index) || 0 });
                            break;
                        case 'prompt.append':
                        case 'prompt.stop':
                            // Prompt construction is already terminal on the server.
                            break;
                        case 'chat.resend':
                            resend = true;
                            break;
                        case 'utility.wait':
                            await new Promise(resolve => setTimeout(resolve, Number(payload.durationMs) || 0));
                            break;
                        case 'trigger.run': {
                            if (recursionDepth >= 10 && !trigger.lowLevelAccess) break;
                            const nested = await executeRevenantOutputTriggers({
                                recipe: { ...recipe, character, database },
                                chat,
                                text: options.text,
                                responses,
                                manualName: String(payload.target ?? ''),
                                recursionDepth: recursionDepth + 1,
                                actionPrefix: `${prefix}.manual`,
                            });
                            chat = nested.chat;
                            resend ||= nested.resend === true;
                            foregroundEffects.push(...(nested.foregroundEffects || []));
                            errors.push(...(nested.errors || []));
                            if (nested.mutations?.character) {
                                mutations.character = { ...(mutations.character || {}), ...nested.mutations.character };
                                Object.assign(character, structuredClone(nested.mutations.character));
                            }
                            if (nested.mutations?.database) {
                                mutations.database = { ...(mutations.database || {}), ...nested.mutations.database };
                                Object.assign(database, structuredClone(nested.mutations.database));
                            }
                            if (nested.status === 'waiting_client') {
                                terminalOutcome = outcome('waiting_client', nested.action);
                                return stopProgram;
                            }
                            break;
                        }
                        default: {
                            const replayKind = triggerAction.kind;
                            let replayPayload = payload;
                            if (replayKind === 'provider.llm') {
                                const provider = providerFor(payload.mode === 'submodel' ? 'submodel' : 'model');
                                replayPayload = {
                                    backend: provider.backend,
                                    modelPreset: provider.modelPreset,
                                    prompt: payload.prompt,
                                    mode: payload.mode,
                                    options: { streaming: payload.streaming === true },
                                };
                            }
                            const pending = waitFor(
                                `${prefix}.${replayKind}`,
                                replayKind,
                                replayPayload,
                            );
                            if (!pending.available) {
                                terminalOutcome = outcome('waiting_client', pending.action);
                                return stopProgram;
                            }
                            return pending.value;
                        }
                    }
                return undefined;
            },
            executeUnhandled: async (effect, context) => {
                const prefix = effectActionPrefix(context);
                switch (effect.type) {
                    case 'triggercode':
                        // JavaScript triggercode is intentionally not executed on the server.
                        break;
                    case 'triggerlua': {
                        const result = await executeRevenantLua({
                            code: effect.code,
                            mode: 'output',
                            data: options.text,
                            recipe,
                            chat,
                            responses,
                            lowLevelAccess: trigger.lowLevelAccess === true,
                            actionNamespace: prefix,
                        });
                        foregroundEffects.push(...result.foregroundEffects);
                        if (result.mutations?.character) {
                            mutations.character = {
                                ...(mutations.character || {}), ...result.mutations.character,
                            };
                            Object.assign(character, structuredClone(result.mutations.character));
                        }
                        if (result.mutations?.database) {
                            mutations.database = {
                                ...(mutations.database || {}), ...result.mutations.database,
                            };
                            Object.assign(database, structuredClone(result.mutations.database));
                        }
                        if (result.status === 'waiting_client') {
                            terminalOutcome = outcome('waiting_client', result.action);
                            return { stop: true };
                        }
                        chat = result.chat;
                        break;
                    }
                    case 'v2GetDisplayState':
                    case 'v2SetDisplayState':
                    case 'v2GetRequestState':
                    case 'v2SetRequestState':
                    case 'v2GetRequestStateRole':
                    case 'v2SetRequestStateRole':
                    case 'v2GetRequestStateLength':
                        // The browser executor stops a trigger when a mode-specific
                        // state operation is encountered in the wrong mode.
                        return { stop: true };
                    default:
                        errors.push(`Unsupported server output trigger effect: ${effect.type}`);
                }
                return undefined;
            },
            onError: error => {
                errors.push(error instanceof Error ? error.message : String(error));
            },
        });
        if (terminalOutcome) return terminalOutcome;
    }

    return outcome('completed');
}

module.exports = { executeRevenantOutputTriggers, passesConditions };
