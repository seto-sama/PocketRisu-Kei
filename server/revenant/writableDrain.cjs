'use strict';

/** Resolves when a writer that refused more data has drained. */
function waitForDrain(writer) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            writer.off('drain', onDrain);
            writer.off('error', onError);
        };
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        writer.once('drain', onDrain);
        writer.once('error', onError);
    });
}

module.exports = { waitForDrain };
