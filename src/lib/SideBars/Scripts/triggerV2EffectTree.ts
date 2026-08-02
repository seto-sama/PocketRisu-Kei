import type { triggerEffect, triggerEffectV2 } from "src/ts/process/triggers";

const blockStartTypes = new Set([
    'v2If',
    'v2IfAdvanced',
    'v2Loop',
    'v2LoopNTimes',
]);

const structuralStartTypes = new Set([
    ...blockStartTypes,
    'v2Else',
]);

const asV2 = (effect: triggerEffect | undefined) => effect as triggerEffectV2 | undefined;

export type TriggerV2BlockRange = { start: number; end: number };
export type TriggerV2ElseBlock = { endIndentIndex: number; elseIndex: number; elseEndIndex: number };

export function isTriggerV2BlockStart(effect: triggerEffect | undefined): boolean {
    return !!effect && blockStartTypes.has(effect.type);
}

export function getTriggerV2BlockRange(effects: triggerEffect[], startIndex: number): TriggerV2BlockRange {
    const startEffect = asV2(effects[startIndex]);
    if (!startEffect || !blockStartTypes.has(startEffect.type)) return { start: startIndex, end: startIndex };

    for (let pointer = startIndex + 1; pointer < effects.length; pointer++) {
        const currentEffect = asV2(effects[pointer]);
        if (currentEffect?.type !== 'v2EndIndent' || currentEffect.indent !== startEffect.indent + 1) continue;

        let end = pointer;
        const possibleElse = asV2(effects[pointer + 1]);
        if (possibleElse?.type === 'v2Else' && possibleElse.indent === startEffect.indent) {
            for (let elsePointer = pointer + 2; elsePointer < effects.length; elsePointer++) {
                const elseEffect = asV2(effects[elsePointer]);
                if (elseEffect?.type === 'v2EndIndent' && elseEffect.indent === startEffect.indent + 1) {
                    end = elsePointer;
                    break;
                }
            }
        }
        return { start: startIndex, end };
    }

    return { start: startIndex, end: startIndex };
}

export function getTriggerV2ElseBlock(effects: triggerEffect[], effectIndex: number): TriggerV2ElseBlock | null {
    const effect = asV2(effects[effectIndex]);
    if (!effect || (effect.type !== 'v2If' && effect.type !== 'v2IfAdvanced')) return null;

    const endIndentIndex = effects.findIndex((candidate, index) => {
        const candidateV2 = asV2(candidate);
        return index > effectIndex && candidateV2?.type === 'v2EndIndent' && candidateV2.indent === effect.indent + 1;
    });
    if (endIndentIndex === -1) return { endIndentIndex, elseIndex: -1, elseEndIndex: -1 };

    const possibleElse = asV2(effects[endIndentIndex + 1]);
    const elseIndex = possibleElse?.type === 'v2Else' && possibleElse.indent === effect.indent
        ? endIndentIndex + 1
        : -1;
    const elseEndIndex = elseIndex === -1
        ? -1
        : effects.findIndex((candidate, index) => {
            const candidateV2 = asV2(candidate);
            return index > elseIndex && candidateV2?.type === 'v2EndIndent' && candidateV2.indent === effect.indent + 1;
        });

    return { endIndentIndex, elseIndex, elseEndIndex };
}

export function toggleTriggerV2Else(effects: triggerEffect[], effectIndex: number, enabled: boolean): triggerEffect[] {
    const effect = asV2(effects[effectIndex]);
    const block = getTriggerV2ElseBlock(effects, effectIndex);
    if (!effect || !block) return effects;

    const next = [...effects];
    if (enabled && block.elseIndex === -1 && block.endIndentIndex !== -1) {
        next.splice(block.endIndentIndex + 1, 0,
            { type: 'v2Else', indent: effect.indent },
            { type: 'v2EndIndent', indent: effect.indent + 1 });
    } else if (!enabled && block.elseIndex !== -1 && block.elseEndIndex !== -1) {
        next.splice(block.elseIndex, block.elseEndIndex - block.elseIndex + 1);
    }
    return next;
}

export function appendTriggerV2Effect(effects: triggerEffect[], effect: triggerEffectV2): triggerEffect[] {
    const next = [...effects, effect];
    if (structuralStartTypes.has(effect.type)) {
        next.push({
            type: 'v2EndIndent',
            indent: effect.indent + 1,
            endOfLoop: effect.type === 'v2Loop' || effect.type === 'v2LoopNTimes',
        });
    }
    return next;
}

export function removeTriggerV2Effect(effects: triggerEffect[], effectIndex: number): triggerEffect[] {
    const effect = asV2(effects[effectIndex]);
    if (!effect || effect.type === 'v2EndIndent') return effects;
    if (!structuralStartTypes.has(effect.type)) return effects.filter((_, index) => index !== effectIndex);

    const end = effect.type === 'v2Else'
        ? effects.findIndex((candidate, index) => {
            const candidateV2 = asV2(candidate);
            return index > effectIndex && candidateV2?.type === 'v2EndIndent' && candidateV2.indent === effect.indent + 1;
        })
        : getTriggerV2BlockRange(effects, effectIndex).end;
    if (end <= effectIndex) return effects.filter((_, index) => index !== effectIndex);

    const flattened = effects.slice(effectIndex + 1, end + 1)
        .filter((candidate) => {
            const candidateV2 = asV2(candidate);
            return !(candidateV2?.type === 'v2EndIndent' && candidateV2.indent === effect.indent + 1)
                && !(candidateV2?.type === 'v2Else' && candidateV2.indent === effect.indent);
        })
        .map((candidate) => {
            const candidateV2 = asV2(candidate);
            return candidateV2
                ? { ...candidateV2, indent: candidateV2.indent - 1 } as triggerEffect
                : candidate;
        });

    return [...effects.slice(0, effectIndex), ...flattened, ...effects.slice(end + 1)];
}

export function getTriggerV2InsertIndent(effects: triggerEffect[], insertIndex: number): number {
    if (insertIndex === 0 || effects.length === 0) return 0;
    if (insertIndex >= effects.length) {
        const lastEffect = asV2(effects.at(-1));
        return lastEffect?.type === 'v2EndIndent' ? lastEffect.indent - 1 : (lastEffect?.indent ?? 0);
    }

    const targetEffect = asV2(effects[insertIndex]);
    const previousEffect = asV2(effects[insertIndex - 1]);
    if (!targetEffect) return 0;
    if (targetEffect.type === 'v2EndIndent' || targetEffect.type === 'v2Else') return targetEffect.indent;
    if (previousEffect && blockStartTypes.has(previousEffect.type)) return previousEffect.indent + 1;
    if (previousEffect?.type === 'v2Else') return previousEffect.indent + 1;
    if (previousEffect?.type === 'v2EndIndent') return previousEffect.indent - 1;
    return previousEffect?.indent ?? targetEffect.indent;
}

export function canMoveTriggerV2Effect(effects: triggerEffect[], fromIndex: number, toIndex: number): boolean {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= effects.length || toIndex > effects.length) return false;
    const fromEffect = asV2(effects[fromIndex]);
    if (!fromEffect || fromEffect.type === 'v2EndIndent' || fromEffect.type === 'v2Else') return false;

    if (blockStartTypes.has(fromEffect.type)) {
        const blockRange = getTriggerV2BlockRange(effects, fromIndex);
        if (toIndex > blockRange.start && toIndex <= blockRange.end + 1) return false;
    }

    const targetEffect = asV2(effects[toIndex]);
    const previousEffect = asV2(effects[toIndex - 1]);
    if (targetEffect?.type === 'v2Else' && previousEffect?.type === 'v2EndIndent') return false;

    const targetIndent = getTriggerV2InsertIndent(effects, toIndex);
    return targetIndent >= 0 && targetIndent <= 10;
}

export function moveTriggerV2Effect(effects: triggerEffect[], fromIndex: number, toIndex: number): triggerEffect[] {
    if (!canMoveTriggerV2Effect(effects, fromIndex, toIndex)) return effects;
    const next = [...effects];
    const fromEffect = asV2(next[fromIndex]);
    if (!fromEffect) return effects;
    const targetIndent = getTriggerV2InsertIndent(effects, toIndex);

    if (blockStartTypes.has(fromEffect.type)) {
        const blockRange = getTriggerV2BlockRange(effects, fromIndex);
        const movedBlock = next.splice(blockRange.start, blockRange.end - blockRange.start + 1)
            .map((effect) => ({ ...effect }) as triggerEffect);
        const adjustedToIndex = blockRange.start < toIndex ? toIndex - movedBlock.length : toIndex;
        const indentDifference = targetIndent - (asV2(movedBlock[0])?.indent ?? 0);
        for (const movedEffect of movedBlock) {
            const movedEffectV2 = asV2(movedEffect);
            if (movedEffectV2) movedEffectV2.indent += indentDifference;
        }
        next.splice(adjustedToIndex, 0, ...movedBlock);
        return next;
    }

    const [sourceEffect] = next.splice(fromIndex, 1);
    const movedEffect = { ...sourceEffect } as triggerEffect;
    const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
    const movedEffectV2 = asV2(movedEffect);
    if (movedEffectV2) movedEffectV2.indent = targetIndent;
    next.splice(adjustedToIndex, 0, movedEffect);
    return next;
}
