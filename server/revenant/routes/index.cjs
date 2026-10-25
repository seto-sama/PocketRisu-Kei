'use strict';

const { installRevenantWorkflowRoutes } = require('./workflowRoutes.cjs');
const { installRevenantJobRoutes } = require('./jobRoutes.cjs');

function installRevenantGenerationRoutes(app, deps) {
    installRevenantWorkflowRoutes(app, deps);
    installRevenantJobRoutes(app, deps);
}

module.exports = {
    installRevenantGenerationRoutes,
    ...require('./imageRoutes.cjs'),
};
