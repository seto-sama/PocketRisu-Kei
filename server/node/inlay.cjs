'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const nodeCrypto = require('crypto');
const { binaryBodyParser } = require('./binaryHttp.cjs');
const { encodeInlayAsset, decodeInlayAsset } = require('../../src/ts/storage/inlayTransport.ts');

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

    async function resolveInlayFilePath(id, sidecar) {
        if (!isSafeInlayId(id)) return null;
        sidecar ??= await readInlaySidecar(id);
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
        const filePath = await resolveInlayFilePath(id, sidecar);
        if (!filePath) return null;
        const ext = normalizeInlayExt(path.extname(filePath).slice(1));
        const stat = await fs.stat(filePath);
        return { ext, filePath, mtimeMs: stat.mtimeMs, size: stat.size };
    }

    async function readInlayFile(id) {
        const info = await getInlayFileInfo(id);
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
        // Finish this asset's pending builds before removing their output.
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

    async function listInlayFiles() {
        await ensureInlayDir();
        const entries = await fs.readdir(inlayDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && entry.name !== '.migrated_to_fs' && !entry.name.endsWith('.meta.json'))
            .map(entry => {
                const ext = normalizeInlayExt(path.extname(entry.name).slice(1));
                const id = entry.name.slice(0, -(ext.length + 1));
                return { id, ext, filePath: path.join(inlayDir, entry.name) };
            })
            .filter(entry => isSafeInlayId(entry.id));
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
        const sidecar = await readInlaySidecar(id);
        if (sidecar) return Buffer.from(JSON.stringify(sidecar));
        const legacy = await readInlayLegacyInfo(id);
        if (legacy) return Buffer.from(JSON.stringify(legacy));
        return kvGet(`inlay_info/${id}`);
    }

    async function readInlayAssetPayload(id) {
        const file = await readInlayFile(id);
        if (!file) return null;
        const sidecar = (await readInlaySidecar(id)) || (await readInlayLegacyInfo(id));
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
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
                continue;
            }
            const value = kvGet(key);
            if (!value) continue;
            try {
                const parsed = JSON.parse(value.toString('utf-8'));
                const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                const ext = normalizeInlayExt(parsed?.ext);
                const buffer = type === 'signature'
                    ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                    : decodeDataUri(parsed?.data).buffer;
                const info = (await readInlayLegacyInfo(id)) || {
                    ext,
                    name: typeof parsed?.name === 'string' ? parsed.name : id,
                    type,
                    height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                    width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                };
                await writeInlayFile(id, ext, buffer, info);
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
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

    async function encodeInlayImageBuffer(buffer, settings) {
        const vips = await getVips();
        const source = vips.Image.newFromBuffer(buffer);
        let rotated = null;
        let image = null;
        try {
            rotated = source.autorot();
            const maxPixels = INLAY_IMAGE_SIZE_PIXELS[settings.size];
            const currentPixels = rotated.width * rotated.height;
            const scale = currentPixels > maxPixels ? Math.sqrt(maxPixels / currentPixels) : 1;
            image = scale < 1 ? rotated.resize(scale, { kernel: vips.Kernel.lanczos3 }) : rotated;
            const output = settings.format === 'png'
                ? image.writeToBuffer('.png', { Q: 100 })
                : image.writeToBuffer('.webp', settings.lossy
                    ? { Q: Math.round(settings.quality * 100), effort: INLAY_WEBP_EFFORT }
                    : { lossless: true, effort: INLAY_WEBP_EFFORT });
            return {
                buffer: Buffer.from(output),
                ext: settings.format,
                width: image.width,
                height: image.height,
            };
        } finally {
            if (image && image !== rotated) image.delete();
            if (rotated) rotated.delete();
            source.delete();
        }
    }

    const THUMB_SHORT_SIDE = 320;
    const THUMB_LONG_SIDE = 640;
    const THUMB_QUALITY = 75;
    const THUMB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

    async function generateThumbnail(buffer) {
        const vips = await getVips();
        const source = vips.Image.newFromBuffer(buffer);
        let rotated = null;
        let image = null;
        try {
            rotated = source.autorot();
            const landscape = rotated.width >= rotated.height;
            const targetWidth = landscape ? THUMB_LONG_SIDE : THUMB_SHORT_SIDE;
            const targetHeight = landscape ? THUMB_SHORT_SIDE : THUMB_LONG_SIDE;
            const scale = Math.min(targetWidth / rotated.width, targetHeight / rotated.height, 1);
            image = scale < 1 ? rotated.resize(scale, { kernel: vips.Kernel.lanczos3 }) : rotated;
            return Buffer.from(image.writeToBuffer('.webp', { Q: THUMB_QUALITY }));
        } finally {
            if (image && image !== rotated) image.delete();
            if (rotated) rotated.delete();
            source.delete();
        }
    }

    function extractVideoThumbnailFrame(inputPath, outputPath) {
        const bundledExecutable = path.join(
            process.cwd(), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
        );
        const executable = process.env.RISU_FFMPEG_PATH || (
            fsSync.existsSync(bundledExecutable) ? bundledExecutable : 'ffmpeg'
        );
        return new Promise(resolve => {
            const child = spawn(executable, [
                '-hide_banner', '-loglevel', 'error', '-ss', '0.1', '-i', inputPath,
                '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-c:v', 'png', '-y', outputPath,
            ], { stdio: 'ignore', windowsHide: true });
            let settled = false;
            const finish = success => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(success);
            };
            const timeout = setTimeout(() => {
                child.kill('SIGKILL');
                finish(false);
            }, 30_000);
            child.once('error', () => finish(false));
            child.once('close', code => finish(code === 0));
        });
    }

    async function ensureThumbnail(id, type) {
        const jobKey = `${type}:${id}`;
        const pending = thumbnailJobs.get(jobKey);
        if (pending) return await pending;

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
            } catch {
                // A missing cache entry is generated below.
            }

            const thumbnailDir = path.dirname(thumbnailPath);
            await fs.mkdir(thumbnailDir, { recursive: true });
            const temporaryBase = `${id}.${process.pid}.${nodeCrypto.randomBytes(6).toString('hex')}`;
            const framePath = type === 'video'
                ? path.join(thumbnailDir, `${temporaryBase}.frame.png`)
                : null;
            const temporaryPath = path.join(thumbnailDir, `${temporaryBase}.tmp.webp`);
            try {
                let input;
                if (type === 'video') {
                    if (!await extractVideoThumbnailFrame(source.filePath, framePath)) return null;
                    input = await fs.readFile(framePath);
                } else {
                    input = await fs.readFile(source.filePath);
                }
                await fs.writeFile(temporaryPath, await generateThumbnail(input));
                await fs.rename(temporaryPath, thumbnailPath);
                return { filePath: thumbnailPath, stat: await fs.stat(thumbnailPath) };
            } catch {
                return null;
            } finally {
                await Promise.allSettled([
                    framePath ? fs.unlink(framePath) : Promise.resolve(),
                    fs.unlink(temporaryPath),
                ]);
            }
        })().finally(() => thumbnailJobs.delete(jobKey));

        thumbnailJobs.set(jobKey, job);
        return await job;
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
