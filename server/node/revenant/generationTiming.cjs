'use strict';

const OTHER_STEP_KEYS = [
    'output.transform',
    'trigger.output',
    'igp',
    'postprocess',
];

function stepDuration(workflow, stepKey) {
    const step = workflow.steps.find(candidate => candidate.key === stepKey);
    if (
        step?.startedAt === undefined
        || step.completedAt === undefined
        || step.completedAt < step.startedAt
    ) return undefined;
    return step.completedAt - step.startedAt;
}

function resolveRevenantStageTiming(workflow, generationInfo = {}, modelCompletedAt) {
    const previous = generationInfo.stageTiming || {};
    const memoryDuration = stepDuration(workflow, 'memory.hypav3');
    const modelStep = workflow.steps.find(step => step.key === 'model.main');
    const modelDuration = modelStep?.startedAt !== undefined
        && modelCompletedAt !== undefined
        && modelCompletedAt >= modelStep.startedAt
        ? modelCompletedAt - modelStep.startedAt
        : stepDuration(workflow, 'model.main');
    const otherDuration = OTHER_STEP_KEYS.reduce(
        (total, stepKey) => total + (stepDuration(workflow, stepKey) || 0),
        0,
    );

    return {
        stage1: previous.stage1 || 0,
        stage2: memoryDuration ?? previous.stage2 ?? 0,
        stage3: modelDuration ?? previous.stage3 ?? 0,
        stage4: otherDuration || previous.stage4 || 0,
    };
}

function applyRevenantStageTimingToMessage(message, workflow, modelCompletedAt) {
    if (!message.generationInfo) return;
    message.generationInfo = {
        ...message.generationInfo,
        stageTiming: resolveRevenantStageTiming(
            workflow,
            message.generationInfo,
            modelCompletedAt,
        ),
    };

    const metadata = Array.isArray(message.swipeMetadata)
        ? message.swipeMetadata[message.swipeId]
        : undefined;
    if (metadata) metadata.generationInfo = structuredClone(message.generationInfo);
}

module.exports = {
    applyRevenantStageTimingToMessage,
    resolveRevenantStageTiming,
};
