'use strict';

const path = require('path');
const crypto = require('crypto');
const { executeRevenantLua } = require('./luaExecutor.cjs');

require('sucrase/register/ts');
const { renderRevenantTemplate } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'headlessParser.ts',
));
const { createTriggerV2Core } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'triggerV2Core.ts',
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

function compare(left, operator, right) {
    switch (operator) {
        case '=': return left === right;
        case '!=': return left !== right;
        case '>': return Number(left) > Number(right);
        case '<': return Number(left) < Number(right);
        case '>=': return Number(left) >= Number(right);
        case '<=': return Number(left) <= Number(right);
        case 'null': return left === 'null' || left === '';
        case 'true': return left === 'true' || left === '1';
        default: return false;
    }
}

function passesConditions(trigger, recipe, chat) {
    for (const condition of trigger.conditions || []) {
        if (condition.type === 'var' || condition.type === 'value' || condition.type === 'chatindex') {
            const left = condition.type === 'var'
                ? triggerVar(chat, recipe, condition.var)
                : condition.type === 'chatindex'
                    ? String(chat.message.length)
                    : String(condition.var ?? '');
            const right = renderRevenantTemplate(String(condition.value ?? ''), recipe, chat).text;
            if (!compare(left, condition.operator, right)) return false;
        }
        else if (condition.type === 'exists') {
            const depth = Math.max(0, Number(condition.depth) || 0);
            const messages = chat.message.slice(Math.max(0, chat.message.length - depth));
            const source = messages.map(message => message.data || '').join('\n');
            const value = renderRevenantTemplate(String(condition.value ?? ''), recipe, chat).text;
            if (condition.type2 === 'regex') {
                try { if (!new RegExp(value).test(source)) return false; }
                catch { return false; }
            }
            else if (condition.type2 === 'strict' ? !source.split(' ').includes(value) : !source.toLowerCase().includes(value.toLowerCase())) {
                return false;
            }
        }
    }
    return true;
}

function actionResult(responses, actionId, action) {
    const key = actionId.length <= 128
        ? actionId
        : `${actionId.slice(0, 94)}.${crypto.createHash('sha256').update(actionId).digest('hex').slice(0, 32)}`;
    if (Object.prototype.hasOwnProperty.call(responses, key)) return { available: true, value: responses[key] };
    return { available: false, action: { schemaVersion: 1, actionId: key, ...action } };
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
    const triggers = [
        ...(recipe.character.triggerscript || []),
        ...(recipe.moduleTriggers || []),
    ];

    const waitFor = (actionId, kind, payload) => {
        return actionResult(responses, actionId, { kind, payload });
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
    const markCharacterMutation = field => {
        mutations.character ||= {};
        mutations.character[field] = structuredClone(character[field]);
    };
    const markDatabaseMutation = field => {
        mutations.database ||= {};
        mutations.database[field] = structuredClone(database[field]);
    };
    const providerFor = mode => recipe.auxProviders?.[mode] || {
        backend: recipe.providerBackend,
        modelPreset: recipe.modelPreset,
    };

    for (const [triggerIndex, trigger] of triggers.entries()) {
        const lua = trigger.effect?.[0]?.type === 'triggerlua';
        if (!lua && options.manualName) {
            if (trigger.type !== 'manual' || trigger.comment !== options.manualName) continue;
        }
        else if (!lua && trigger.type !== 'output') continue;
        if (!passesConditions(trigger, { ...recipe, character, database }, chat)) continue;
        const effects = trigger.effect || [];
        const localScopes = {};
        const effectVisits = {};
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
        const read = (effect, field = 'value', typeField = `${field}Type`) => {
            const rendered = render(effect[field]);
            return effect[typeField] === 'var' ? getVar(rendered) : rendered;
        };
        const outputVar = effect => render(effect.outputVar ?? effect.inputVar ?? '');
        const coreChat = {};
        Object.defineProperties(coreChat, {
            id: { get: () => chat.id },
            fmIndex: { get: () => chat.fmIndex },
            note: { get: () => chat.note, set: value => { chat.note = value; } },
            message: { get: () => chat.message, set: value => { chat.message = value; } },
        });
        const v2Core = createTriggerV2Core({
            effects,
            render,
            getVar,
            setVar,
            declareLocal,
            clearLocals,
            chat: coreChat,
            character,
            globalVar: key => database.globalChatVariables?.[key] ?? 'null',
            randomInteger: (minimum, maximum, effectIndex, visit) => deterministicInteger([
                recipe.messageChatId || chat.id || '', triggerIndex, effectIndex,
                visit, minimum, maximum,
            ].join(':'), minimum, maximum),
        });

        for (let effectIndex = 0; effectIndex < effects.length; effectIndex++) {
            const effect = effects[effectIndex];
            currentIndent = Number.isInteger(effect?.indent) && effect.indent >= 0 ? effect.indent : 0;
            effectVisits[effectIndex] = (effectVisits[effectIndex] || 0) + 1;
            const effectActionPrefix = `${actionPrefix}.${triggerIndex}.${effectIndex}`
                + (effectVisits[effectIndex] === 1 ? '' : `.visit-${effectVisits[effectIndex]}`);
            if (effectVisits[effectIndex] > 10_000) {
                throw new Error(`Trigger loop limit exceeded at effect ${effectIndex}`);
            }
            try {
                const coreStep = v2Core.step(effectIndex);
                if (coreStep.handled) {
                    effectIndex = coreStep.nextIndex;
                    if (coreStep.stop) break;
                    continue;
                }
                // Revenant effect adapter: only delegated or legacy effects reach
                // this switch; pure v2 execution stays in triggerV2Core.ts.
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
                            actionNamespace: effectActionPrefix,
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
                        if (result.status === 'waiting_client') return outcome('waiting_client', result.action);
                        chat = result.chat;
                        break;
                    }
                    case 'setvar': {
                        const key = render(effect.var);
                        const value = render(effect.value);
                        const parsedPrevious = Number(getVar(key));
                        const previous = Number.isNaN(parsedPrevious) ? 0 : parsedPrevious;
                        const operand = Number(value);
                        const result = effect.operator === '+=' ? previous + operand
                            : effect.operator === '-=' ? previous - operand
                                : effect.operator === '*=' ? previous * operand
                                    : effect.operator === '/=' ? previous / operand
                                        : value;
                        setVar(key, result);
                        break;
                    }
                    case 'v2ConsoleLog':
                        foregroundEffects.push({ kind: 'log', value: read(effect, 'source', 'sourceType') });
                        break;
                    case 'cutchat': {
                        const start = Number(render(effect.start));
                        const end = Number(render(effect.end));
                        chat.message = chat.message.slice(start, end);
                        break;
                    }
                    case 'modifychat': {
                        const index = Number(render(effect.index));
                        if (chat.message[index]) chat.message[index].data = render(effect.value);
                        break;
                    }
                    case 'impersonate':
                        chat.message.push({ role: effect.role === 'user' ? 'user' : 'char', data: render(effect.value) });
                        break;
                    case 'sendAIprompt':
                    case 'v2SendAIprompt':
                        if (trigger.lowLevelAccess) resend = true;
                        break;
                    case 'extractRegex': {
                        if (!trigger.lowLevelAccess) break;
                        const source = render(effect.value);
                        const match = new RegExp(effect.regex, effect.flags).exec(source);
                        if (match) setVar(effect.inputVar, effect.result.replace(/\$([0-9]+)/g, (_whole, index) => match[Number(index)] || ''));
                        break;
                    }
                    case 'showAlert': {
                        if (!trigger.lowLevelAccess) break;
                        const message = render(effect.value);
                        if (effect.alertType === 'normal' || effect.alertType === 'error') {
                            foregroundEffects.push({ kind: 'alert', level: effect.alertType, message });
                            break;
                        }
                        const kind = `ui.${effect.alertType}`;
                        const pending = waitFor(`${effectActionPrefix}.${kind}`, kind, {
                            message,
                            options: effect.alertType === 'select' ? message.split('§') : undefined,
                        });
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(effect.inputVar, pending.value);
                        break;
                    }
                    case 'runLLM':
                    case 'runAxLLM': {
                        if (!trigger.lowLevelAccess) break;
                        const prompt = render(effect.value);
                        const kind = effect.type === 'runLLM' ? 'provider.llm' : 'provider.axllm';
                        const provider = effect.type === 'runAxLLM'
                            ? providerFor('otherAx')
                            : providerFor('model');
                        const pending = waitFor(`${effectActionPrefix}.${kind}`, kind, {
                            backend: provider.backend,
                            modelPreset: provider.modelPreset,
                            prompt,
                        });
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(effect.inputVar, pending.value?.result ?? pending.value);
                        break;
                    }
                    case 'runImgGen': {
                        if (!trigger.lowLevelAccess) break;
                        const pending = waitFor(`${effectActionPrefix}.image.generate`, 'image.generate', {
                            prompt: render(effect.value),
                            negativePrompt: render(effect.negValue),
                        });
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(effect.inputVar, pending.value);
                        break;
                    }
                    case 'checkSimilarity': {
                        if (!trigger.lowLevelAccess) break;
                        const pending = waitFor(
                            `${effectActionPrefix}.utility.similarity`,
                            'utility.similarity',
                            {
                                source: render(effect.source),
                                values: render(effect.value).split('§'),
                            },
                        );
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(effect.inputVar, pending.value);
                        break;
                    }
                    case 'command': {
                        const pending = waitFor(`${effectActionPrefix}.ui.command`, 'ui.command', { command: render(effect.value) });
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        break;
                    }
                    case 'v2Command': {
                        const pending = waitFor(
                            `${effectActionPrefix}.ui.command`,
                            'ui.command',
                            { command: read(effect) },
                        );
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        break;
                    }
                    case 'v2ImgGen': {
                        if (!trigger.lowLevelAccess) break;
                        const pending = waitFor(
                            `${effectActionPrefix}.image.generate`,
                            'image.generate',
                            {
                                prompt: read(effect),
                                negativePrompt: read(effect, 'negValue', 'negValueType'),
                            },
                        );
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(outputVar(effect), pending.value || 'null');
                        break;
                    }
                    case 'v2RunLLM': {
                        if (!trigger.lowLevelAccess) break;
                        const mode = effect.model === 'submodel' ? 'submodel' : 'model';
                        const provider = providerFor(mode);
                        const pending = waitFor(
                            `${effectActionPrefix}.provider.llm`,
                            'provider.llm',
                            {
                                backend: provider.backend,
                                modelPreset: provider.modelPreset,
                                prompt: read(effect),
                                mode,
                                options: { streaming: effect.streaming === true },
                            },
                        );
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(
                            outputVar(effect),
                            pending.value?.success === false
                                ? 'null'
                                : pending.value?.result ?? pending.value ?? 'null',
                        );
                        break;
                    }
                    case 'v2ShowAlert':
                        foregroundEffects.push({ kind: 'alert', level: 'normal', message: read(effect) });
                        break;
                    case 'v2GetAlertInput': {
                        const message = read(effect, 'display', 'displayType');
                        const pending = waitFor(
                            `${effectActionPrefix}.ui.input`,
                            'ui.input', { message },
                        );
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(outputVar(effect), pending.value);
                        break;
                    }
                    case 'v2GetAlertSelect': {
                        const message = read(effect, 'display', 'displayType');
                        const values = read(effect).split('|');
                        const pending = waitFor(
                            `${effectActionPrefix}.ui.select`,
                            'ui.select', { message, options: values },
                        );
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(outputVar(effect), pending.value);
                        break;
                    }
                    case 'v2UpdateGUI':
                        foregroundEffects.push({ kind: 'reload.display' });
                        break;
                    case 'v2UpdateChatAt':
                        foregroundEffects.push({ kind: 'reload.chat', index: Number(render(effect.index)) });
                        break;
                    case 'v2Wait':
                        await new Promise(resolve => setTimeout(
                            resolve,
                            Math.min(5000, Math.max(0, Number(read(effect)) || 0)),
                        ));
                        break;
                    case 'v2CheckSimilarity': {
                        if (!trigger.lowLevelAccess) break;
                        const pending = waitFor(
                            `${effectActionPrefix}.utility.similarity`,
                            'utility.similarity',
                            {
                                source: read(effect, 'source', 'sourceType'),
                                values: read(effect).split('§'),
                            },
                        );
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(outputVar(effect), pending.value);
                        break;
                    }
                    case 'v2Tokenize': {
                        const pending = waitFor(
                            `${effectActionPrefix}.utility.tokenize`,
                            'utility.tokenize', { text: read(effect) },
                        );
                        if (!pending.available) return outcome('waiting_client', pending.action);
                        setVar(outputVar(effect), pending.value);
                        break;
                    }
                    case 'v2GetCharacterDesc':
                        setVar(outputVar(effect), character.desc ?? '');
                        break;
                    case 'v2SetCharacterDesc':
                        character.desc = read(effect);
                        markCharacterMutation('desc');
                        break;
                    case 'v2GetPersonaDesc':
                        setVar(
                            outputVar(effect),
                            database.personaPrompt
                                || database.personas?.[database.selectedPersona]?.personaPrompt
                                || '',
                        );
                        break;
                    case 'v2SetPersonaDesc': {
                        const value = read(effect);
                        database.personaPrompt = value;
                        if (database.personas?.[database.selectedPersona]) {
                            database.personas[database.selectedPersona].personaPrompt = value;
                            markDatabaseMutation('personas');
                        }
                        markDatabaseMutation('personaPrompt');
                        break;
                    }
                    case 'v2GetReplaceGlobalNote':
                        setVar(outputVar(effect), character.replaceGlobalNote ?? '');
                        break;
                    case 'v2SetReplaceGlobalNote':
                        character.replaceGlobalNote = read(effect);
                        markCharacterMutation('replaceGlobalNote');
                        break;
                    case 'v2GetLorebookCount':
                    case 'v2GetLorebookCountNew':
                        setVar(outputVar(effect), character.globalLore?.length || 0);
                        break;
                    case 'v2GetAllLorebooks':
                        setVar(
                            outputVar(effect),
                            JSON.stringify((character.globalLore || []).map(lore => (
                                lore?.content ?? lore?.[1] ?? ''
                            ))),
                        );
                        break;
                    case 'v2GetLorebook': {
                        const name = read(effect, 'target', 'targetType');
                        const lore = (character.globalLore || []).find(item => (
                            (item?.comment ?? item?.[0]) === name
                        ));
                        setVar(outputVar(effect), lore?.content ?? lore?.[1] ?? 'null');
                        break;
                    }
                    case 'v2ModifyLorebook': {
                        const name = read(effect, 'target', 'targetType');
                        const lore = (character.globalLore || []).find(item => (
                            (item?.comment ?? item?.[0]) === name
                        ));
                        if (lore) {
                            if (Array.isArray(lore)) lore[1] = read(effect);
                            else lore.content = read(effect);
                            markCharacterMutation('globalLore');
                        }
                        break;
                    }
                    case 'v2GetLorebookEntry':
                    case 'v2GetLorebookByIndex': {
                        const lore = (character.globalLore || [])[Number(read(effect, 'index', 'indexType'))];
                        setVar(outputVar(effect), lore?.content ?? lore?.[1] ?? 'null');
                        break;
                    }
                    case 'v2GetLorebookIndexViaName':
                        setVar(
                            outputVar(effect),
                            (character.globalLore || []).findIndex(item => (
                                (item?.comment ?? item?.[0]) === read(effect, 'name', 'nameType')
                            )),
                        );
                        break;
                    case 'v2GetLorebookByName': {
                        const regex = new RegExp(read(effect, 'name', 'nameType'), 'i');
                        const indices = [];
                        for (const [index, lore] of (character.globalLore || []).entries()) {
                            if (regex.test(lore?.comment ?? lore?.[0] ?? '')) indices.push(index);
                        }
                        setVar(outputVar(effect), JSON.stringify(indices));
                        break;
                    }
                    case 'v2CreateLorebook':
                        character.globalLore ||= [];
                        character.globalLore.push({
                            key: read(effect, 'key', 'keyType'),
                            secondkey: '',
                            insertorder: Number(read(effect, 'insertOrder', 'insertOrderType')) || 100,
                            comment: read(effect, 'name', 'nameType'),
                            content: read(effect, 'content', 'contentType'),
                            mode: 'normal',
                            alwaysActive: false,
                            selective: false,
                        });
                        markCharacterMutation('globalLore');
                        break;
                    case 'v2ModifyLorebookByIndex': {
                        const index = Number(read(effect, 'index', 'indexType'));
                        const lore = character.globalLore?.[index];
                        if (!lore || Array.isArray(lore)) break;
                        lore.comment = read(effect, 'name', 'nameType')
                            .replace(/{{slot}}/g, lore.comment || '');
                        lore.key = read(effect, 'key', 'keyType')
                            .replace(/{{slot}}/g, lore.key || '');
                        lore.content = read(effect, 'content', 'contentType')
                            .replace(/{{slot}}/g, lore.content || '');
                        const order = Number(read(effect, 'insertOrder', 'insertOrderType')
                            .replace(/{{slot}}/g, String(lore.insertorder || 100)));
                        if (!Number.isNaN(order)) lore.insertorder = order;
                        markCharacterMutation('globalLore');
                        break;
                    }
                    case 'v2DeleteLorebookByIndex': {
                        const index = Number(read(effect, 'index', 'indexType'));
                        if (Number.isInteger(index) && character.globalLore?.[index]) {
                            character.globalLore.splice(index, 1);
                            markCharacterMutation('globalLore');
                        }
                        break;
                    }
                    case 'v2SetLorebookActivation':
                    case 'v2SetLorebookAlwaysActive': {
                        const index = Number(read(effect, 'index', 'indexType'));
                        const lore = character.globalLore?.[index];
                        if (lore) {
                            if (Array.isArray(lore)) lore[2] = effect.value;
                            else lore.alwaysActive = effect.value;
                            markCharacterMutation('globalLore');
                        }
                        break;
                    }
                    case 'runtrigger':
                    case 'v2RunTrigger': {
                        if (recursionDepth >= 10 && !trigger.lowLevelAccess) break;
                        const target = effect.type === 'runtrigger'
                            ? render(effect.value)
                            : render(effect.target);
                        const nested = await executeRevenantOutputTriggers({
                            recipe: { ...recipe, character, database },
                            chat,
                            text: options.text,
                            responses,
                            manualName: target,
                            recursionDepth: recursionDepth + 1,
                            actionPrefix: `${effectActionPrefix}.manual`,
                        });
                        chat = nested.chat;
                        resend ||= nested.resend === true;
                        foregroundEffects.push(...(nested.foregroundEffects || []));
                        errors.push(...(nested.errors || []));
                        if (nested.mutations?.character) {
                            mutations.character = {
                                ...(mutations.character || {}),
                                ...nested.mutations.character,
                            };
                            Object.assign(character, structuredClone(nested.mutations.character));
                        }
                        if (nested.mutations?.database) {
                            mutations.database = {
                                ...(mutations.database || {}),
                                ...nested.mutations.database,
                            };
                            Object.assign(database, structuredClone(nested.mutations.database));
                        }
                        if (nested.status === 'waiting_client') {
                            return outcome('waiting_client', nested.action);
                        }
                        break;
                    }
                    case 'systemprompt':
                    case 'v2SystemPrompt':
                    case 'v2StopPromptSending':
                        // These only affect prompt construction and have no effect
                        // after a terminal model response has been produced.
                        break;
                    case 'v2GetDisplayState':
                    case 'v2SetDisplayState':
                    case 'v2GetRequestState':
                    case 'v2SetRequestState':
                    case 'v2GetRequestStateRole':
                    case 'v2SetRequestStateRole':
                    case 'v2GetRequestStateLength':
                        // The browser executor stops a trigger when a mode-specific
                        // state operation is encountered in the wrong mode.
                        effectIndex = effects.length;
                        break;
                    case 'stop':
                        // stop only suppresses prompt dispatch. At output time the
                        // model response is already terminal, so later effects run.
                        break;
                    default:
                        // Pure v2 operations are progressively handled by the shared
                        // headless executor; browser-only effects are surfaced rather
                        // than silently mutating canonical state differently.
                        errors.push(`Unsupported server output trigger effect: ${effect.type}`);
                }
            }
            catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
    }

    return outcome('completed');
}

module.exports = { executeRevenantOutputTriggers, passesConditions };
