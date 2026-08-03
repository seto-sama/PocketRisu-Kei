'use strict';

const UNREGISTERED_WORKFLOW_TIMEOUT_MS = 30_000;

function hasRegisteredMainJob(jobs) {
    return jobs.some(job => job?.jobType === 'model');
}

function isUnregisteredWorkflowExpired(workflow, jobs, now = Date.now()) {
    return !hasRegisteredMainJob(jobs)
        && now - workflow.createdAt >= UNREGISTERED_WORKFLOW_TIMEOUT_MS;
}

function findReusableActiveMainJob(jobs, request) {
    if (
        request.jobType !== 'model'
        || !request.workflowId
        || request.workflowStepKey !== 'model.main'
    ) return undefined;
    return jobs.find(job =>
        job.jobType === 'model'
        && job.workflowId === request.workflowId
        && job.workflowStepKey === 'model.main'
        && job.characterId === request.characterId
        && job.roomId === request.roomId
        && ['queued', 'generating'].includes(job.status));
}

module.exports = {
    UNREGISTERED_WORKFLOW_TIMEOUT_MS,
    findReusableActiveMainJob,
    hasRegisteredMainJob,
    isUnregisteredWorkflowExpired,
};
