import type { triggerscript } from "src/ts/storage/database.svelte";

export type TriggerScriptMode = 'v1' | 'v1code' | 'v2' | 'lua';

export function getTriggerScriptMode(value: triggerscript[] | null | undefined): TriggerScriptMode {
    const firstEffectType = value?.[0]?.effect?.[0]?.type;
    if (firstEffectType === 'v2Header') return 'v2';
    if (firstEffectType === 'triggerlua') return 'lua';
    if (firstEffectType === 'triggercode') return 'v1code';
    return 'v1';
}
