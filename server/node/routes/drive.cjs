'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { finished, pipeline } = require('node:stream/promises');
const { codes, createApiError } = require('../apiErrors.cjs');
const {
    DEFAULT_TRASH_RETENTION_DAYS,
    DRIVE_TRASH_DIRECTORY: TRASH_NAME,
    isTrashExpired,
    normalizeTrashRetentionDays,
} = require('../../../shared/trashRetention.mjs');

const UPLOAD_PREFIX = '.pocketrisu-upload-';
const TRASH_NAME_LOWER = TRASH_NAME.toLowerCase();
const TRASH_CLEANUP_RETRY_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function validateName(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..'
        || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
        || name.toLowerCase().startsWith(UPLOAD_PREFIX) || Buffer.byteLength(name) > 255) {
        throw createApiError(codes.INVALID_FILE_PATH, 400);
    }
    return name;
}

function pathParts(value = '') {
    if (typeof value !== 'string') throw createApiError(codes.INVALID_FILE_PATH, 400);
    return value === '' ? [] : value.split('/').map(validateName);
}

function isTrashPath(parts) {
    return parts[0]?.toLowerCase() === TRASH_NAME_LOWER;
}

function rejectTrashPath(parts) {
    if (isTrashPath(parts)) throw createApiError(codes.INVALID_FILE_PATH, 400);
}

function assertWritableDestination(parent, name) {
    validateName(name);
    const parentParts = pathParts(parent);
    if (isTrashPath(parentParts) || (!parentParts.length && name.toLowerCase() === TRASH_NAME_LOWER)) {
        throw createApiError(codes.INVALID_FILE_PATH, 400);
    }
}

function assertEntry(stat) {
    // Hard links can alias files outside the drive just as symbolic links can.
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
        || (stat.isFile() && stat.nlink > 1)) {
        throw createApiError(codes.DRIVE_UNSUPPORTED_ENTRY, 403);
    }
}

function metadata(relativePath, stat) {
    return {
        path: relativePath,
        name: path.posix.basename(relativePath),
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.isFile() ? stat.size : null,
        createdAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : null,
        modifiedAt: stat.mtimeMs,
    };
}

function installDriveRoutes(app, {
    savePath,
    checkAuth,
    checkDownloadAuth,
    isCloudflareTunnelRequest,
    getTrashRetentionDays = () => DEFAULT_TRASH_RETENTION_DAYS,
}) {
    const root = path.join(savePath, 'drive');
    const trashManifestPath = path.join(savePath, 'drive-trash.json');
    let mutationQueue = Promise.resolve();
    let trashCleanupTimer;
    let trashCleanupRun;
    let trashCleanupStopped = false;
    let trashCleanupScheduleId = 0;

    function mutate(operation) {
        const result = mutationQueue.then(operation, operation);
        mutationQueue = result.catch(() => {});
        return result;
    }

    async function resolveEntry(relativePath = '', directory = false) {
        const parts = pathParts(relativePath);
        await fs.mkdir(root).catch(error => { if (error.code !== 'EEXIST') throw error; });
        let current = root;
        let stat = await fs.lstat(current);
        assertEntry(stat);
        if (!stat.isDirectory()) throw createApiError(codes.DRIVE_UNSUPPORTED_ENTRY, 403);
        for (const part of parts) {
            if (!stat.isDirectory()) throw createApiError(codes.DRIVE_NOT_FOUND, 404);
            current = path.join(current, part);
            stat = await fs.lstat(current);
            assertEntry(stat);
        }
        if (directory && !stat.isDirectory()) throw createApiError(codes.DRIVE_NOT_FOUND, 404);
        return { absolutePath: current, stat };
    }

    async function ensureTrashDirectory() {
        const { absolutePath: driveRoot } = await resolveEntry('', true);
        const trashPath = path.join(driveRoot, TRASH_NAME);
        await fs.mkdir(trashPath).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const trashEntry = await resolveEntry(TRASH_NAME);
        if (!trashEntry.stat.isDirectory()) throw createApiError(codes.DRIVE_UNAVAILABLE, 500);
        return trashEntry;
    }

    async function readTrashManifest() {
        const stat = await fs.lstat(trashManifestPath).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!stat) return Object.create(null);
        assertEntry(stat);
        if (!stat.isFile()) throw createApiError(codes.DRIVE_UNAVAILABLE, 500);
        const parsed = JSON.parse(await fs.readFile(trashManifestPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw createApiError(codes.DRIVE_UNAVAILABLE, 500);
        }
        const manifest = Object.create(null);
        for (const name of Object.keys(parsed)) manifest[name] = parsed[name];
        return manifest;
    }

    async function writeTrashManifest(manifest) {
        const temporaryPath = `${trashManifestPath}.${randomUUID()}.tmp`;
        let file;
        try {
            file = await fs.open(temporaryPath, 'wx', 0o600);
            await file.writeFile(JSON.stringify(manifest));
            await file.sync();
            await file.close();
            file = null;
            await fs.rename(temporaryPath, trashManifestPath);
        } finally {
            if (file) await file.close().catch(() => {});
            await fs.rm(temporaryPath, { force: true }).catch(() => {});
        }
    }

    async function cleanupExpiredTrash(now = Date.now()) {
        const { absolutePath: trashPath } = await ensureTrashDirectory();
        const retentionDays = normalizeTrashRetentionDays(await getTrashRetentionDays());
        if (retentionDays === 0) return false;
        const manifest = await readTrashManifest();
        let changed = false;
        let failed = false;
        for (const name of Object.keys(manifest)) {
            let validName = true;
            try { validateName(name); } catch { validName = false; }
            if (!validName || !isTrashExpired(manifest[name], retentionDays, now)) continue;
            try {
                const entryPath = path.join(trashPath, name);
                const stat = await fs.lstat(entryPath).catch(error => {
                    if (error.code === 'ENOENT') return null;
                    throw error;
                });
                if (stat) {
                    await assertTree(entryPath, stat);
                    await fs.rm(entryPath, { recursive: true });
                }
                delete manifest[name];
                changed = true;
            } catch (error) {
                failed = true;
                console.error('[Drive] Failed to remove expired trash entry:', name, error);
            }
        }
        if (changed) await writeTrashManifest(manifest);
        return failed;
    }

    async function scheduleTrashCleanup(retryDelay = 0) {
        if (trashCleanupStopped) return;
        const scheduleId = ++trashCleanupScheduleId;
        clearTimeout(trashCleanupTimer);
        trashCleanupTimer = undefined;
        try {
            const retentionDays = normalizeTrashRetentionDays(await getTrashRetentionDays());
            if (retentionDays === 0) return;
            const manifest = await readTrashManifest();
            let nextExpiry = Infinity;
            for (const [name, value] of Object.entries(manifest)) {
                try { validateName(name); } catch { continue; }
                if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
                nextExpiry = Math.min(nextExpiry, value + retentionDays * 24 * 60 * 60 * 1000);
            }
            if (nextExpiry === Infinity && retryDelay === 0) return;
            const now = Date.now();
            const untilExpiry = nextExpiry === Infinity || nextExpiry <= now ? Infinity : nextExpiry - now + 1;
            const delay = retryDelay > 0
                ? Math.min(retryDelay, untilExpiry)
                : nextExpiry - now + 1;
            if (trashCleanupStopped || scheduleId !== trashCleanupScheduleId) return;
            trashCleanupTimer = setTimeout(() => {
                trashCleanupTimer = undefined;
                void runTrashCleanup();
            }, Math.min(delay, MAX_TIMEOUT_MS));
            trashCleanupTimer.unref?.();
        } catch (error) {
            console.error('[Drive] Failed to schedule trash cleanup:', error);
            if (!trashCleanupStopped && scheduleId === trashCleanupScheduleId) {
                trashCleanupTimer = setTimeout(() => {
                    trashCleanupTimer = undefined;
                    void runTrashCleanup();
                }, retryDelay || TRASH_CLEANUP_RETRY_MS);
                trashCleanupTimer.unref?.();
            }
        }
    }

    function runTrashCleanup() {
        if (trashCleanupStopped) return Promise.resolve();
        if (trashCleanupRun) return trashCleanupRun;
        trashCleanupRun = mutate(() => cleanupExpiredTrash())
            .then(failed => scheduleTrashCleanup(failed ? TRASH_CLEANUP_RETRY_MS : 0))
            .catch(async error => {
                console.error('[Drive] Trash cleanup failed:', error);
                await scheduleTrashCleanup(TRASH_CLEANUP_RETRY_MS);
            })
            .finally(() => { trashCleanupRun = undefined; });
        return trashCleanupRun;
    }

    function stopTrashCleanup() {
        trashCleanupStopped = true;
        trashCleanupScheduleId++;
        clearTimeout(trashCleanupTimer);
        trashCleanupTimer = undefined;
        return trashCleanupRun || Promise.resolve();
    }

    async function refreshTrashRetention() {
        if (trashCleanupStopped) return;
        trashCleanupScheduleId++;
        clearTimeout(trashCleanupTimer);
        trashCleanupTimer = undefined;
        if (trashCleanupRun) await trashCleanupRun;
        return runTrashCleanup();
    }

    async function assertTree(absolutePath, stat) {
        assertEntry(stat);
        if (!stat.isDirectory()) return;
        for (const name of await fs.readdir(absolutePath)) {
            validateName(name);
            const childPath = path.join(absolutePath, name);
            await assertTree(childPath, await fs.lstat(childPath));
        }
    }

    async function destination(parent, name, overwrite = false) {
        assertWritableDestination(parent, name);
        const { absolutePath } = await resolveEntry(parent, true);
        const target = path.join(absolutePath, name);
        const existing = await fs.lstat(target).catch(error => {
            if (error.code !== 'ENOENT') throw error;
            return null;
        });
        if (existing) {
            if (!overwrite) throw createApiError(codes.DRIVE_ALREADY_EXISTS, 409);
            assertEntry(existing);
            if (!existing.isFile()) throw createApiError(codes.DRIVE_ALREADY_EXISTS, 409);
        }
        return target;
    }

    function numberedName(name, number) {
        const extension = path.extname(name);
        const stem = Array.from(name.slice(0, name.length - extension.length));
        const suffix = ` (${number})${extension}`;
        while (stem.length && Buffer.byteLength(stem.join('') + suffix) > 255) stem.pop();
        if (!stem.length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        return validateName(stem.join('') + suffix);
    }

    async function publishUpload(temporaryPath, parent, name, conflict) {
        for (let number = 0; ; number++) {
            const finalName = number ? numberedName(name, number) : name;
            try {
                const target = await destination(parent, finalName, conflict === 'overwrite');
                if (conflict === 'overwrite') {
                    // Replace only after the complete upload has arrived, preserving the old file on cancellation.
                    await fs.rename(temporaryPath, target);
                } else {
                    // link() also rejects files created by an external writer after the destination check.
                    await fs.link(temporaryPath, target);
                    await fs.unlink(temporaryPath);
                }
                return metadata(parent ? `${parent}/${finalName}` : finalName, await fs.lstat(target));
            } catch (error) {
                if (conflict !== 'rename' || !['EEXIST', codes.DRIVE_ALREADY_EXISTS].includes(error.code)) throw error;
            }
        }
    }

    function route(method, url, handler, download = false) {
        app[method](url, async (req, res, next) => {
            if (!await (download ? checkDownloadAuth : checkAuth)(req, res)) return;
            res.set('Cache-Control', 'no-store, no-transform');
            try {
                if (isCloudflareTunnelRequest(req)) {
                    throw createApiError(codes.DRIVE_REMOTE_ACCESS_DENIED, 403);
                }
                await handler(req, res);
            } catch (error) {
                if (res.destroyed) return;
                if (!error.statusCode) {
                    const mapping = {
                        ENOENT: [codes.DRIVE_NOT_FOUND, 404],
                        ENOTDIR: [codes.DRIVE_NOT_FOUND, 404],
                        EEXIST: [codes.DRIVE_ALREADY_EXISTS, 409],
                        ENOTEMPTY: [codes.DRIVE_ALREADY_EXISTS, 409],
                        ELOOP: [codes.DRIVE_UNSUPPORTED_ENTRY, 403],
                        ENOSPC: [codes.INSUFFICIENT_STORAGE, 507],
                        EDQUOT: [codes.INSUFFICIENT_STORAGE, 507],
                    };
                    const [code, status] = mapping[error.code] || [codes.DRIVE_UNAVAILABLE, 500];
                    error = createApiError(code, status);
                }
                next(error);
            }
        });
    }

    route('get', '/api/drive', async (req, res) => {
        const relativePath = req.query.path ?? '';
        const requestedParts = pathParts(relativePath);
        if (isTrashPath(requestedParts)) await ensureTrashDirectory();
        const { absolutePath } = await resolveEntry(relativePath, true);
        const entries = [];
        for (const name of await fs.readdir(absolutePath)) {
            const child = relativePath ? `${relativePath}/${name}` : name;
            try {
                validateName(name);
                const stat = await fs.lstat(path.join(absolutePath, name));
                if (!relativePath && name.toLowerCase() === TRASH_NAME_LOWER && stat.isDirectory()) continue;
                assertEntry(stat);
                entries.push(metadata(child, stat));
            } catch (error) {
                if (error.code !== 'ENOENT' && ![codes.INVALID_FILE_PATH, codes.DRIVE_UNSUPPORTED_ENTRY].includes(error.code)) throw error;
            }
        }
        entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory')
            || a.name.localeCompare(b.name, undefined, { numeric: true }));
        res.json({ path: relativePath, entries });
    });

    route('get', '/api/drive/metadata', async (req, res) => {
        const relativePath = req.query.path;
        pathParts(relativePath);
        if (!relativePath) throw createApiError(codes.INVALID_FILE_PATH, 400);
        const { stat } = await resolveEntry(relativePath);
        res.json(metadata(relativePath, stat));
    });

    route('post', '/api/drive/directory', async (req, res) => {
        const parent = req.body?.path ?? '';
        const name = validateName(req.body?.name);
        await mutate(async () => fs.mkdir(await destination(parent, name)));
        res.status(201).json({ ok: true });
    });

    route('patch', '/api/drive/rename', async (req, res) => {
        const relativePath = req.body?.path;
        const parts = pathParts(relativePath);
        if (!parts.length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        rejectTrashPath(parts);
        const name = validateName(req.body?.name);
        await mutate(async () => {
            const { absolutePath } = await resolveEntry(relativePath);
            if (name === parts.at(-1)) return;
            const target = await destination(parts.slice(0, -1).join('/'), name);
            await fs.rename(absolutePath, target);
        });
        res.json({ ok: true });
    });

    route('delete', '/api/drive/entry', async (req, res) => {
        const relativePath = req.body?.path;
        const parts = pathParts(relativePath);
        if (!parts.length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        rejectTrashPath(parts);
        await mutate(async () => {
            const { absolutePath, stat } = await resolveEntry(relativePath);
            await assertTree(absolutePath, stat);
            const { absolutePath: trashPath } = await ensureTrashDirectory();
            const manifest = await readTrashManifest();
            const name = parts.at(-1);
            for (let number = 0; ; number++) {
                const targetName = number ? numberedName(name, number) : name;
                const target = path.join(trashPath, targetName);
                const existing = await fs.lstat(target).catch(error => {
                    if (error.code !== 'ENOENT') throw error;
                    return null;
                });
                if (existing) continue;
                const hadManifestEntry = Object.hasOwn(manifest, targetName);
                const previousTimestamp = manifest[targetName];
                manifest[targetName] = Date.now();
                await writeTrashManifest(manifest);
                try {
                    await fs.rename(absolutePath, target);
                    break;
                } catch (error) {
                    if (hadManifestEntry) manifest[targetName] = previousTimestamp;
                    else delete manifest[targetName];
                    await writeTrashManifest(manifest);
                    if (error.code !== 'EEXIST') throw error;
                }
            }
        });
        void scheduleTrashCleanup();
        res.json({ ok: true });
    });

    route('delete', '/api/drive/trash', async (_req, res) => {
        await mutate(async () => {
            const { absolutePath } = await ensureTrashDirectory();
            const stat = await fs.lstat(absolutePath);
            await assertTree(absolutePath, stat);
            for (const name of await fs.readdir(absolutePath)) {
                await fs.rm(path.join(absolutePath, name), { recursive: true });
            }
            await writeTrashManifest(Object.create(null));
        });
        void scheduleTrashCleanup();
        res.json({ ok: true });
    });

    route('put', '/api/drive/file', async (req, res) => {
        if (req.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
            res.status(415).json({ error: 'Upload requires application/octet-stream' });
            return;
        }
        const relativePath = req.query.path ?? '';
        const name = validateName(req.query.name);
        const conflict = req.query.conflict ?? 'error';
        if (!['error', 'overwrite', 'rename'].includes(conflict)) throw createApiError(codes.INVALID_FILE_PATH, 400);
        if (conflict === 'rename') {
            assertWritableDestination(relativePath, name);
            await resolveEntry(relativePath, true);
        }
        else await destination(relativePath, name, conflict === 'overwrite');
        const temporaryPath = path.join(root, UPLOAD_PREFIX + randomUUID());
        try {
            const file = await fs.open(temporaryPath, 'wx', 0o600);
            const output = file.createWriteStream();
            const abort = () => output.destroy(new Error('Upload aborted'));
            req.once('aborted', abort);
            req.once('error', abort);
            try {
                // Unlike pipeline(req, ...), a disk error must not destroy the response socket.
                const completion = finished(output);
                if (req.destroyed) abort();
                else req.pipe(output);
                await completion;
            } finally {
                req.unpipe(output);
                req.off('aborted', abort);
                req.off('error', abort);
                if (!req.complete && !req.destroyed) req.resume();
                await file.close();
            }
            const entry = await mutate(() => publishUpload(temporaryPath, relativePath, name, conflict));
            res.status(201).json({ entry });
        } finally {
            await fs.rm(temporaryPath, { force: true });
        }
    });

    route('get', '/api/drive/download', async (req, res) => {
        const relativePath = req.query.path;
        if (!pathParts(relativePath).length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        const { absolutePath, stat } = await resolveEntry(relativePath);
        if (!stat.isFile()) throw createApiError(codes.DRIVE_UNSUPPORTED_ENTRY, 403);
        const file = await fs.open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        try {
            const openedStat = await file.stat();
            assertEntry(openedStat);
            if (!openedStat.isFile()) throw createApiError(codes.DRIVE_UNSUPPORTED_ENTRY, 403);
            res.attachment(path.basename(absolutePath));
            res.type('application/octet-stream');
            res.set('X-Content-Type-Options', 'nosniff');
            res.set('Content-Length', String(openedStat.size));
            await pipeline(file.createReadStream(), res);
        } finally {
            await file.close();
        }
    }, true);

    void runTrashCleanup();
    return { stopTrashCleanup, refreshTrashRetention };
}

module.exports = { installDriveRoutes };
