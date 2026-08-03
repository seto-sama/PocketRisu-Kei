'use strict';

const path = require('path');
const { executeRevenantLua } = require('./luaExecutor.cjs');
const { executeRevenantOutputTriggers } = require('./triggerExecutor.cjs');

require('sucrase/register/ts');
const { runRevenantOutputTransform } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'postprocess', 'postprocess.ts',
));
const { renderRevenantTemplate } = require(path.join(
    __dirname, '..', '..', '..', 'src', 'ts', 'process', 'revenant', 'postprocess', 'headlessParser.ts',
));

function renderRevenantPostprocessPrompt(prompt, recipe, chat) {
    return renderRevenantTemplate(String(prompt ?? ''), recipe, chat).text;
}

function outputLuaScripts(recipe) {
    return [
        ...(recipe.character?.triggerscript || []),
        ...(recipe.moduleTriggers || []),
    ].flatMap((trigger, triggerIndex) => {
        const effect = trigger?.effect?.[0];
        return effect?.type === 'triggerlua' && typeof effect.code === 'string'
            ? [{ code: effect.code, triggerIndex }]
            : [];
    });
}

function createGeneratedMessage(job, recipe, text, current = {}) {
    return {
        ...structuredClone(current),
        role: 'char',
        data: text,
        saying: recipe.character.chaId,
        time: job.completedAt || job.updatedAt || Date.now(),
        generationInfo: job.generationInfo,
        promptInfo: job.promptInfo,
        chatId: recipe.messageChatId,
    };
}

function applyGeneratedMessage(chat, recipe, job, text) {
    const result = structuredClone(chat);
    const snapshot = recipe.rerollSnapshot;
    let targetIndex = result.message.findIndex(message => message?.chatId === recipe.messageChatId);
    if (targetIndex < 0 && recipe.isContinuation) {
        for (let index = result.message.length - 1; index >= 0; index--) {
            if (result.message[index]?.role === 'char') {
                targetIndex = index;
                break;
            }
        }
    }

    if (snapshot) {
        const previousSwipes = Array.isArray(snapshot.targetMessage?.swipes)
            ? [...snapshot.targetMessage.swipes]
            : [snapshot.targetMessage?.data ?? ''];
        const message = createGeneratedMessage(job, recipe, text, {
            ...snapshot.targetMessage,
            swipes: [...previousSwipes, text],
            swipeId: previousSwipes.length,
        });
        const insertAt = targetIndex >= 0 ? targetIndex : Math.max(0, snapshot.targetIndex);
        result.message.splice(
            insertAt,
            Math.max(0, result.message.length - insertAt),
            message,
            ...structuredClone(snapshot.trailingMessages || []),
        );
    }
    else {
        const current = targetIndex >= 0 ? result.message[targetIndex] : undefined;
        const message = createGeneratedMessage(job, recipe, text, current);
        if (targetIndex >= 0) result.message[targetIndex] = message;
        else result.message.push(message);
    }
    result.isStreaming = false;
    return result;
}

async function runRevenantOutputStage(options) {
    const recipe = structuredClone(options.recipe);
    const responses = options.responses || {};
    let text = options.text;
    let chat = structuredClone(recipe.chat);
    const foregroundEffects = [];
    const errors = [];
    const mutations = {};

    const mergeMutations = patch => {
        if (patch?.character) {
            mutations.character = { ...(mutations.character || {}), ...patch.character };
            Object.assign(recipe.character, structuredClone(patch.character));
        }
        if (patch?.database) {
            mutations.database = { ...(mutations.database || {}), ...patch.database };
            Object.assign(recipe.database, structuredClone(patch.database));
        }
    };

    for (const script of outputLuaScripts(recipe)) {
        try {
            const result = await executeRevenantLua({
                code: script.code,
                mode: 'editOutput',
                data: text,
                recipe,
                chat,
                responses,
                lowLevelAccess: false,
                meta: { index: recipe.messageChatId },
                actionNamespace: `edit-output.${script.triggerIndex}`,
            });
            foregroundEffects.push(...result.foregroundEffects);
            mergeMutations(result.mutations);
            if (result.status === 'waiting_client') {
                return {
                    status: 'waiting_client', action: result.action, foregroundEffects, errors,
                    ...(Object.keys(mutations).length > 0 ? { mutations } : {}),
                };
            }
            text = result.data;
            chat = result.chat;
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }

    const transformed = await options.transformOutput(text, recipe, chat);
    foregroundEffects.push(...transformed.foregroundEffects);
    errors.push(...transformed.errors);
    const assetNames = [
        ...(recipe.character.additionalAssets || []).map(asset => asset?.[0]),
        ...(recipe.modules || []).flatMap(module => (
            Array.isArray(module?.assets) ? module.assets.map(asset => asset?.[0]) : []
        )),
    ].filter(name => typeof name === 'string' && name.length > 0);
    if (recipe.database.dynamicAssets && assetNames.length > 0) {
        const actionId = 'output.dynamic-assets';
        const response = responses[actionId];
        if (response === undefined) {
            return {
                status: 'waiting_client',
                action: {
                    schemaVersion: 1,
                    actionId,
                    kind: 'utility.dynamic-assets',
                    payload: { text: transformed.text, assetNames },
                },
                foregroundEffects,
                errors,
                ...(Object.keys(mutations).length > 0 ? { mutations } : {}),
            };
        }
        if (typeof response === 'string') transformed.text = response;
        else throw new Error('Dynamic asset resolver returned an invalid response');
    }
    chat = applyGeneratedMessage(transformed.chat, recipe, options.job, transformed.text);
    return {
        status: 'completed',
        text: transformed.text,
        chat,
        foregroundEffects,
        errors,
        ...(Object.keys(mutations).length > 0 ? { mutations } : {}),
    };
}

async function runRevenantTriggerStage(options) {
    return executeRevenantOutputTriggers({
        recipe: structuredClone(options.recipe),
        chat: structuredClone(options.chat),
        text: options.text,
        responses: options.responses || {},
    });
}

module.exports = {
    applyGeneratedMessage,
    runRevenantOutputStage,
    runRevenantTriggerStage,
    runRevenantOutputTransform,
    renderRevenantPostprocessPrompt,
};
