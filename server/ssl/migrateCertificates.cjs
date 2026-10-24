'use strict';

const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

async function migrateCertificates(appDir) {
    const destination = path.join(appDir, 'server', 'ssl', 'certificate');
    const source = path.join(appDir, 'server', 'node', 'ssl', 'certificate');
    if (!existsSync(destination) && existsSync(source)) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(source, destination);
    }
    return destination;
}

module.exports = { migrateCertificates };
