// @vitest-environment node
import { describe, expect, it } from 'vitest'
import timingPkg from './generationTiming.cjs'

const {
    applyRevenantStageTimingToMessage,
    resolveRevenantStageTiming,
} = timingPkg as {
    applyRevenantStageTimingToMessage: (
        message: any,
        workflow: any,
        modelCompletedAt?: number,
    ) => void
    resolveRevenantStageTiming: (
        workflow: any,
        generationInfo?: any,
        modelCompletedAt?: number,
    ) => any
}

function step(key: string, startedAt?: number, completedAt?: number) {
    return { key, startedAt, completedAt }
}

function workflow() {
    return {
        steps: [
            step('memory.hypav3'),
            step('model.main', 2_000, 8_500),
            step('output.transform', 8_100, 8_120),
            step('trigger.output', 8_150, 8_180),
            step('igp'),
            step('postprocess', 8_200, 8_240),
        ],
    }
}

describe('Revenant generation timing', () => {
    it('combines client preprocessing with durable server timings', () => {
        expect(resolveRevenantStageTiming(workflow(), {
            stageTiming: { stage1: 120, stage2: 0, stage3: 0, stage4: 0 },
        }, 8_000)).toEqual({
            stage1: 120,
            stage2: 0,
            stage3: 6_000,
            stage4: 90,
        })
    })

    it('finalizes message and selected swipe metadata together', () => {
        const message = {
            swipeId: 1,
            generationInfo: {
                generationId: 'generation-2',
                inputTokens: 5_539,
                outputTokens: 8_000,
                maxContext: 88_000,
                stageTiming: { stage1: 120, stage2: 0, stage3: 0, stage4: 0 },
            },
            swipeMetadata: [
                { generationInfo: { generationId: 'generation-1' } },
                { generationInfo: { generationId: 'generation-2' } },
            ],
        }

        applyRevenantStageTimingToMessage(message, workflow(), 8_000)

        expect(message.generationInfo.stageTiming).toEqual({
            stage1: 120,
            stage2: 0,
            stage3: 6_000,
            stage4: 90,
        })
        expect(message.swipeMetadata[1].generationInfo).toEqual(message.generationInfo)
        expect(message.swipeMetadata[1].generationInfo).not.toBe(message.generationInfo)
        expect(message.swipeMetadata[0].generationInfo).toEqual({ generationId: 'generation-1' })
    })
})
