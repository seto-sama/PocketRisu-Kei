'use strict';

let zipPromise;

function getZip() {
    if (!zipPromise) {
        zipPromise = import('@zip.js/zip.js/lib/zip-core-custom.js').then(zip => {
            zip.configure({ useWebWorkers: false, useCompressionStream: true });
            return zip;
        });
    }
    return zipPromise;
}

module.exports = { getZip };
