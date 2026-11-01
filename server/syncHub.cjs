'use strict';

const { codes: API_ERROR_CODES, sendApiError } = require('./utils/apiErrors.cjs');

// Each page has an opaque client id. It is not a write lock: this is a
// single-user server, so every authenticated page may submit mutations. The id
// is retained to suppress self-echoes on the sync WebSocket.

function getSyncClientIdFromRequest(req) {
    return req?.headers?.['x-sync-client-id'] || req?.headers?.['x-session-id'] || ''
}

function requireSyncClientId(req, res) {
    if (!getSyncClientIdFromRequest(req)) {
        sendApiError(res, 400, API_ERROR_CODES.SYNC_CLIENT_ID_REQUIRED)
        return false
    }
    return true
}

function connectedDevice(userAgent = '') {
    if (/Windows/i.test(userAgent)) return { name: 'Windows', type: 'desktop' }
    if (/iPhone|iPad|iPod/i.test(userAgent)) return { name: 'iPhone/iPad', type: 'mobile' }
    if (/Android/i.test(userAgent)) return { name: 'Android', type: 'mobile' }
    if (/Macintosh|Mac OS X/i.test(userAgent)) return { name: 'macOS', type: 'desktop' }
    if (/Linux/i.test(userAgent)) return { name: 'Linux', type: 'desktop' }
    return { name: 'Unknown device', type: 'desktop' }
}

function createSyncHub() {
    const syncClients = new Map();
    const syncClientDevices = new Map();

    function isSyncClientConnected(clientId) {
        return Boolean(clientId && syncClients.get(clientId)?.size);
    }

    function broadcastSync(type, payload = {}, excludeClientId = null) {
        const message = JSON.stringify({ type, ...payload });
        for (const [clientId, clients] of syncClients) {
            if (clientId === excludeClientId) continue;
            for (const ws of clients) {
                if (ws.readyState === 1) ws.send(message);
            }
        }
    }

    function broadcastDatabaseInvalidated(req, payload = {}) {
        broadcastSync(
            'database-invalidated',
            { ...payload, timestamp: Date.now() },
            String(getSyncClientIdFromRequest(req)),
        );
    }

    function broadcastBookmarksInvalidated(req) {
        broadcastSync(
            'bookmarks-invalidated',
            { timestamp: Date.now() },
            String(getSyncClientIdFromRequest(req)),
        );
    }

    function publishChatCommitted(event, originClientId) {
        broadcastSync('database-invalidated', {
            chats: [{ characterId: event.characterId, chatId: event.chatId }],
            chatEtag: event.etag,
            reason: event.reason,
            timestamp: Date.now(),
        }, originClientId || null);
    }

    function broadcastRevenantWorkflowUpdated(workflow) {
        if (!workflow?.workflowId || !workflow.characterId || !workflow.roomId) return;
        broadcastSync('generation-workflow-updated', {
            workflowId: workflow.workflowId,
            characterId: workflow.characterId,
            roomId: workflow.roomId,
            status: workflow.status,
            timestamp: Date.now(),
        });
    }

    function handleSyncConnection(ws, req, clientId) {
        const clients = syncClients.get(clientId) ?? new Set();
        clients.add(ws);
        syncClients.set(clientId, clients);
        if (!syncClientDevices.has(clientId)) {
            syncClientDevices.set(clientId, {
                connectedAt: Date.now(),
                device: connectedDevice(req.headers['user-agent'] || ''),
            });
        }
        ws.send(JSON.stringify({ type: 'sync-ready', timestamp: Date.now() }));

        const pingTimer = setInterval(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }, 30_000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            const current = syncClients.get(clientId);
            if (!current) return;
            current.delete(ws);
            if (current.size === 0) {
                syncClients.delete(clientId);
                syncClientDevices.delete(clientId);
            }
        });
        ws.on('error', () => clearInterval(pingTimer));
    }

    return {
        syncClientDevices,
        isSyncClientConnected,
        broadcastDatabaseInvalidated,
        broadcastBookmarksInvalidated,
        publishChatCommitted,
        broadcastRevenantWorkflowUpdated,
        handleSyncConnection,
    };
}

module.exports = { createSyncHub, getSyncClientIdFromRequest, requireSyncClientId };
