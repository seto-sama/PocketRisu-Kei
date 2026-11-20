'use strict';

const { CLIPBOARD_TEXT_LIMIT } = require('../clipboardStore.cjs');

function installClipboardRoutes(app, {
    checkAuth,
    clipboardStore,
    isPrivacyGuardActive,
    requireSyncClientId,
    broadcastClipboardInvalidated,
}) {
    const CLIPBOARD_API_PATH = '/api/clipboard';
    const scope = () => ({ guarded: isPrivacyGuardActive() });

    function respondChanged(req, res) {
        broadcastClipboardInvalidated(req);
        res.json(clipboardStore.list(scope()));
    }

    app.get(CLIPBOARD_API_PATH, async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.json(clipboardStore.list(scope()));
    });

    app.post(CLIPBOARD_API_PATH, async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const text = req.body?.text;
        if (typeof text !== 'string' || !text) {
            return res.status(400).json({ error: 'Clipboard text is required' });
        }
        if (text.length > CLIPBOARD_TEXT_LIMIT) {
            return res.status(413).json({ error: 'Clipboard text is too large' });
        }
        // Visibility follows the projection the text was copied from, not when the POST
        // lands: an unguarded copy can arrive after another device turned the guard on.
        clipboardStore.add(text, { guarded: isPrivacyGuardActive() && req.body?.copiedUnderGuard === true });
        respondChanged(req, res);
    });

    app.patch(`${CLIPBOARD_API_PATH}/:id`, async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        if (!clipboardStore.setPinned(req.params.id, req.body?.pinned === true, scope())) {
            return res.status(404).json({ error: 'Clipboard entry not found' });
        }
        respondChanged(req, res);
    });

    app.delete(`${CLIPBOARD_API_PATH}/:id`, async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        clipboardStore.remove(req.params.id, scope());
        respondChanged(req, res);
    });

    app.delete(CLIPBOARD_API_PATH, async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        clipboardStore.clearUnpinned(scope());
        respondChanged(req, res);
    });
}

module.exports = { installClipboardRoutes };
