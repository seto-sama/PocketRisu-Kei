'use strict';

const { binaryBodyParser, decodeBinaryRequest } = require('../../utils/binaryHttp.cjs');
const { encodeAssetBatch, decodeAssetBatch, MAX_ASSET_BATCH_BYTES } = require('../../../src/ts/storage/assetTransport.ts');
const { BINARY_MESSAGE_CONTENT_TYPE } = require('../../../src/ts/network/binaryMessage.ts');

function installAssetBatchRoutes(app, {
    checkAuth, requireSyncClientId, readInlayInfoPayload, kvGet, kvSet, transaction,
}) {
    app.post('/api/assets/bulk-read', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!Array.isArray(req.body) || req.body.some(key => typeof key !== 'string')) {
            res.status(400).send({ error: 'Body must be a JSON array of keys' });
            return;
        }
        const entries = [];
        for (const key of req.body) {
            let value = key.startsWith('inlay_info/')
                ? await readInlayInfoPayload(key.slice('inlay_info/'.length)) : null;
            if (value === null) value = kvGet(key);
            if (value !== null) entries.push({ key, value });
        }
        res.set('content-type', BINARY_MESSAGE_CONTENT_TYPE);
        res.send(Buffer.from(encodeAssetBatch(entries).buffer));
    });

    app.post('/api/assets/bulk-write', binaryBodyParser(MAX_ASSET_BATCH_BYTES), async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const entries = decodeBinaryRequest(req, res, decodeAssetBatch);
        if (!entries) return;
        if (entries.some(entry => entry.key === 'database/database.bin')) {
            res.status(400).json({
                error: 'database.bin cannot be written through the asset API',
                code: 'DATABASE_BIN_PROJECTION_ONLY',
            });
            return;
        }
        transaction(() => {
            for (const { key, value } of entries) kvSet(key, value);
        })();
        res.json({ success: true, count: entries.length });
    });
}

module.exports = { installAssetBatchRoutes };
