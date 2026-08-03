'use strict';

const generationDb = require('./generationDb.cjs');

module.exports = {
    generationDb,
    ...generationDb,
    ...require('./generationConfig.cjs'),
    ...require('./generationJournal.cjs'),
    ...require('./generationProjection.cjs'),
    ...require('./generationRoutes.cjs'),
    ...require('./generationStream.cjs'),
    ...require('./generationWorkers.cjs'),
    ...require('./generationWorkflowService.cjs'),
    ...require('./materializer.cjs'),
    ...require('./postprocessWorker.cjs'),
};
