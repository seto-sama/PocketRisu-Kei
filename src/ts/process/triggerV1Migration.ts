import type {
    triggerCondition,
    triggerEffect,
    triggerEffectV1,
    triggerEffectV2,
    triggerscript,
} from './triggers'

const legacyEffectTypes = new Set<triggerEffectV1['type']>([
    'setvar',
    'cutchat',
    'modifychat',
    'runImgGen',
    'extractRegex',
    'runLLM',
    'checkSimilarity',
    'sendAIprompt',
    'showAlert',
    'systemprompt',
    'impersonate',
    'command',
    'stop',
    'runtrigger',
    'runAxLLM',
])

function conditionOutputVar(triggerIndex: number, conditionIndex: number): string {
    return `__risu_v1_condition_${triggerIndex}_${conditionIndex}`
}

function migrateCondition(
    condition: triggerCondition,
    indent: number,
    outputVar: string,
): triggerEffectV2[] {
    if (condition.type === 'exists') {
        return [{
            type: 'v2DeclareLocalVar',
            var: outputVar,
            value: 'null',
            valueType: 'value',
            indent,
        }, {
            type: 'v2QuickSearchChat',
            value: condition.value,
            valueType: 'value',
            condition: condition.type2,
            depth: String(condition.depth),
            depthType: 'value',
            outputVar,
            indent,
        }, {
            type: 'v2IfAdvanced',
            source: outputVar,
            sourceType: 'var',
            target: '1',
            targetType: 'value',
            condition: '=',
            indent,
        }]
    }

    if (condition.type === 'chatindex') {
        return [{
            type: 'v2DeclareLocalVar',
            var: outputVar,
            value: 'null',
            valueType: 'value',
            indent,
        }, {
            type: 'v2GetMessageCount',
            outputVar,
            indent,
        }, {
            type: 'v2IfAdvanced',
            source: outputVar,
            sourceType: 'var',
            target: condition.operator === 'true' ? 'true'
                : condition.operator === 'null' ? 'null'
                    : condition.value,
            targetType: 'value',
            condition: condition.operator === 'true' ? '≡'
                : condition.operator === 'null' ? '='
                    : condition.operator,
            indent,
        }]
    }

    return [{
        type: 'v2IfAdvanced',
        source: condition.var,
        sourceType: condition.type === 'var' ? 'var' : 'value',
        target: condition.operator === 'true' ? 'true'
            : condition.operator === 'null' ? 'null'
                : condition.value,
        targetType: 'value',
        condition: condition.operator === 'true' ? '≡'
            : condition.operator === 'null' ? '='
                : condition.operator,
        indent,
    }]
}

function migrateEffect(effect: triggerEffectV1, indent: number): triggerEffectV2 {
    switch (effect.type) {
        case 'setvar':
            return { type: 'v2SetVar', operator: effect.operator, var: effect.var, value: effect.value, valueType: 'value', indent }
        case 'cutchat':
            return { type: 'v2CutChat', start: effect.start, startType: 'value', end: effect.end, endType: 'value', indent }
        case 'modifychat':
            return { type: 'v2ModifyChat', index: effect.index, indexType: 'value', value: effect.value, valueType: 'value', indent }
        case 'runImgGen':
            return { type: 'v2ImgGen', value: effect.value, valueType: 'value', negValue: effect.negValue, negValueType: 'value', outputVar: effect.inputVar, indent }
        case 'extractRegex':
            return {
                type: 'v2ExtractRegex',
                value: effect.value,
                valueType: 'value',
                regex: effect.regex,
                regexType: 'value',
                flags: effect.flags,
                flagsType: 'value',
                result: effect.result,
                resultType: 'value',
                outputVar: effect.inputVar,
                indent,
            }
        case 'runLLM':
            return { type: 'v2RunLLM', value: effect.value, valueType: 'value', model: 'model', streaming: false, outputVar: effect.inputVar, indent }
        case 'runAxLLM':
            return { type: 'v2RunLLM', value: effect.value, valueType: 'value', model: 'submodel', streaming: false, outputVar: effect.inputVar, indent }
        case 'checkSimilarity':
            return { type: 'v2CheckSimilarity', source: effect.source, sourceType: 'value', value: effect.value, valueType: 'value', outputVar: effect.inputVar, indent }
        case 'sendAIprompt':
            return { type: 'v2SendAIprompt', indent }
        case 'showAlert':
            if (effect.alertType === 'input') {
                return { type: 'v2GetAlertInput', display: effect.value, displayType: 'value', outputVar: effect.inputVar, indent }
            }
            if (effect.alertType === 'select') {
                return {
                    type: 'v2GetAlertSelect',
                    display: '',
                    displayType: 'value',
                    value: effect.value.replace(/§/g, '|'),
                    valueType: 'value',
                    outputVar: effect.inputVar,
                    indent,
                }
            }
            return { type: 'v2ShowAlert', value: effect.value, valueType: 'value', indent }
        case 'systemprompt':
            return { type: 'v2SystemPrompt', location: effect.location, value: effect.value, valueType: 'value', indent }
        case 'impersonate':
            return { type: 'v2Impersonate', role: effect.role, value: effect.value, valueType: 'value', indent }
        case 'command':
            return { type: 'v2Command', value: effect.value, valueType: 'value', indent }
        case 'stop':
            return { type: 'v2StopPromptSending', indent }
        case 'runtrigger':
            return { type: 'v2RunTrigger', target: effect.value, indent }
    }
}

function isLegacyEffect(effect: triggerEffect): effect is triggerEffectV1 {
    return legacyEffectTypes.has(effect.type as triggerEffectV1['type'])
}

/**
 * Builds a current Trigger V2 view of persisted V1 triggers for one execution
 * without mutating or persisting the source array.
 */
export function migrateTriggerV1ToV2(triggers: triggerscript[]): triggerscript[] {
    let migrated = triggers.length === 0
    const firstEffectType = triggers[0]?.effect[0]?.type
    const collectionIsV1 = firstEffectType !== 'v2Header'
        && firstEffectType !== 'triggerlua'
        && firstEffectType !== 'triggercode'
    const normalized = triggers.map((trigger, triggerIndex) => {
        const hasLegacyEffects = trigger.effect.some(isLegacyEffect)
        const hasLegacyConditions = trigger.conditions.length > 0
        const isCodeTrigger = trigger.effect.some(effect => effect.type === 'triggerlua' || effect.type === 'triggercode')
        if (isCodeTrigger || (!collectionIsV1 && !hasLegacyEffects && !hasLegacyConditions)) return trigger

        migrated = true
        const effects: triggerEffect[] = []
        let indent = 0
        let conditionCount = 0

        trigger.conditions.forEach((condition, conditionIndex) => {
            effects.push(...migrateCondition(
                condition,
                indent,
                conditionOutputVar(triggerIndex, conditionIndex),
            ))
            indent += 1
            conditionCount += 1
        })

        for (const effect of trigger.effect) {
            effects.push(isLegacyEffect(effect)
                ? migrateEffect(effect, indent)
                : {
                    ...effect,
                    indent: indent + ('indent' in effect && typeof effect.indent === 'number' ? effect.indent : 0),
                } as triggerEffect)
        }

        for (let endIndent = conditionCount; endIndent > 0; endIndent--) {
            effects.push({ type: 'v2EndIndent', indent: endIndent })
        }

        return {
            ...trigger,
            conditions: [],
            effect: effects,
        }
    })

    if (!migrated || normalized[0]?.effect[0]?.type === 'v2Header') {
        return normalized
    }

    return [{
        comment: '',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2Header', code: '', indent: 0 }],
    }, ...normalized]
}

export const migrateTriggerV1ToV2ForRuntime = migrateTriggerV1ToV2
