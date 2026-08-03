'use strict';

const path = require('path');
const { executeRevenantLua } = require('./luaExecutor.cjs');

require('sucrase/register/ts');
const { renderRevenantTemplate } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'headlessParser.ts',
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

function effectValue(effect, recipe, chat, field = 'value') {
    return renderRevenantTemplate(String(effect[field] ?? ''), recipe, chat).text;
}

function actionResult(responses, actionId, action) {
    if (Object.prototype.hasOwnProperty.call(responses, actionId)) return { available: true, value: responses[actionId] };
    return { available: false, action: { schemaVersion: 1, actionId, ...action } };
}

async function executeRevenantOutputTriggers(options) {
    const { recipe, responses = {} } = options;
    let chat = structuredClone(options.chat || recipe.chat);
    const foregroundEffects = [];
    const errors = [];
    let resend = false;
    const triggers = [
        ...(recipe.character.triggerscript || []),
        ...(recipe.moduleTriggers || []),
    ];

    const waitFor = (actionId, kind, payload) => {
        return actionResult(responses, actionId, { kind, payload });
    };

    for (const [triggerIndex, trigger] of triggers.entries()) {
        const lua = trigger.effect?.[0]?.type === 'triggerlua';
        if (!lua && trigger.type !== 'output') continue;
        if (!passesConditions(trigger, recipe, chat)) continue;
        for (const [effectIndex, effect] of (trigger.effect || []).entries()) {
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
                            actionNamespace: `trigger.${triggerIndex}.${effectIndex}`,
                        });
                        foregroundEffects.push(...result.foregroundEffects);
                        if (result.status === 'waiting_client') return {
                            status: 'waiting_client', action: result.action, chat, resend, foregroundEffects, errors,
                        };
                        chat = result.chat;
                        if (result.stopped) return { status: 'completed', chat, resend, foregroundEffects, errors };
                        break;
                    }
                    case 'setvar': {
                        const key = effectValue(effect, recipe, chat, 'var');
                        const value = effectValue(effect, recipe, chat);
                        const parsedPrevious = Number(triggerVar(chat, recipe, key));
                        const previous = Number.isNaN(parsedPrevious) ? 0 : parsedPrevious;
                        const operand = Number(value);
                        const result = effect.operator === '+=' ? previous + operand
                            : effect.operator === '-=' ? previous - operand
                                : effect.operator === '*=' ? previous * operand
                                    : effect.operator === '/=' ? previous / operand
                                        : value;
                        setTriggerVar(chat, key, result);
                        break;
                    }
                    case 'v2SetVar': {
                        const key = effectValue(effect, recipe, chat, 'var');
                        const value = effect.valueType === 'var'
                            ? triggerVar(chat, recipe, effectValue(effect, recipe, chat))
                            : effectValue(effect, recipe, chat);
                        const parsedPrevious = Number(triggerVar(chat, recipe, key));
                        const previous = Number.isNaN(parsedPrevious) ? 0 : parsedPrevious;
                        const operand = Number(value);
                        const result = effect.operator === '+=' ? previous + operand
                            : effect.operator === '-=' ? previous - operand
                                : effect.operator === '*=' ? previous * operand
                                    : effect.operator === '/=' ? previous / operand
                                        : effect.operator === '%=' ? previous % operand
                                            : value;
                        setTriggerVar(chat, key, result);
                        break;
                    }
                    case 'cutchat': {
                        const start = Number(effectValue(effect, recipe, chat, 'start'));
                        const end = Number(effectValue(effect, recipe, chat, 'end'));
                        chat.message = chat.message.slice(start, end);
                        break;
                    }
                    case 'modifychat': {
                        const index = Number(effectValue(effect, recipe, chat, 'index'));
                        if (chat.message[index]) chat.message[index].data = effectValue(effect, recipe, chat);
                        break;
                    }
                    case 'impersonate':
                        chat.message.push({ role: effect.role === 'user' ? 'user' : 'char', data: effectValue(effect, recipe, chat) });
                        break;
                    case 'sendAIprompt':
                    case 'v2SendAIprompt':
                        if (trigger.lowLevelAccess) resend = true;
                        break;
                    case 'extractRegex': {
                        const source = effectValue(effect, recipe, chat);
                        const match = new RegExp(effect.regex, effect.flags).exec(source);
                        if (match) setTriggerVar(chat, effect.inputVar, effect.result.replace(/\$([0-9]+)/g, (_whole, index) => match[Number(index)] || ''));
                        break;
                    }
                    case 'showAlert': {
                        if (!trigger.lowLevelAccess) break;
                        const message = effectValue(effect, recipe, chat);
                        if (effect.alertType === 'normal' || effect.alertType === 'error') {
                            foregroundEffects.push({ kind: 'alert', level: effect.alertType, message });
                            break;
                        }
                        const kind = `ui.${effect.alertType}`;
                        const pending = waitFor(`trigger.${triggerIndex}.${effectIndex}.${kind}`, kind, {
                            message,
                            options: effect.alertType === 'select' ? message.split('§') : undefined,
                        });
                        if (!pending.available) return { status: 'waiting_client', action: pending.action, chat, resend, foregroundEffects, errors };
                        setTriggerVar(chat, effect.inputVar, pending.value);
                        break;
                    }
                    case 'runLLM':
                    case 'runAxLLM': {
                        if (!trigger.lowLevelAccess) break;
                        const prompt = effectValue(effect, recipe, chat);
                        const kind = effect.type === 'runLLM' ? 'provider.llm' : 'provider.axllm';
                        const pending = waitFor(`trigger.${triggerIndex}.${effectIndex}.${kind}`, kind, {
                            backend: recipe.providerBackend,
                            modelPreset: recipe.modelPreset,
                            prompt,
                        });
                        if (!pending.available) return { status: 'waiting_client', action: pending.action, chat, resend, foregroundEffects, errors };
                        setTriggerVar(chat, effect.inputVar, pending.value?.result ?? pending.value);
                        break;
                    }
                    case 'runImgGen': {
                        if (!trigger.lowLevelAccess) break;
                        const pending = waitFor(`trigger.${triggerIndex}.${effectIndex}.image.generate`, 'image.generate', {
                            prompt: effectValue(effect, recipe, chat),
                            negativePrompt: effectValue(effect, recipe, chat, 'negValue'),
                        });
                        if (!pending.available) return { status: 'waiting_client', action: pending.action, chat, resend, foregroundEffects, errors };
                        setTriggerVar(chat, effect.inputVar, pending.value);
                        break;
                    }
                    case 'command': {
                        const pending = waitFor(`trigger.${triggerIndex}.${effectIndex}.ui.command`, 'ui.command', { command: effectValue(effect, recipe, chat) });
                        if (!pending.available) return { status: 'waiting_client', action: pending.action, chat, resend, foregroundEffects, errors };
                        break;
                    }
                    case 'stop':
                    case 'v2StopTrigger':
                        return { status: 'completed', chat, resend, foregroundEffects, errors };
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

    return { status: 'completed', chat, resend, foregroundEffects, errors };
}

module.exports = { executeRevenantOutputTriggers, passesConditions };
