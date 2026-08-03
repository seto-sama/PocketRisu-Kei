'use strict';

const path = require('path');
const crypto = require('crypto');
const { executeRevenantLua } = require('./luaExecutor.cjs');

require('sucrase/register/ts');
const { renderRevenantTemplate } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'headlessParser.ts',
));
const { calculateExpression } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'calculate.ts',
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

function asArray(value) {
    try {
        const parsed = JSON.parse(String(value));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch { return []; }
}

function asObject(value) {
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch { return {}; }
}

function deterministicInteger(seed, min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    const low = Math.min(Math.trunc(min), Math.trunc(max));
    const high = Math.max(Math.trunc(min), Math.trunc(max));
    const value = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
    return low + (value % (high - low + 1));
}

function compareV2(left, operator, right) {
    switch (operator) {
        case '=':
            return !Number.isNaN(Number(left)) && !Number.isNaN(Number(right))
                ? Number(left) === Number(right) : left === right;
        case '!=':
            return !Number.isNaN(Number(left)) && !Number.isNaN(Number(right))
                ? Number(left) !== Number(right) : left !== right;
        case '>': return Number(left) > Number(right);
        case '<': return Number(left) < Number(right);
        case '>=': return Number(left) >= Number(right);
        case '<=': return Number(left) <= Number(right);
        case '∈':
            try { return asArray(right).includes(left); } catch { return false; }
        case '∋':
            try { return asArray(left).includes(right); } catch { return false; }
        case '∉':
            try { return !asArray(right).includes(left); } catch { return true; }
        case '∌':
            try { return !asArray(left).includes(right); } catch { return true; }
        case '≒': {
            const leftNumber = Number(left);
            const rightNumber = Number(right);
            return Number.isNaN(leftNumber) || Number.isNaN(rightNumber)
                ? left.toLocaleLowerCase().replace(/ /g, '') === right.toLocaleLowerCase().replace(/ /g, '')
                : Math.abs(leftNumber - rightNumber) < 0.0001;
        }
        case '≡':
            if (right === 'true') return left === 'true' || left === '1';
            if (right === 'false') return !(left === 'true' || left === '1');
            return left === right;
        default: return false;
    }
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
        const loopCounts = {};
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
                    case 'v2SetVar': {
                        const key = render(effect.var);
                        const value = read(effect);
                        const parsedPrevious = Number(getVar(key));
                        const previous = Number.isNaN(parsedPrevious) ? 0 : parsedPrevious;
                        const operand = Number(value);
                        const result = effect.operator === '+=' ? previous + operand
                            : effect.operator === '-=' ? previous - operand
                                : effect.operator === '*=' ? previous * operand
                                    : effect.operator === '/=' ? previous / operand
                                        : effect.operator === '%=' ? previous % operand
                                            : value;
                        setVar(key, result);
                        break;
                    }
                    case 'v2Header':
                    case 'v2Comment':
                    case 'v2Loop':
                    case 'v2LoopNTimes':
                        break;
                    case 'v2DeclareLocalVar':
                        declareLocal(render(effect.var), read(effect), currentIndent);
                        break;
                    case 'v2If':
                    case 'v2IfAdvanced': {
                        const source = effect.type === 'v2If' || effect.sourceType === 'var'
                            ? getVar(render(effect.source))
                            : render(effect.source);
                        const target = read(effect, 'target', 'targetType');
                        if (!compareV2(String(source), effect.condition, String(target))) {
                            const bodyIndent = currentIndent + 1;
                            for (; effectIndex < effects.length; effectIndex++) {
                                const candidate = effects[effectIndex];
                                if (candidate?.type !== 'v2EndIndent' || candidate.indent !== bodyIndent) continue;
                                const next = effects[effectIndex + 1];
                                if (next?.type === 'v2Else' && next.indent === currentIndent) effectIndex += 1;
                                break;
                            }
                        }
                        break;
                    }
                    case 'v2Else': {
                        const bodyIndent = currentIndent + 1;
                        for (; effectIndex < effects.length; effectIndex++) {
                            const candidate = effects[effectIndex];
                            if (candidate?.type === 'v2EndIndent' && candidate.indent === bodyIndent) break;
                        }
                        break;
                    }
                    case 'v2EndIndent': {
                        if (effect.endOfLoop) {
                            const loopIndent = currentIndent - 1;
                            const endIndex = effectIndex;
                            for (let index = effectIndex - 1; index >= 0; index--) {
                                const candidate = effects[index];
                                if (!['v2Loop', 'v2LoopNTimes'].includes(candidate?.type)
                                    || candidate.indent !== loopIndent) continue;
                                if (candidate.type === 'v2LoopNTimes') {
                                    const limit = Number(read(candidate));
                                    loopCounts[index] = (loopCounts[index] || 0) + 1;
                                    if (!Number.isFinite(limit) || loopCounts[index] >= Math.max(0, limit)) {
                                        effectIndex = endIndex;
                                    }
                                    else effectIndex = index;
                                }
                                else effectIndex = index;
                                break;
                            }
                        }
                        clearLocals(currentIndent);
                        break;
                    }
                    case 'v2BreakLoop':
                        for (; effectIndex < effects.length; effectIndex++) {
                            const candidate = effects[effectIndex];
                            if (candidate?.type === 'v2EndIndent' && candidate.endOfLoop) break;
                        }
                        break;
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
                    case 'v2CutChat': {
                        const start = Number(read(effect, 'start', 'startType'));
                        const end = Number(read(effect, 'end', 'endType'));
                        chat.message = chat.message.slice(
                            Number.isNaN(start) ? 0 : start,
                            Number.isNaN(end) ? chat.message.length : end,
                        );
                        break;
                    }
                    case 'v2ModifyChat': {
                        const index = Number(read(effect, 'index', 'indexType'));
                        if (chat.message[index]) chat.message[index].data = read(effect);
                        break;
                    }
                    case 'v2Impersonate':
                        chat.message.push({
                            role: effect.role === 'user' ? 'user' : 'char',
                            data: read(effect),
                        });
                        break;
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
                    case 'v2ExtractRegex': {
                        const source = read(effect);
                        const pattern = read(effect, 'regex', 'regexType');
                        const flags = read(effect, 'flags', 'flagsType');
                        const format = read(effect, 'result', 'resultType');
                        const match = new RegExp(pattern, flags).exec(source);
                        const result = format
                            .replace(/\$([0-9]+)/g, (_whole, index) => match?.[Number(index)] || '')
                            .replace(/\$&/g, match?.[0] || '')
                            .replace(/\$\$/g, '$');
                        setVar(outputVar(effect), result);
                        break;
                    }
                    case 'v2RegexTest': {
                        let matched = false;
                        try {
                            matched = new RegExp(
                                read(effect, 'regex', 'regexType'),
                                read(effect, 'flags', 'flagsType'),
                            ).test(read(effect));
                        }
                        catch { /* Invalid patterns are false, matching the browser executor. */ }
                        setVar(outputVar(effect), matched ? '1' : '0');
                        break;
                    }
                    case 'v2ReplaceString': {
                        const source = read(effect, 'source', 'sourceType');
                        try {
                            const format = read(effect, 'result', 'resultType');
                            const replacement = read(effect, 'replacement', 'replacementType');
                            const regex = new RegExp(
                                read(effect, 'regex', 'regexType'),
                                read(effect, 'flags', 'flagsType'),
                            );
                            const result = source.replace(regex, (...args) => {
                                const match = args[0];
                                const groups = args.slice(1, -2);
                                const target = format.match(/^\$(\d+)$/);
                                if (target) {
                                    const index = Number(target[1]);
                                    if (index === 0) return replacement;
                                    if (groups[index - 1]) return match.replace(groups[index - 1], replacement);
                                }
                                return format
                                    .replace(/\$([0-9]+)/g, (_whole, index) => (
                                        Number(index) === 0 ? match : groups[Number(index) - 1] || ''
                                    ))
                                    .replace(/\$&/g, match)
                                    .replace(/\$\$/g, '$');
                            });
                            setVar(outputVar(effect), result);
                        }
                        catch { setVar(outputVar(effect), source); }
                        break;
                    }
                    case 'v2Random': {
                        const minimum = Number(read(effect, 'min', 'minType'));
                        const maximum = Number(read(effect, 'max', 'maxType'));
                        const seed = [
                            recipe.messageChatId || chat.id || '', triggerIndex, effectIndex,
                            effectVisits[effectIndex], minimum, maximum,
                        ].join(':');
                        setVar(outputVar(effect), deterministicInteger(seed, minimum, maximum));
                        break;
                    }
                    case 'v2GetLastMessage':
                        setVar(outputVar(effect), chat.message.at(-1)?.data ?? 'null');
                        break;
                    case 'v2GetMessageAtIndex':
                        setVar(
                            outputVar(effect),
                            chat.message[Number(read(effect, 'index', 'indexType'))]?.data ?? 'null',
                        );
                        break;
                    case 'v2GetMessageCount':
                        setVar(outputVar(effect), chat.message.length);
                        break;
                    case 'v2GetLastUserMessage':
                        setVar(
                            outputVar(effect),
                            chat.message.findLast(message => message?.role === 'user')?.data ?? 'null',
                        );
                        break;
                    case 'v2GetLastCharMessage':
                        setVar(
                            outputVar(effect),
                            chat.message.findLast(message => message?.role === 'char')?.data ?? 'null',
                        );
                        break;
                    case 'v2GetFirstMessage':
                        setVar(
                            outputVar(effect),
                            chat.fmIndex === -1
                                ? character.firstMessage ?? ''
                                : character.alternateGreetings?.[chat.fmIndex] ?? character.firstMessage ?? '',
                        );
                        break;
                    case 'v2GetCharAt':
                        setVar(
                            outputVar(effect),
                            read(effect, 'source', 'sourceType')[Number(read(effect, 'index', 'indexType'))]
                                ?? 'null',
                        );
                        break;
                    case 'v2GetCharCount':
                        setVar(outputVar(effect), read(effect, 'source', 'sourceType').length);
                        break;
                    case 'v2ToLowerCase':
                        setVar(outputVar(effect), read(effect, 'source', 'sourceType').toLocaleLowerCase());
                        break;
                    case 'v2ToUpperCase':
                        setVar(outputVar(effect), read(effect, 'source', 'sourceType').toLocaleUpperCase());
                        break;
                    case 'v2SetCharAt': {
                        const source = [...read(effect, 'source', 'sourceType')];
                        source[Number(read(effect, 'index', 'indexType'))] = read(effect);
                        setVar(outputVar(effect), source.join(''));
                        break;
                    }
                    case 'v2ConcatString':
                        setVar(
                            outputVar(effect),
                            read(effect, 'source1', 'source1Type')
                                + read(effect, 'source2', 'source2Type'),
                        );
                        break;
                    case 'v2QuickSearchChat': {
                        const value = read(effect);
                        const depth = Number(read(effect, 'depth', 'depthType'));
                        const source = chat.message
                            .slice(Number.isNaN(depth) ? 0 : -Math.max(0, depth))
                            .map(message => message?.data || '').join(' ');
                        let found = false;
                        if (effect.condition === 'strict') found = source.split(' ').includes(value);
                        else if (effect.condition === 'regex') found = new RegExp(value).test(source);
                        else found = source.toLocaleLowerCase().includes(value.toLocaleLowerCase());
                        setVar(outputVar(effect), found ? '1' : '0');
                        break;
                    }
                    case 'v2GetAuthorNote':
                        setVar(outputVar(effect), chat.note ?? '');
                        break;
                    case 'v2SetAuthorNote':
                        chat.note = read(effect);
                        break;
                    case 'v2SplitString': {
                        const source = read(effect, 'source', 'sourceType');
                        const delimiter = read(effect, 'delimiter', 'delimiterType');
                        if (effect.delimiterType !== 'regex') {
                            setVar(outputVar(effect), JSON.stringify(source.split(delimiter)));
                            break;
                        }
                        try {
                            const literal = delimiter.match(/^\/(.+)\/([gimuy]*)$/);
                            const regex = literal
                                ? new RegExp(literal[1], literal[2])
                                : new RegExp(delimiter);
                            setVar(outputVar(effect), JSON.stringify(source.split(regex)));
                        }
                        catch { setVar(outputVar(effect), JSON.stringify([source])); }
                        break;
                    }
                    case 'v2JoinArrayVar':
                        setVar(
                            outputVar(effect),
                            asArray(read(effect, 'var', 'varType'))
                                .join(read(effect, 'delimiter', 'delimiterType')),
                        );
                        break;
                    case 'v2MakeArrayVar': {
                        const key = render(effect.var);
                        if (!key.startsWith('[') || !key.endsWith(']')) setVar(key, '[]');
                        break;
                    }
                    case 'v2GetArrayVarLength':
                        setVar(outputVar(effect), asArray(getVar(render(effect.var))).length);
                        break;
                    case 'v2GetArrayVar': {
                        const array = asArray(getVar(render(effect.var)));
                        setVar(
                            outputVar(effect),
                            array[Number(read(effect, 'index', 'indexType'))] ?? 'null',
                        );
                        break;
                    }
                    case 'v2SetArrayVar': {
                        const key = render(effect.var);
                        const array = asArray(getVar(key));
                        const index = Number(read(effect, 'index', 'indexType'));
                        if (!Number.isNaN(index)) {
                            array[index] = read(effect);
                            setVar(key, JSON.stringify(array));
                        }
                        break;
                    }
                    case 'v2PushArrayVar': {
                        const key = render(effect.var);
                        const array = asArray(getVar(key));
                        array.push(read(effect));
                        setVar(key, JSON.stringify(array));
                        break;
                    }
                    case 'v2PopArrayVar': {
                        const key = render(effect.var);
                        const array = asArray(getVar(key));
                        setVar(outputVar(effect), array.pop() ?? 'null');
                        setVar(key, JSON.stringify(array));
                        break;
                    }
                    case 'v2ShiftArrayVar': {
                        const key = render(effect.var);
                        const array = asArray(getVar(key));
                        setVar(outputVar(effect), array.shift() ?? 'null');
                        setVar(key, JSON.stringify(array));
                        break;
                    }
                    case 'v2UnshiftArrayVar': {
                        const key = render(effect.var);
                        const array = asArray(getVar(key));
                        array.unshift(read(effect));
                        setVar(key, JSON.stringify(array));
                        break;
                    }
                    case 'v2SpliceArrayVar': {
                        const key = render(effect.var);
                        const array = asArray(getVar(key));
                        array.splice(Number(read(effect, 'start', 'startType')) || 0, 0, read(effect, 'item', 'itemType'));
                        setVar(key, JSON.stringify(array));
                        break;
                    }
                    case 'v2SliceArrayVar':
                        setVar(
                            outputVar(effect),
                            JSON.stringify(asArray(getVar(render(effect.var))).slice(
                                Number(read(effect, 'start', 'startType')) || 0,
                                Number(read(effect, 'end', 'endType')) || 0,
                            )),
                        );
                        break;
                    case 'v2GetIndexOfValueInArrayVar':
                        setVar(
                            outputVar(effect),
                            asArray(getVar(render(effect.var))).indexOf(read(effect)),
                        );
                        break;
                    case 'v2RemoveIndexFromArrayVar': {
                        const key = render(effect.var);
                        const array = asArray(getVar(key));
                        array.splice(Number(read(effect, 'index', 'indexType')) || 0, 1);
                        setVar(key, JSON.stringify(array));
                        break;
                    }
                    case 'v2MakeDictVar': {
                        const key = render(effect.var);
                        if (!key.startsWith('{') || !key.endsWith('}')) setVar(key, '{}');
                        break;
                    }
                    case 'v2GetDictVar': {
                        const dictionary = asObject(read(effect, 'var', 'varType'));
                        setVar(outputVar(effect), dictionary[read(effect, 'key', 'keyType')] ?? 'null');
                        break;
                    }
                    case 'v2SetDictVar': {
                        if (effect.varType === 'value') break;
                        const key = render(effect.var);
                        const dictionary = asObject(getVar(key));
                        dictionary[read(effect, 'key', 'keyType')] = read(effect);
                        setVar(key, JSON.stringify(dictionary));
                        break;
                    }
                    case 'v2DeleteDictKey': {
                        if (effect.varType === 'value') break;
                        const key = render(effect.var);
                        const dictionary = asObject(getVar(key));
                        delete dictionary[read(effect, 'key', 'keyType')];
                        setVar(key, JSON.stringify(dictionary));
                        break;
                    }
                    case 'v2HasDictKey':
                        setVar(
                            outputVar(effect),
                            Object.hasOwn(
                                asObject(read(effect, 'var', 'varType')),
                                read(effect, 'key', 'keyType'),
                            ) ? '1' : '0',
                        );
                        break;
                    case 'v2ClearDict': {
                        const key = render(effect.var);
                        if (!key.startsWith('{') || !key.endsWith('}')) setVar(key, '{}');
                        break;
                    }
                    case 'v2GetDictSize':
                        setVar(
                            outputVar(effect),
                            Object.keys(asObject(read(effect, 'var', 'varType'))).length,
                        );
                        break;
                    case 'v2GetDictKeys':
                        setVar(
                            outputVar(effect),
                            JSON.stringify(Object.keys(asObject(read(effect, 'var', 'varType')))),
                        );
                        break;
                    case 'v2GetDictValues':
                        setVar(
                            outputVar(effect),
                            JSON.stringify(Object.values(asObject(read(effect, 'var', 'varType')))),
                        );
                        break;
                    case 'v2Calculate': {
                        let expression = read(effect, 'expression', 'expressionType');
                        expression = expression.replace(/\$([a-zA-Z0-9_]+)/g, (_whole, key) => {
                            const value = Number.parseFloat(getVar(key));
                            return Number.isNaN(value) ? '0' : String(value);
                        });
                        try {
                            setVar(outputVar(effect), calculateExpression(expression, {
                                chat: getVar,
                                global: key => database.globalChatVariables?.[key] ?? 'null',
                            }));
                        }
                        catch { setVar(outputVar(effect), '0'); }
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
                    case 'v2StopTrigger':
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
