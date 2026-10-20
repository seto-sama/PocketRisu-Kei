'use strict';

const { encode, decode } = require('msgpackr');
const { binaryBodyParser, decodeBinaryRequest } = require('../binaryHttp.cjs');

function installPluginStorageRoutes(app, {
    appDataStore, checkAuth, requireSyncClientId, queueStorageOperation, ensureCanonicalStorage,
}) {
    app.post('/api/plugin-storage/:namespace', async (req, res, next) => {
        try {
            if (await checkAuth(req, res)) next();
        } catch (error) { next(error); }
    }, binaryBodyParser('100mb'), async (req, res, next) => {
        const namespace = req.params.namespace;
        if (namespace !== 'localStorage' && namespace !== 'localForage') {
            return res.status(400).json({ error: 'Unknown plugin storage namespace' });
        }
        const request = decodeBinaryRequest(req, res, decode);
        if (request === undefined) return;
        const operations = ['get', 'set', 'remove', 'clear', 'list', 'import'];
        const validEntry = entry => entry && typeof entry.key === 'string'
            && entry.value instanceof Uint8Array
            && (entry.owner === undefined || typeof entry.owner === 'string');
        if (!request || !operations.includes(request.op)
            || (['get', 'set', 'remove'].includes(request.op) && typeof request.key !== 'string')
            || (request.op === 'set' && !validEntry(request))
            || (request.op === 'import' && (!Array.isArray(request.entries) || !request.entries.every(validEntry)))) {
            return res.status(400).json({ error: 'Invalid plugin storage request' });
        }
        if (!['get', 'list'].includes(request.op) && !requireSyncClientId(req, res)) return;
        try {
            const result = await queueStorageOperation(async () => {
                await ensureCanonicalStorage();
                switch (request.op) {
                    case 'get':
                        return { value: appDataStore.getPluginStorage(namespace, request.key) };
                    case 'list':
                        return { entries: appDataStore.listPluginStorage(namespace) };
                    case 'set':
                        appDataStore.writePluginStorage(namespace, request.key, request.value, request.owner);
                        break;
                    case 'remove':
                        appDataStore.removePluginStorage(namespace, request.key);
                        break;
                    case 'clear':
                        appDataStore.clearPluginStorage(namespace);
                        break;
                    case 'import':
                        appDataStore.importPluginStorage(namespace, request.entries);
                        break;
                }
                return { success: true };
            });
            res.set('Cache-Control', 'no-store').type('application/octet-stream').send(encode(result));
        } catch (error) { next(error); }
    });
}

module.exports = { installPluginStorageRoutes };
