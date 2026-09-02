import {
    createTriggerV2Core,
    type TriggerV2CoreAdapter,
    type TriggerV2Effect,
    type TriggerV2MutationPatch,
} from '../../triggerV2Core'
import {
    buildTriggerAction,
    canExecuteTriggerAction,
    normalizeTriggerActionResult,
    type TriggerTypedAction,
} from '../../triggerActionCore'

export type RevenantTriggerEffectContext = {
    effectIndex: number
    visit: number
}

export type RevenantUnhandledEffectResult = {
    stop?: boolean
}

export type RevenantTriggerRuntimeOptions = {
    effects: TriggerV2Effect[]
    core: Omit<TriggerV2CoreAdapter, 'effects'>
    lowLevelAccess: boolean
    executeAction: (
        action: TriggerTypedAction,
        context: RevenantTriggerEffectContext,
    ) => Promise<unknown>
    shouldStopAfterAction?: (result: unknown) => boolean
    executeUnhandled?: (
        effect: TriggerV2Effect,
        context: RevenantTriggerEffectContext,
    ) => Promise<RevenantUnhandledEffectResult | void>
    shouldExecute?: (effect: TriggerV2Effect) => boolean
    onIndent?: (indent: number) => void
    onMutations?: (mutations: TriggerV2MutationPatch) => void
    onLoopYield?: () => Promise<void>
    onError?: (
        error: unknown,
        effect: TriggerV2Effect,
        context: RevenantTriggerEffectContext,
    ) => void
}

/**
 * Environment-neutral Trigger V2 program runner. Browser and server hosts only
 * provide effect adapters; block flow, permissions and output normalization
 * remain identical in both environments.
 */
export async function runRevenantTriggerProgram(options: RevenantTriggerRuntimeOptions): Promise<void> {
    const core = createTriggerV2Core({ effects: options.effects, ...options.core })
    const visits: Record<number, number> = {}
    let loopIterations = 0

    for (let effectIndex = 0; effectIndex < options.effects.length; effectIndex++) {
        const effect = options.effects[effectIndex]
        if (!effect || (options.shouldExecute && !options.shouldExecute(effect))) continue

        const indent = Number.isInteger(effect.indent) && Number(effect.indent) >= 0
            ? Number(effect.indent)
            : 0
        options.onIndent?.(indent)

        const visit = visits[effectIndex] = (visits[effectIndex] || 0) + 1
        const context = { effectIndex, visit }
        if (visit > 10_000) throw new Error(`Trigger loop limit exceeded at effect ${effectIndex}`)

        try {
            const coreStep = core.step(effectIndex)
            if (coreStep.handled) {
                effectIndex = coreStep.nextIndex
                if (coreStep.mutations) options.onMutations?.(coreStep.mutations)
                if (coreStep.looped && options.onLoopYield && ++loopIterations > 100) {
                    await options.onLoopYield()
                    loopIterations = 0
                }
                if (coreStep.stop) break
                continue
            }

            const action = buildTriggerAction(effect, {
                read: core.read,
                render: options.core.render,
                outputVar: core.outputVar,
            })
            if (action) {
                if (!canExecuteTriggerAction(action, options.lowLevelAccess)) continue
                const result = await options.executeAction(action, context)
                if (options.shouldStopAfterAction?.(result)) break
                if (action.outputVar) {
                    options.core.setVar(
                        action.outputVar,
                        normalizeTriggerActionResult(action, result),
                    )
                }
                continue
            }

            const unhandled = await options.executeUnhandled?.(effect, context)
            if (unhandled && unhandled.stop) break
        }
        catch (error) {
            if (!options.onError) throw error
            options.onError(error, effect, context)
        }
    }
}
