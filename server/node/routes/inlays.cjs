'use strict';

const { binaryBodyParser } = require('../binaryHttp.cjs');

const fs = require('fs/promises');
const { kvDel } = require('../db.cjs');

function installInlaysRoutes(app, {
    sessionAuthMiddleware,
    requireSyncClientId,
    normalizeInlayImageSettings,
    encodeInlayImageBuffer,
    listInlayFiles,
    readInlaySidecar,
    writeInlayFile,
}) {
    const COMPRESS_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif']);

    app.post('/api/inlays/encode-webp', sessionAuthMiddleware, binaryBodyParser('2gb'), async (req, res) => {
        if (!requireSyncClientId(req, res)) return;
        try {
            if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
                return res.status(400).json({ error: 'Image body required' });
            }
            const settings = normalizeInlayImageSettings({
                size: 'original',
                format: 'webp',
                lossy: req.headers['x-inlay-lossy'] !== '0',
                quality: req.headers['x-inlay-quality'],
            });
            const encoded = await encodeInlayImageBuffer(req.body, settings);
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('Content-Length', encoded.buffer.length);
            return res.send(encoded.buffer);
        } catch (err) {
            return res.status(400).json({ error: err?.message || 'Image encoding failed' });
        }
    });

    app.post('/api/inlays/compress', sessionAuthMiddleware, async (req, res) => {
        if (!requireSyncClientId(req, res)) return;
        const settings = normalizeInlayImageSettings(req.body);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        const send = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        try {
            const files = await listInlayFiles();
            const imageFiles = [];

            for (const entry of files) {
                if (!COMPRESS_IMAGE_EXTS.has(entry.ext)) continue;
                const sidecar = await readInlaySidecar(entry.id);
                if (sidecar && sidecar.type !== 'image') continue;
                imageFiles.push({ ...entry, sidecar });
            }

            const total = imageFiles.length;
            let compressed = 0;
            let skipped = 0;
            let totalSaved = 0;

            for (let i = 0; i < imageFiles.length; i++) {
                const entry = imageFiles[i];
                try {
                    const original = await fs.readFile(entry.filePath);
                    const encoded = await encodeInlayImageBuffer(original, settings);
                    const info = entry.sidecar || {};
                    await writeInlayFile(entry.id, encoded.ext, encoded.buffer, {
                        ...info,
                        ext: encoded.ext,
                        width: encoded.width,
                        height: encoded.height,
                    });
                    kvDel(`inlay_thumb/${entry.id}`);
                    totalSaved += original.length - encoded.buffer.length;
                    compressed++;
                } catch {
                    skipped++;
                }

                send({ type: 'progress', current: i + 1, total, compressed, skipped, totalSaved });
            }

            send({ type: 'done', total, compressed, skipped, totalSaved });
        } catch (err) {
            send({ type: 'error', message: err?.message || 'Unknown error' });
        }

        res.end();
    });
}

module.exports = { installInlaysRoutes };
