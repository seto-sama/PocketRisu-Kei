'use strict';

const { webcrypto } = require('node:crypto');
const { fetchWithRequestTimeout } = require('../../../shared/requestTimeout.mjs');

const ACCOUNT_BACKUP_KEY_URL = 'https://sv.risuai.xyz/cryptokey';
const KEY_LOOKUP_TIMEOUT_MS = 30_000;

function backupError(code, detail) {
    const error = new Error(detail);
    error.code = code;
    return error;
}

/** OriginalRisu's web-account backup format. The marker may follow the DB.
 * No account credentials or backup content are sent to the key service.
 */
async function decryptAccountBackup(database, marker, { fetchImpl = globalThis.fetch } = {}) {
    let metadata;
    try { metadata = JSON.parse(marker.toString('utf8')); } catch { /* validated below */ }
    if (metadata?.type !== 'account' || !Number.isSafeInteger(metadata.time) || metadata.time <= 0) {
        throw backupError('BACKUP_ENCRYPTION_METADATA_INVALID', 'Backup encryption metadata is invalid or unsupported.');
    }

    let keyString;
    try {
        const url = new URL(ACCOUNT_BACKUP_KEY_URL);
        url.searchParams.set('key', String(metadata.time));
        const response = await fetchWithRequestTimeout(signal => fetchImpl(url, {
            signal, redirect: 'error', headers: { accept: 'application/json' },
        }), { firstResponseTimeoutMs: KEY_LOOKUP_TIMEOUT_MS, idleTimeoutMs: KEY_LOOKUP_TIMEOUT_MS });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (typeof data?.key !== 'string' || data.key.length === 0) throw new Error('Invalid key response');
        keyString = data.key;
    } catch (error) {
        // Never include the service's body or key in logs/errors.
        const detail = /^HTTP \d+$/.test(error?.message) ? ` (${error.message})` : '';
        throw backupError('BACKUP_ENCRYPTION_KEY_UNAVAILABLE',
            `Could not retrieve the backup decryption key from RisuAI${detail}. Try again later or export a partial backup from OriginalRisu.`);
    }

    try {
        const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(keyString));
        const key = await webcrypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt']);
        return Buffer.from(await webcrypto.subtle.decrypt({
            name: 'AES-GCM', iv: new Uint8Array(12),
        }, key, database));
    } catch {
        throw backupError('BACKUP_DECRYPTION_FAILED',
            'Backup decryption failed. The key may not match or the backup may be damaged.');
    }
}

module.exports = { decryptAccountBackup };
