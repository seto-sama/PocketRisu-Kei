import type { triggerEffect, triggerEffectV2, triggerscript } from './triggers'
import { migrateTriggerV1ToV2 } from './triggerV1Migration'

const deprecatedTypeList = [
    'v2If',
    'v2ModifyLorebook',
    'v2GetLorebook',
    'v2GetLorebookCount',
    'v2GetLorebookEntry',
    'v2SetLorebookActivation',
    'v2GetLorebookIndexViaName',
] as const
type DeprecatedTriggerV2Type = typeof deprecatedTypeList[number]
type DeprecatedTriggerV2Effect = Extract<triggerEffectV2, { type: DeprecatedTriggerV2Type }>

const deprecatedTypes: ReadonlySet<string> = new Set(deprecatedTypeList)
const preserveLorebookField = '{{slot}}'

function isDeprecatedTriggerV2Effect(effect: triggerEffect): effect is DeprecatedTriggerV2Effect {
    return deprecatedTypes.has(effect.type)
}

function temporaryVar(triggerIndex: number, effectIndex: number, suffix: string): string {
    return `__risu_deprecated_v2_${triggerIndex}_${effectIndex}_${suffix}`
}

function findFirstLorebookIndexBlocks(
    effect: Extract<DeprecatedTriggerV2Effect, {
        type: 'v2GetLorebook' | 'v2ModifyLorebook' | 'v2GetLorebookIndexViaName'
    }>,
    triggerIndex: number,
    effectIndex: number,
): {
    effects: triggerEffectV2[]
    indexVar: string
    bodyIndent: number
} {
    const indent = effect.indent
    const matchesVar = temporaryVar(triggerIndex, effectIndex, 'matches')
    const indexVar = temporaryVar(triggerIndex, effectIndex, 'index')
    const name = effect.type === 'v2GetLorebookIndexViaName' ? effect.name : effect.target
    const nameType = effect.type === 'v2GetLorebookIndexViaName' ? effect.nameType : effect.targetType

    return {
        indexVar,
        bodyIndent: indent + 1,
        effects: [{
            type: 'v2DeclareLocalVar', var: matchesVar,
            value: '[]', valueType: 'value', indent,
        }, {
            type: 'v2DeclareLocalVar', var: indexVar,
            value: 'null', valueType: 'value', indent,
        }, {
            type: 'v2GetLorebookByName',
            name, nameType, outputVar: matchesVar, indent,
        }, {
            type: 'v2GetArrayVar', var: matchesVar,
            index: '0', indexType: 'value', outputVar: indexVar, indent,
        }, {
            type: 'v2IfAdvanced',
            source: indexVar, sourceType: 'var',
            target: 'null', targetType: 'value', condition: '!=', indent,
        }],
    }
}

function migrateDeprecatedEffect(
    effect: DeprecatedTriggerV2Effect,
    triggerIndex: number,
    effectIndex: number,
): triggerEffectV2[] {
    switch (effect.type) {
        case 'v2If':
            return [{ ...effect, type: 'v2IfAdvanced', sourceType: 'var' }]
        case 'v2GetLorebookCount':
            return [{ ...effect, type: 'v2GetLorebookCountNew' }]
        case 'v2GetLorebookEntry':
            return [{ ...effect, type: 'v2GetLorebookByIndex' }]
        case 'v2SetLorebookActivation':
            return [{ ...effect, type: 'v2SetLorebookAlwaysActive' }]
        case 'v2GetLorebookIndexViaName': {
            const lookup = findFirstLorebookIndexBlocks(effect, triggerIndex, effectIndex)
            return [{
                type: 'v2SetVar', operator: '=', var: effect.outputVar,
                value: '-1', valueType: 'value', indent: effect.indent,
            }, ...lookup.effects, {
                type: 'v2SetVar', operator: '=', var: effect.outputVar,
                value: lookup.indexVar, valueType: 'var', indent: lookup.bodyIndent,
            }, {
                type: 'v2EndIndent', indent: lookup.bodyIndent,
            }]
        }
        case 'v2GetLorebook': {
            const lookup = findFirstLorebookIndexBlocks(effect, triggerIndex, effectIndex)
            return [{
                type: 'v2SetVar', operator: '=', var: effect.outputVar,
                value: 'null', valueType: 'value', indent: effect.indent,
            }, ...lookup.effects, {
                type: 'v2GetLorebookByIndex',
                index: lookup.indexVar, indexType: 'var',
                outputVar: effect.outputVar, indent: lookup.bodyIndent,
            }, {
                type: 'v2EndIndent', indent: lookup.bodyIndent,
            }]
        }
        case 'v2ModifyLorebook': {
            const lookup = findFirstLorebookIndexBlocks(effect, triggerIndex, effectIndex)
            return [...lookup.effects, {
                type: 'v2ModifyLorebookByIndex',
                index: lookup.indexVar,
                indexType: 'var',
                name: preserveLorebookField,
                nameType: 'value',
                key: preserveLorebookField,
                keyType: 'value',
                content: effect.value,
                contentType: effect.valueType,
                insertOrder: preserveLorebookField,
                insertOrderType: 'value',
                indent: lookup.bodyIndent,
            }, {
                type: 'v2EndIndent', indent: lookup.bodyIndent,
            }]
        }
    }
}

export function hasDeprecatedTriggerV2(triggers: triggerscript[]): boolean {
    return triggers.some(trigger => trigger.effect.some(isDeprecatedTriggerV2Effect))
}

/** Converts deprecated Trigger V2 effects to programs composed only of current V2 effects. */
export function migrateDeprecatedTriggerV2(triggers: triggerscript[]): triggerscript[] {
    let migrated: triggerscript[] | null = null

    for (const [triggerIndex, trigger] of triggers.entries()) {
        let effects: triggerEffect[] | null = null

        for (const [effectIndex, effect] of trigger.effect.entries()) {
            if (isDeprecatedTriggerV2Effect(effect)) {
                effects ??= trigger.effect.slice(0, effectIndex)
                effects.push(...migrateDeprecatedEffect(effect, triggerIndex, effectIndex))
            } else if (effects) {
                effects.push(effect)
            }
        }

        if (effects) {
            migrated ??= triggers.slice(0, triggerIndex)
            migrated.push({ ...trigger, effect: effects })
        } else if (migrated) {
            migrated.push(trigger)
        }
    }

    return migrated ?? triggers
}

export function migrateTriggersToCurrentV2(triggers: triggerscript[]): triggerscript[] {
    return migrateDeprecatedTriggerV2(migrateTriggerV1ToV2(triggers))
}
