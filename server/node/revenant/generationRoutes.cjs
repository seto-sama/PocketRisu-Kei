'use strict';

const { installRevenantWorkflowRoutes } = require('./generationWorkflowRoutes.cjs');
const { installRevenantJobRoutes } = require('./generationJobRoutes.cjs');

function installRevenantGenerationRoutes(app, deps) {
    installRevenantWorkflowRoutes(app, deps);
    installRevenantJobRoutes(app, deps);
}

module.exports = { installRevenantGenerationRoutes };
