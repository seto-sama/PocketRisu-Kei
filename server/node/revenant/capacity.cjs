'use strict';

const { apiErrorMessage, codes } = require('../apiErrors.cjs');

const BASE_REVENANT_CAPACITY = 32;

/**
 * Global Revenant admission and execution capacity.
 * Workflows reserve durable orchestration state; provider jobs consume the
 * more granular outbound execution pool and wait in the durable queue.
 */
const REVENANT_CAPACITY = Object.freeze({
    maxActiveWorkflows: BASE_REVENANT_CAPACITY,
    maxActiveProviderJobs: BASE_REVENANT_CAPACITY * 2,
});

function createCapacityError(code, limit) {
    const error = new Error(apiErrorMessage(code));
    error.code = code;
    error.httpStatus = 429;
    error.details = { limit };
    return error;
}

function createWorkflowCapacityError(capacity = REVENANT_CAPACITY) {
    return createCapacityError(
        codes.REVENANT_WORKFLOW_LIMIT,
        capacity.maxActiveWorkflows,
    );
}

function createProviderCapacityError(capacity = REVENANT_CAPACITY) {
    return createCapacityError(
        codes.REVENANT_PROVIDER_CAPACITY,
        capacity.maxActiveProviderJobs,
    );
}

module.exports = {
    REVENANT_CAPACITY,
    createProviderCapacityError,
    createWorkflowCapacityError,
};
