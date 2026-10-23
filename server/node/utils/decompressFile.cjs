'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function decompressFile(compressedPath, destination) {
    const isZip = compressedPath.endsWith('.zip');
    const options = { timeout: 300_000 };
    try {
        await execFileAsync('tar', [isZip ? '-xf' : '-xzf', compressedPath, '-C', destination], options);
    } catch (error) {
        if (!isZip || process.platform !== 'win32') throw error;
        // Windows installations without tar can still extract release ZIPs.
        const quote = value => `'${value.replaceAll("'", "''")}'`;
        await execFileAsync('powershell', ['-NoProfile', '-Command',
            `Expand-Archive -Force -LiteralPath ${quote(compressedPath)} -DestinationPath ${quote(destination)}`,
        ], options);
    }
}

module.exports = { decompressFile };
