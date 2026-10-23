'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { binaryBodyParser } = require('./utils/binaryHttp.cjs');
const { encodeInlayAsset, decodeInlayAsset } = require('../../src/ts/storage/inlayTransport.ts');
const { isInlayMediaType, getInlayThumbnailScale } = require('../../shared/inlayTypes.mjs');
const { getImageType } = require('../../src/ts/media/imageType.ts');

function createInlayService({ inlayDir, getVips, getMimeFromExt, kvGet, kvDel, kvList, logger }) {
    const migrationMarker = path.join(inlayDir, '.migrated_to_fs');
    const thumbnailDirs = {
        image: path.join(inlayDir, '.image-thumbnails'),
        video: path.join(inlayDir, '.video-thumbnails'),
    };
    const thumbnailJobs = new Map();

    function isSafeInlayId(id) {
        return typeof id === 'string' && id.length > 0 && !id.includes('\0')
            && !id.includes('/') && !id.includes('\\') && id !== '.' && id !== '..';
    }

    function normalizeInlayExt(ext) {
        if (typeof ext !== 'string') return 'bin';
        const normalized = ext.trim().toLowerCase().replace(/^\.+/, '').replace(/[\/\\\0]/g, '');
        return normalized || 'bin';
    }

    const resolvedInlayDir = path.resolve(inlayDir) + path.sep;

    function assertInsideInlayDir(filePath) {
        if (!path.resolve(filePath).startsWith(resolvedInlayDir)) {
            throw new Error(`Path escapes inlay directory: ${filePath}`);
        }
    }

    function getInlayFilePath(id, ext) {
        if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
        const filePath = path.join(inlayDir, `${id}.${normalizeInlayExt(ext)}`);
        assertInsideInlayDir(filePath);
        return filePath;
    }

    function getInlaySidecarPath(id) {
        if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
        const filePath = path.join(inlayDir, `${id}.meta.json`);
        assertInsideInlayDir(filePath);
        return filePath;
    }

    function getThumbnailPath(id, type) {
        if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
        const thumbnailDir = thumbnailDirs[type];
        if (!thumbnailDir) throw new Error(`Invalid inlay thumbnail type: ${type}`);
        const filePath = path.join(thumbnailDir, `${id}.webp`);
        assertInsideInlayDir(filePath);
        return filePath;
    }

    async function ensureInlayDir() {
        await fs.mkdir(inlayDir, { recursive: true });
    }

    function decodeDataUri(dataUri) {
        if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
            throw new Error('Invalid data URI');
        }
        const commaIdx = dataUri.indexOf(',');
        if (commaIdx === -1) throw new Error('Malformed data URI');
        const meta = dataUri.substring(5, commaIdx);
        return {
            buffer: Buffer.from(dataUri.substring(commaIdx + 1), 'base64'),
            mime: meta.split(';')[0] || 'application/octet-stream',
        };
    }

    function normalizeInlayInfo(id, info) {
        return {
            ext: normalizeInlayExt(info?.ext),
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
    }

    async function readInlaySidecar(id) {
        try {
            const raw = await fs.readFile(getInlaySidecarPath(id), 'utf-8');
            return normalizeInlayInfo(id, JSON.parse(raw));
        } catch {
            return null;
        }
    }

    async function readInlayInfo(id) {
        return (await readInlaySidecar(id)) || (await readInlayLegacyInfo(id));
    }

    async function resolveInlayFilePath(id, sidecar) {
        if (!isSafeInlayId(id)) return null;
        if (sidecar === undefined) sidecar = await readInlayInfo(id);
        if (sidecar) {
            const candidate = getInlayFilePath(id, sidecar.ext);
            try { await fs.access(candidate); return candidate; } catch {}
        }
        try {
            const entries = await fs.readdir(inlayDir, { withFileTypes: true });
            const match = entries.find(entry => (
                entry.isFile() && entry.name.startsWith(`${id}.`) && entry.name !== `${id}.meta.json`
            ));
            return match ? path.join(inlayDir, match.name) : null;
        } catch {
            return null;
        }
    }

    async function getInlayFileInfo(id, sidecar) {
        if (sidecar === undefined) sidecar = await readInlayInfo(id);
        if (sidecar && !isInlayMediaType(sidecar.type)) return null;
        const filePath = await resolveInlayFilePath(id, sidecar);
        if (!filePath) return null;
        const ext = normalizeInlayExt(path.extname(filePath).slice(1));
        const stat = await fs.stat(filePath);
        return { ext, filePath, mtimeMs: stat.mtimeMs, size: stat.size };
    }

    async function readInlayFile(id, sidecar) {
        const info = await getInlayFileInfo(id, sidecar);
        if (!info) return null;
        const buffer = await fs.readFile(info.filePath);
        return { ...info, buffer, mime: getMimeFromExt(info.ext, buffer) };
    }

    async function writeInlaySidecar(id, info) {
        await ensureInlayDir();
        await fs.writeFile(getInlaySidecarPath(id), JSON.stringify(normalizeInlayInfo(id, info)));
    }

    async function deleteInlayRawFile(id) {
        const filePath = await resolveInlayFilePath(id);
        if (filePath) await fs.unlink(filePath).catch(() => {});
    }

    async function removeThumbnailCaches(id) {
        // An in-flight build could otherwise recreate the deleted thumbnail.
        await Promise.allSettled(Object.keys(thumbnailDirs).map(type => (
            thumbnailJobs.get(`${type}:${id}`)
        )));
        await Promise.all(Object.keys(thumbnailDirs).map(type => (
            fs.unlink(getThumbnailPath(id, type)).catch(() => {})
        )));
    }

    async function writeInlayFile(id, ext, buffer, info = null, options = {}) {
        await ensureInlayDir();
        await deleteInlayRawFile(id);
        if (!options.preserveThumbnails) await removeThumbnailCaches(id);
        const normalizedExt = normalizeInlayExt(ext);
        await fs.writeFile(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
        await writeInlaySidecar(id, { ...(info || {}), ext: normalizedExt });
    }

    async function deleteInlayFile(id) {
        await deleteInlayRawFile(id);
        await removeThumbnailCaches(id);
        await fs.unlink(getInlaySidecarPath(id)).catch(() => {});
    }

    function deleteLegacyInlayData(id) {
        kvDel(`inlay/${id}`);
        kvDel(`inlay_thumb/${id}`);
        kvDel(`inlay_info/${id}`);
    }

    async function listInlayFiles() {
        await ensureInlayDir();
        const entries = await fs.readdir(inlayDir, { withFileTypes: true });
        const files = entries
            .filter(entry => entry.isFile() && entry.name !== '.migrated_to_fs' && !entry.name.endsWith('.meta.json'))
            .map(entry => {
                const ext = normalizeInlayExt(path.extname(entry.name).slice(1));
                const id = entry.name.slice(0, -(ext.length + 1));
                return { id, ext, filePath: path.join(inlayDir, entry.name) };
            })
            .filter(entry => isSafeInlayId(entry.id));
        const ids = [...new Set(files.map(entry => entry.id))];
        const unsupported = new Set();
        const metadataBatchSize = 32;
        for (let start = 0; start < ids.length; start += metadataBatchSize) {
            const batch = await Promise.all(ids.slice(start, start + metadataBatchSize).map(async id => {
                const info = await readInlayInfo(id);
                return info && !isInlayMediaType(info.type) ? id : undefined;
            }));
            for (const id of batch) {
                if (id) unsupported.add(id);
            }
        }
        return files.filter(entry => !unsupported.has(entry.id));
    }

    async function readInlayLegacyInfo(id) {
        const value = kvGet(`inlay_info/${id}`);
        if (!value) return null;
        try {
            return normalizeInlayInfo(id, JSON.parse(value.toString('utf-8')));
        } catch {
            return null;
        }
    }

    async function readInlayInfoPayload(id) {
        const info = await readInlayInfo(id);
        return info && isInlayMediaType(info.type) ? Buffer.from(JSON.stringify(info)) : null;
    }

    async function readInlayAssetPayload(id) {
        const sidecar = await readInlayInfo(id);
        const file = await readInlayFile(id, sidecar);
        if (!file) return null;
        const info = {
            ext: sidecar?.ext || file.ext,
            name: sidecar?.name || id,
            type: sidecar?.type || 'image',
            height: sidecar?.height,
            width: sidecar?.width,
        };
        return Buffer.from(encodeInlayAsset({ ...info, mime: file.mime }, file.buffer).buffer);
    }

    async function migrateInlaysToFilesystem() {
        await ensureInlayDir();
        if (fsSync.existsSync(migrationMarker)) return;

        for (const key of kvList('inlay/')) {
            const id = key.slice('inlay/'.length);
            if (!isSafeInlayId(id)) continue;
            const fileAlreadyExists = await getInlayFileInfo(id);
            if (fileAlreadyExists) {
                deleteLegacyInlayData(id);
                continue;
            }
            const value = kvGet(key);
            if (!value) continue;
            try {
                const parsed = JSON.parse(value.toString('utf-8'));
                const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                if (!isInlayMediaType(type)) {
                    deleteLegacyInlayData(id);
                    continue;
                }
                const ext = normalizeInlayExt(parsed?.ext);
                const buffer = decodeDataUri(parsed?.data).buffer;
                const info = (await readInlayLegacyInfo(id)) || {
                    ext,
                    name: typeof parsed?.name === 'string' ? parsed.name : id,
                    type,
                    height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                    width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                };
                await writeInlayFile(id, ext, buffer, info);
                deleteLegacyInlayData(id);
            } catch (error) {
                logger.warn(`[InlayFS] Failed to migrate ${key}:`, error?.message || error);
            }
        }

        await fs.writeFile(migrationMarker, new Date().toISOString(), 'utf-8');
    }

    async function sumInlayFsBytes() {
        let total = 0;
        try {
            const inlayFiles = await listInlayFiles();
            await Promise.all(inlayFiles.map(async entry => {
                try {
                    const stat = await fs.stat(entry.filePath);
                    total += stat.size;
                } catch {}
                try {
                    const stat = await fs.stat(getInlaySidecarPath(entry.id));
                    total += stat.size;
                } catch {}
            }));
        } catch {}
        return total;
    }

    const INLAY_IMAGE_SIZE_PIXELS = Object.freeze({
        '1k': 1024 * 1024,
        '2k': 2048 * 2048,
        '4k': 4096 * 4096,
        'original': Number.POSITIVE_INFINITY,
    });
    const INLAY_WEBP_EFFORT = 5;

    function normalizeInlayImageSettings(input) {
        const size = Object.hasOwn(INLAY_IMAGE_SIZE_PIXELS, input?.size) ? input.size : '1k';
        const format = input?.format === 'png' ? 'png' : 'webp';
        const lossy = input?.lossy !== false;
        const rawQuality = Number(input?.quality);
        const quality = Number.isFinite(rawQuality)
            ? Math.min(1, Math.max(0.01, rawQuality > 1 ? rawQuality / 100 : rawQuality))
            : 0.85;
        return { size, format, lossy, quality };
    }

    async function encodeImageBuffer(buffer, { format, options, getScale }) {
        const vips = await getVips();
        const source = vips.Image.newFromBuffer(buffer);
        let rotated = null;
        let image = null;
        try {
            rotated = source.autorot();
            const scale = getScale(rotated.width, rotated.height);
            image = scale < 1 ? rotated.resize(scale, { kernel: vips.Kernel.lanczos3 }) : rotated;
            return {
                buffer: Buffer.from(image.writeToBuffer(`.${format}`, options)),
                ext: format,
                width: image.width,
                height: image.height,
            };
        } finally {
            if (image && image !== rotated) image.delete();
            if (rotated) rotated.delete();
            source.delete();
        }
    }

    function encodeInlayImageBuffer(buffer, settings) {
        const maxPixels = INLAY_IMAGE_SIZE_PIXELS[settings.size];
        return encodeImageBuffer(buffer, {
            format: settings.format,
            options: settings.format === 'png' ? { Q: 100 }
                : settings.lossy
                    ? { Q: Math.round(settings.quality * 100), effort: INLAY_WEBP_EFFORT }
                    : { lossless: true, effort: INLAY_WEBP_EFFORT },
            getScale: (width, height) => Math.min(1, Math.sqrt(maxPixels / (width * height))),
        });
    }

    const THUMB_QUALITY = 75;
    const THUMB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

    function encodeThumbnail(buffer) {
        if (getImageType(buffer) === 'Unknown') throw new Error('Unsupported thumbnail image');
        return encodeImageBuffer(buffer, {
            format: 'webp', options: { Q: THUMB_QUALITY }, getScale: getInlayThumbnailScale,
        });
    }

    async function ensureThumbnail(id, type, frameBuffer = null) {
        const jobKey = `${type}:${id}`;
        const pending = thumbnailJobs.get(jobKey);
        if (pending) return pending;
        const canGenerate = type === 'image' || frameBuffer !== null;

        const job = (async () => {
            const sidecar = await readInlaySidecar(id);
            if (sidecar?.type !== type) return null;
            if (type === 'image' && !THUMB_IMAGE_EXTS.has(sidecar.ext)) return null;
            const source = await getInlayFileInfo(id, sidecar);
            if (!source) return null;

            const thumbnailPath = getThumbnailPath(id, type);
            try {
                const stat = await fs.stat(thumbnailPath);
                return { filePath: thumbnailPath, stat };
            } catch {}

            if (!canGenerate) return null;

            const thumbnailDir = path.dirname(thumbnailPath);
            await fs.mkdir(thumbnailDir, { recursive: true });
            const temporaryBase = `${id}.${process.pid}.${nodeCrypto.randomBytes(6).toString('hex')}`;
            const temporaryPath = path.join(thumbnailDir, `${temporaryBase}.tmp.webp`);
            try {
                const input = frameBuffer || await fs.readFile(source.filePath);
                const thumbnail = await encodeThumbnail(input);
                await fs.writeFile(temporaryPath, thumbnail.buffer);
                await fs.rename(temporaryPath, thumbnailPath);
                return { filePath: thumbnailPath, stat: await fs.stat(thumbnailPath) };
            } catch {
                return null;
            } finally {
                await fs.unlink(temporaryPath).catch(() => {});
            }
        })();
        if (!canGenerate) return job;

        const trackedJob = job.finally(() => thumbnailJobs.delete(jobKey));
        thumbnailJobs.set(jobKey, trackedJob);
        return trackedJob;
    }

    async function compressInlays(settings, onProgress = () => {}) {
        const compressibleExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif']);
        const files = await listInlayFiles();
        const imageFiles = [];
        for (const entry of files) {
            if (!compressibleExts.has(entry.ext)) continue;
            const sidecar = await readInlaySidecar(entry.id);
            if (sidecar && sidecar.type !== 'image') continue;
            imageFiles.push({ ...entry, sidecar });
        }

        let compressed = 0;
        let skipped = 0;
        let totalSaved = 0;
        for (let i = 0; i < imageFiles.length; i++) {
            const entry = imageFiles[i];
            try {
                const original = await fs.readFile(entry.filePath);
                const encoded = await encodeInlayImageBuffer(original, settings);
                await writeInlayFile(entry.id, encoded.ext, encoded.buffer, {
                    ...(entry.sidecar || {}),
                    ext: encoded.ext,
                    width: encoded.width,
                    height: encoded.height,
                }, { preserveThumbnails: true });
                kvDel(`inlay_thumb/${entry.id}`);
                totalSaved += original.length - encoded.buffer.length;
                compressed++;
            } catch {
                skipped++;
            }
            onProgress({
                type: 'progress', current: i + 1, total: imageFiles.length,
                compressed, skipped, totalSaved,
            });
        }
        return { total: imageFiles.length, compressed, skipped, totalSaved };
    }

    return {
        inlayDir,
        inlayMigrationMarker: migrationMarker,
        isSafeInlayId,
        normalizeInlayExt,
        ensureInlayDir,
        getInlaySidecarPath,
        getInlayFileInfo,
        readInlayFile,
        decodeDataUri,
        decodeInlayAsset,
        readInlayAssetPayload,
        readInlayInfoPayload,
        writeInlaySidecar,
        writeInlayFile,
        deleteInlayFile,
        listInlayFiles,
        migrateInlaysToFilesystem,
        sumInlayFsBytes,
        normalizeInlayImageSettings,
        encodeInlayImageBuffer,
        encodeThumbnail,
        ensureThumbnail,
        compressInlays,
    };
}

function installInlaysRoutes(app, { sessionAuthMiddleware, requireSyncClientId, inlayService }) {
    const { normalizeInlayImageSettings, encodeInlayImageBuffer, compressInlays } = inlayService;

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
        } catch (error) {
            return res.status(400).json({ error: error?.message || 'Image encoding failed' });
        }
    });

    app.post('/api/inlays/:id/video-thumbnail', sessionAuthMiddleware, binaryBodyParser('2mb'), async (req, res) => {
        if (!requireSyncClientId(req, res)) return;
        if (!inlayService.isSafeInlayId(req.params.id) || !Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Video id and thumbnail body required' });
        }
        try {
            const thumbnail = await inlayService.ensureThumbnail(req.params.id, 'video', req.body);
            if (!thumbnail) return res.status(400).json({ error: 'Video thumbnail could not be saved' });
            return res.status(204).end();
        } catch (error) {
            return res.status(400).json({ error: error?.message || 'Video thumbnail could not be saved' });
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

        const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
        try {
            const result = await compressInlays(settings, send);
            send({ type: 'done', ...result });
        } catch (error) {
            send({ type: 'error', message: error?.message || 'Unknown error' });
        }
        res.end();
    });
}

module.exports = { createInlayService, installInlaysRoutes };
