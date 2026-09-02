export interface AutomaticRerollResult {
    generated: boolean
    toolExecuted: boolean
    detached: boolean
}

export const GENERATION_COUNT_MIN = 1
export const GENERATION_COUNT_MAX = 16

export function normalizeGenerationCount(value: unknown): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return GENERATION_COUNT_MIN
    return Math.min(GENERATION_COUNT_MAX, Math.max(GENERATION_COUNT_MIN, Math.floor(parsed)))
}

/** Runs the same main reroll action sequentially for the remaining generation count. */
export async function runAutomaticRerolls(
    totalGenerationCount: number,
    reroll: () => Promise<AutomaticRerollResult>,
): Promise<void> {
    const count = normalizeGenerationCount(totalGenerationCount)
    for (let index = 1; index < count; index += 1) {
        const result = await reroll()
        if (!result.generated || result.detached || result.toolExecuted) break
    }
}
