'use strict';

const { installRevenantWorkflowRoutes } = require('./routes/workflowRoutes.cjs');
const { installRevenantJobRoutes } = require('./routes/jobRoutes.cjs');

function installRevenantGenerationRoutes(app, deps) {
    installRevenantWorkflowRoutes(app, deps);
    installRevenantJobRoutes(app, deps);
}

module.exports = { installRevenantGenerationRoutes };
