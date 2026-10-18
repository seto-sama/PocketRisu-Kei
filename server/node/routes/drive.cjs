'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { finished, pipeline } = require('node:stream/promises');
const { codes, createApiError } = require('../apiErrors.cjs');
const { readDrivePreview } = require('../drivePreview.cjs');
const { getZip } = require('../zip.cjs');
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

function conflictPolicy(value = 'error') {
    if (!['error', 'overwrite', 'rename'].includes(value)) throw createApiError(codes.INVALID_FILE_PATH, 400);
    return value;
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
    encodeThumbnail,
    getTrashRetentionDays = () => DEFAULT_TRASH_RETENTION_DAYS,
}) {
    const root = path.join(savePath, 'drive');
    const trashManifestPath = path.join(savePath, 'drive-trash.json');
    let mutationQueue = Promise.resolve();
    let thumbnailQueue = Promise.resolve();
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

    async function openFile(relativePath) {
        if (!pathParts(relativePath).length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        const { absolutePath, stat } = await resolveEntry(relativePath);
        if (!stat.isFile()) throw createApiError(codes.DRIVE_UNSUPPORTED_ENTRY, 403);
        const file = await fs.open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        try {
            const openedStat = await file.stat();
            assertEntry(openedStat);
            if (!openedStat.isFile()) throw createApiError(codes.DRIVE_UNSUPPORTED_ENTRY, 403);
            return { file, stat: openedStat };
        } catch (error) {
            await file.close();
            throw error;
        }
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

    function drivePath(parent, name) {
        return parent ? `${parent}/${name}` : name;
    }

    async function optionalEntry(relativePath, resolvedParentPath) {
        const parts = pathParts(relativePath);
        if (!parts.length) return resolveEntry('', true);
        const parent = parts.slice(0, -1).join('/');
        const parentPath = resolvedParentPath ?? (await resolveEntry(parent, true)).absolutePath;
        const absolutePath = path.join(parentPath, parts.at(-1));
        const stat = await fs.lstat(absolutePath).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (stat) assertEntry(stat);
        return stat ? { absolutePath, stat } : null;
    }

    function statFingerprint(stat) {
        return stat && {
            type: stat.isDirectory() ? 'directory' : 'file',
            dev: String(stat.dev),
            ino: String(stat.ino),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
        };
    }

    function identityFingerprint(stat) {
        return {
            type: stat.isDirectory() ? 'directory' : 'file',
            dev: String(stat.dev),
            ino: String(stat.ino),
        };
    }

    async function captureTree(absolutePath, relativePath, role, observations) {
        const stat = await fs.lstat(absolutePath);
        assertEntry(stat);
        observations.set(`${role}:${relativePath}`, statFingerprint(stat));
        const node = { absolutePath, relativePath, stat, children: [] };
        if (stat.isDirectory()) {
            const names = (await fs.readdir(absolutePath)).sort((a, b) => a.localeCompare(b));
            for (const name of names) {
                validateName(name);
                node.children.push(await captureTree(
                    path.join(absolutePath, name), drivePath(relativePath, name), role, observations,
                ));
            }
        }
        return node;
    }

    async function currentCapturedStat(node, changed) {
        const current = await fs.lstat(node.absolutePath).catch(error => {
            if (error.code === 'ENOENT') throw changed();
            throw error;
        });
        assertEntry(current);
        if (JSON.stringify(statFingerprint(current)) !== JSON.stringify(statFingerprint(node.stat))) {
            throw changed();
        }
        return current;
    }

    async function assertCapturedEntry(node, plan) {
        return currentCapturedStat(node, () => mergeConflict(plan));
    }

    async function assertCapturedTree(node, plan) {
        const current = await assertCapturedEntry(node, plan);
        if (!current.isDirectory()) return;
        const names = (await fs.readdir(node.absolutePath)).sort((a, b) => a.localeCompare(b));
        const expectedNames = node.children.map(child => path.posix.basename(child.relativePath)).sort((a, b) => a.localeCompare(b));
        if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
            throw mergeConflict(plan);
        }
        for (const child of node.children) await assertCapturedTree(child, plan);
    }

    async function collectMergePlan(sourcePath, destinationPath) {
        const observations = new Map();
        const source = await captureTree(sourcePath.absolutePath, sourcePath.relativePath, 'source', observations);

        async function compare(sourceNode, targetAbsolutePath, targetRelativePath) {
            const targetStat = await fs.lstat(targetAbsolutePath).catch(error => {
                if (error.code === 'ENOENT') return null;
                throw error;
            });
            observations.set(`destination:${targetRelativePath}`, statFingerprint(targetStat));
            if (!targetStat) {
                return { kind: 'move', source: sourceNode, targetAbsolutePath, targetRelativePath };
            }
            assertEntry(targetStat);
            if (sourceNode.stat.isDirectory() && targetStat.isDirectory()) {
                const children = [];
                for (const child of sourceNode.children) {
                    children.push(await compare(
                        child,
                        path.join(targetAbsolutePath, path.posix.basename(child.relativePath)),
                        drivePath(targetRelativePath, path.posix.basename(child.relativePath)),
                    ));
                }
                return { kind: 'merge', source: sourceNode, targetAbsolutePath, targetRelativePath, children };
            }

            const target = await captureTree(targetAbsolutePath, targetRelativePath, 'destination', observations);
            const conflict = {
                path: targetRelativePath,
                existing: metadata(targetRelativePath, target.stat),
                incoming: metadata(sourceNode.relativePath, sourceNode.stat),
            };
            return { kind: 'conflict', source: sourceNode, target, targetAbsolutePath, targetRelativePath, conflict };
        }

        const tree = await compare(source, destinationPath.absolutePath, destinationPath.relativePath);
        const conflicts = [];
        function collectConflicts(node) {
            if (node.kind === 'conflict') conflicts.push(node.conflict);
            for (const child of node.children ?? []) collectConflicts(child);
        }
        collectConflicts(tree);
        conflicts.sort((a, b) => a.path.localeCompare(b.path));
        const fingerprint = createHash('sha256').update(JSON.stringify({
            sourceRoot: sourcePath.relativePath,
            destinationRoot: destinationPath.relativePath,
            observations: [...observations.entries()].sort(([a], [b]) => a.localeCompare(b)),
        })).digest('hex');
        return { tree, conflicts, revision: fingerprint };
    }

    function mergeConflict(plan) {
        return createApiError(codes.DRIVE_MERGE_CONFLICT, 409, {
            revision: plan.revision,
            conflicts: plan.conflicts,
        });
    }

    function mergeChoices(plan, merge) {
        if (merge === undefined) {
            if (plan.conflicts.length) throw mergeConflict(plan);
            return Object.create(null);
        }
        if (!merge || typeof merge !== 'object' || Array.isArray(merge)
            || typeof merge.revision !== 'string' || !merge.choices || typeof merge.choices !== 'object'
            || Array.isArray(merge.choices)) {
            throw createApiError(codes.INVALID_FILE_PATH, 400);
        }
        const choices = Object.create(null);
        for (const [key, value] of Object.entries(merge.choices)) {
            if (value !== null && !['server', 'local', 'both'].includes(value)) {
                throw createApiError(codes.INVALID_FILE_PATH, 400);
            }
            choices[key] = value;
        }
        const expected = plan.conflicts.map(conflict => conflict.path).sort();
        const supplied = Object.keys(choices).sort();
        if (merge.revision !== plan.revision || expected.length !== supplied.length
            || expected.some((path, index) => path !== supplied[index])) {
            throw mergeConflict(plan);
        }
        return choices;
    }

    async function moveEntryToTrash(absolutePath, name, stat, { treeValidated = false } = {}) {
        if (!treeValidated) await assertTree(absolutePath, stat);
        const { absolutePath: trashPath } = await ensureTrashDirectory();
        const manifest = await readTrashManifest();
        for (let number = 0; ; number++) {
            const targetName = number ? numberedName(name, number, stat.isDirectory()) : name;
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
                return {
                    absolutePath,
                    target,
                    targetName,
                    hadManifestEntry,
                    previousTimestamp,
                    expectedIdentity: identityFingerprint(stat),
                };
            } catch (error) {
                if (hadManifestEntry) manifest[targetName] = previousTimestamp;
                else delete manifest[targetName];
                await writeTrashManifest(manifest);
                if (error.code !== 'EEXIST') throw error;
            }
        }
    }

    async function restoreTrashMove(move) {
        const existing = await fs.lstat(move.absolutePath).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (existing) throw new Error(`Cannot restore Drive trash entry over ${move.absolutePath}`);
        const trashed = await fs.lstat(move.target);
        if (JSON.stringify(identityFingerprint(trashed)) !== JSON.stringify(move.expectedIdentity)) {
            throw new Error(`Cannot restore changed Drive trash entry from ${move.target}`);
        }
        await fs.rename(move.target, move.absolutePath);
        const manifest = await readTrashManifest();
        if (move.hadManifestEntry) manifest[move.targetName] = move.previousTimestamp;
        else delete manifest[move.targetName];
        await writeTrashManifest(manifest);
    }

    async function rollbackMerge(journal) {
        const failures = [];
        for (const item of journal.reverse()) {
            try {
                if (item.kind === 'removed-directory') {
                    const existing = await fs.lstat(item.path).catch(error => {
                        if (error.code === 'ENOENT') return null;
                        throw error;
                    });
                    if (existing) throw new Error(`Cannot recreate Drive merge directory over ${item.path}`);
                    await fs.mkdir(item.path);
                } else if (item.kind === 'trash') {
                    await restoreTrashMove(item.move);
                } else if (item.kind === 'copy') {
                    const existing = await fs.lstat(item.path).catch(error => {
                        if (error.code === 'ENOENT') return null;
                        throw error;
                    });
                    if (!existing) continue;
                    if (JSON.stringify(identityFingerprint(existing)) !== JSON.stringify(item.expectedIdentity)) {
                        throw new Error(`Cannot roll back changed Drive copy at ${item.path}`);
                    }
                    await fs.rm(item.path, { recursive: true });
                } else {
                    const existingSource = await fs.lstat(item.from).catch(error => {
                        if (error.code === 'ENOENT') return null;
                        throw error;
                    });
                    if (existingSource) throw new Error(`Cannot roll back Drive merge over ${item.from}`);
                    const existingTarget = await fs.lstat(item.to).catch(error => {
                        if (error.code === 'ENOENT') return null;
                        throw error;
                    });
                    if (!existingTarget) throw new Error(`Cannot find Drive merge item to roll back at ${item.to}`);
                    if (JSON.stringify(identityFingerprint(existingTarget)) !== JSON.stringify(item.expectedIdentity)) {
                        throw new Error(`Cannot roll back changed Drive merge item at ${item.to}`);
                    }
                    await fs.rename(item.to, item.from);
                }
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length) console.error('[Drive] Failed to fully roll back folder merge:', failures);
    }

    async function copyCapturedTree(node, targetPath, plan) {
        await assertCapturedEntry(node, plan);
        if (node.stat.isDirectory()) {
            await fs.mkdir(targetPath, { mode: 0o700 });
            try {
                for (const child of node.children) {
                    await copyCapturedTree(child, path.join(targetPath, path.posix.basename(child.relativePath)), plan);
                }
                await fs.chmod(targetPath, node.stat.mode & 0o777);
                await fs.utimes(targetPath, node.stat.atime, node.stat.mtime);
            } catch (error) {
                await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
                throw error;
            }
            return;
        }

        const source = await fs.open(node.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        let target;
        try {
            const current = await source.stat();
            assertEntry(current);
            if (JSON.stringify(statFingerprint(current)) !== JSON.stringify(statFingerprint(node.stat))) {
                throw mergeConflict(plan);
            }
            target = await fs.open(targetPath, 'wx', node.stat.mode & 0o666);
            try {
                await pipeline(source.createReadStream({ autoClose: false }), target.createWriteStream());
                const after = await source.stat();
                if (JSON.stringify(statFingerprint(after)) !== JSON.stringify(statFingerprint(node.stat))) {
                    throw mergeConflict(plan);
                }
                await fs.utimes(targetPath, node.stat.atime, node.stat.mtime);
            } catch (error) {
                await target.close().catch(() => {});
                target = null;
                await fs.rm(targetPath, { force: true }).catch(() => {});
                throw error;
            }
        } finally {
            if (target) await target.close();
            await source.close();
        }
    }

    async function copyStandaloneEntry(sourcePath, targetPath) {
        const observations = new Map();
        const source = await captureTree(sourcePath.absolutePath, sourcePath.relativePath, 'source', observations);
        const plan = {
            revision: createHash('sha256').update(JSON.stringify([...observations.entries()])).digest('hex'),
            conflicts: [],
        };
        await assertCapturedTree(source, plan);
        let copiedIdentity;
        try {
            await copyCapturedTree(source, targetPath, plan);
            copiedIdentity = identityFingerprint(await fs.lstat(targetPath));
            await assertCapturedTree(source, plan);
        } catch (error) {
            if (copiedIdentity) {
                const existing = await fs.lstat(targetPath).catch(caught => {
                    if (caught.code === 'ENOENT') return null;
                    throw caught;
                });
                if (existing && JSON.stringify(identityFingerprint(existing)) === JSON.stringify(copiedIdentity)) {
                    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
                }
            }
            throw error;
        }
    }

    async function mergeDirectory(sourcePath, destinationPath, merge, { copy = false } = {}) {
        const plan = await collectMergePlan(sourcePath, destinationPath);
        const choices = mergeChoices(plan, merge);
        const journal = [];
        const moves = [];
        const operations = [];
        const emptiedDirectories = [];
        async function planOperations(node, reservedNames) {
            if (node.kind === 'move') {
                operations.push({ source: node.source, targetAbsolutePath: node.targetAbsolutePath, targetRelativePath: node.targetRelativePath });
                return;
            }
            if (node.kind === 'conflict') {
                const choice = choices[node.conflict.path];
                if (choice === null || choice === 'server') return;
                let targetAbsolutePath = node.targetAbsolutePath;
                let targetRelativePath = node.targetRelativePath;
                if (choice === 'both') {
                    const parentRelativePath = path.posix.dirname(targetRelativePath) === '.' ? '' : path.posix.dirname(targetRelativePath);
                    const parentAbsolutePath = path.dirname(targetAbsolutePath);
                    const reserved = reservedNames ?? new Set();
                    const name = path.posix.basename(targetRelativePath);
                    for (let number = 1; ; number++) {
                        const candidate = numberedName(name, number, node.source.stat.isDirectory());
                        if (reserved.has(candidate)) continue;
                        const candidatePath = path.join(parentAbsolutePath, candidate);
                        const existing = await fs.lstat(candidatePath).catch(error => {
                            if (error.code !== 'ENOENT') throw error;
                            return null;
                        });
                        if (existing) continue;
                        reserved.add(candidate);
                        targetAbsolutePath = candidatePath;
                        targetRelativePath = drivePath(parentRelativePath, candidate);
                        break;
                    }
                }
                operations.push({
                    source: node.source,
                    targetAbsolutePath,
                    targetRelativePath,
                    replace: choice === 'local' ? node.target : null,
                });
                return;
            }
            const siblingNames = new Set(node.children.map(child => path.posix.basename(child.source.relativePath)));
            for (const child of node.children) await planOperations(child, siblingNames);
            if (!copy) emptiedDirectories.push(node);
        }
        await planOperations(plan.tree);

        let trashChanged = false;
        try {
            for (const operation of operations) {
                if (!copy) await assertCapturedTree(operation.source, plan);
                if (operation.replace) {
                    await assertCapturedTree(operation.replace, plan);
                    const trashMove = await moveEntryToTrash(
                        operation.replace.absolutePath,
                        path.posix.basename(operation.targetRelativePath),
                        operation.replace.stat,
                        { treeValidated: true },
                    );
                    trashChanged = true;
                    journal.push({ kind: 'trash', move: trashMove });
                }
                const targetExists = await fs.lstat(operation.targetAbsolutePath).catch(error => {
                    if (error.code === 'ENOENT') return null;
                    throw error;
                });
                if (targetExists) throw createApiError(codes.DRIVE_ALREADY_EXISTS, 409);
                await assertCapturedTree(operation.source, plan);
                if (copy) {
                    await copyCapturedTree(operation.source, operation.targetAbsolutePath, plan);
                    const copied = await fs.lstat(operation.targetAbsolutePath);
                    journal.push({ kind: 'copy', path: operation.targetAbsolutePath, expectedIdentity: identityFingerprint(copied) });
                    await assertCapturedTree(operation.source, plan);
                } else {
                    await fs.rename(operation.source.absolutePath, operation.targetAbsolutePath);
                    journal.push({
                        kind: 'move',
                        from: operation.source.absolutePath,
                        to: operation.targetAbsolutePath,
                        expectedIdentity: identityFingerprint(operation.source.stat),
                    });
                    moves.push({ from: operation.source.relativePath, to: operation.targetRelativePath });
                }
            }

            for (const node of emptiedDirectories) {
                const current = await fs.lstat(node.source.absolutePath).catch(error => {
                    if (error.code === 'ENOENT') throw mergeConflict(plan);
                    throw error;
                });
                assertEntry(current);
                if (!current.isDirectory()
                    || JSON.stringify(identityFingerprint(current)) !== JSON.stringify(identityFingerprint(node.source.stat))) {
                    throw mergeConflict(plan);
                }
                const remaining = await fs.readdir(node.source.absolutePath);
                if (remaining.length) continue;
                try {
                    await fs.rmdir(node.source.absolutePath);
                    journal.push({ kind: 'removed-directory', path: node.source.absolutePath });
                    moves.push({ from: node.source.relativePath, to: node.targetRelativePath });
                } catch (error) {
                    if (error.code !== 'ENOTEMPTY') throw error;
                }
            }
        } catch (error) {
            await rollbackMerge(journal);
            if (trashChanged) void scheduleTrashCleanup();
            throw error;
        }
        if (trashChanged) void scheduleTrashCleanup();

        const { stat } = await resolveEntry(destinationPath.relativePath);
        return copy
            ? { entry: metadata(destinationPath.relativePath, stat) }
            : { entry: metadata(destinationPath.relativePath, stat), moves };
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

    function numberedName(name, number, directory = false) {
        const extension = directory ? '' : path.extname(name);
        const stem = Array.from(name.slice(0, name.length - extension.length));
        const suffix = ` (${number})${extension}`;
        while (stem.length && Buffer.byteLength(stem.join('') + suffix) > 255) stem.pop();
        if (!stem.length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        return validateName(stem.join('') + suffix);
    }

    async function publishEntry(parent, name, conflict, directory, write) {
        for (let number = 0; ; number++) {
            const finalName = number ? numberedName(name, number, directory) : name;
            try {
                const target = await destination(parent, finalName, conflict === 'overwrite');
                await write(target);
                return metadata(parent ? `${parent}/${finalName}` : finalName, await fs.lstat(target));
            } catch (error) {
                if (conflict !== 'rename' || !['EEXIST', codes.DRIVE_ALREADY_EXISTS].includes(error.code)) throw error;
            }
        }
    }

    function publishFile(sourcePath, parent, name, conflict) {
        return publishEntry(parent, name, conflict, false, async target => {
            if (conflict === 'overwrite') {
                // Publish atomically, keeping the destination intact until its replacement is ready.
                await fs.rename(sourcePath, target);
            } else {
                // link() also rejects files created by an external writer after the destination check.
                await fs.link(sourcePath, target);
                await fs.unlink(sourcePath);
            }
        });
    }

    async function copyFileEntry(sourcePath, parent, name, conflict) {
        return publishEntry(parent, name, conflict, false, async target => {
            if (conflict !== 'overwrite') return copyStandaloneEntry(sourcePath, target);
            const temporaryPath = path.join(path.dirname(target), UPLOAD_PREFIX + randomUUID());
            try {
                await copyStandaloneEntry(sourcePath, temporaryPath);
                await fs.rename(temporaryPath, target);
            } finally {
                await fs.rm(temporaryPath, { force: true });
            }
        });
    }

    async function transferEntry(body, copy) {
        const relativePath = body?.path;
        const parts = pathParts(relativePath);
        if (!parts.length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        rejectTrashPath(parts);
        const name = validateName(body?.name);
        const conflict = conflictPolicy(body?.conflict);
        const source = await resolveEntry(relativePath);
        const sourceParent = parts.slice(0, -1).join('/');
        const destinationParent = body?.destination === undefined ? sourceParent : body.destination;
        assertWritableDestination(destinationParent, name);
        const destinationEntry = await resolveEntry(destinationParent, true);
        if (source.stat.isDirectory()) {
            const destinationFromSource = path.relative(source.absolutePath, destinationEntry.absolutePath);
            if (destinationFromSource === ''
                || (!path.isAbsolute(destinationFromSource) && destinationFromSource !== '..'
                    && !destinationFromSource.startsWith(`..${path.sep}`))) {
                throw createApiError(codes.INVALID_FILE_PATH, 400);
            }
        }

        const targetRelativePath = drivePath(destinationParent, name);
        if (!copy && targetRelativePath === relativePath) {
            return { entry: metadata(relativePath, source.stat), moves: [] };
        }

        const existing = await optionalEntry(targetRelativePath, destinationEntry.absolutePath);
        const mergeProvided = body?.merge !== undefined;
        if (mergeProvided && conflict !== 'overwrite') {
            throw createApiError(codes.INVALID_FILE_PATH, 400);
        }
        if (mergeProvided && (!source.stat.isDirectory() || (existing && !existing.stat.isDirectory()))) {
            throw createApiError(codes.DRIVE_NOT_FOUND, 404);
        }
        if (copy && targetRelativePath === relativePath && conflict === 'overwrite') {
            if (mergeProvided) throw createApiError(codes.INVALID_FILE_PATH, 400);
            return { entry: metadata(relativePath, source.stat) };
        }
        if (source.stat.isDirectory() && conflict === 'overwrite'
            && (mergeProvided || existing?.stat.isDirectory())) {
            const result = await mergeDirectory(
                { absolutePath: source.absolutePath, relativePath },
                {
                    absolutePath: existing?.absolutePath ?? path.join(destinationEntry.absolutePath, name),
                    relativePath: targetRelativePath,
                },
                body?.merge,
                { copy },
            );
            return copy ? { entry: result.entry } : result;
        }
        if (existing && conflict === 'overwrite' && source.stat.isDirectory() !== existing.stat.isDirectory()) {
            throw createApiError(codes.DRIVE_ALREADY_EXISTS, 409);
        }

        let entry;
        if (copy) {
            entry = source.stat.isFile()
                ? await copyFileEntry({ absolutePath: source.absolutePath, relativePath }, destinationParent, name, conflict)
                : await publishEntry(destinationParent, name, conflict, true, target => (
                    copyStandaloneEntry({ absolutePath: source.absolutePath, relativePath }, target)
                ));
        } else {
            entry = source.stat.isFile()
                ? await publishFile(source.absolutePath, destinationParent, name, conflict)
                : await publishEntry(destinationParent, name, conflict, true, target => fs.rename(source.absolutePath, target));
        }
        return copy ? { entry } : { entry, moves: [{ from: relativePath, to: entry.path }] };
    }

    async function streamZipFolder(res, tree) {
        const { ZipWriter } = await getZip();
        const archiveChanged = () => createApiError(codes.DRIVE_UNAVAILABLE, 500);
        const abortController = new AbortController();
        const zip = new ZipWriter(Writable.toWeb(res), { useWebWorkers: false, zip64: true });

        const onClose = () => {
            if (res.writableFinished) return;
            abortController.abort(new Error('Drive download aborted'));
        };
        res.once('close', onClose);

        async function addDirectory(archivePath) {
            await zip.add(`${archivePath}/`, null, {
                directory: true,
                compressionMethod: 0,
                signal: abortController.signal,
                useWebWorkers: false,
            });
        }

        async function addFile(node, archivePath) {
            const { file, stat } = await openFile(node.relativePath);
            let input;
            try {
                if (JSON.stringify(statFingerprint(stat)) !== JSON.stringify(statFingerprint(node.stat))) {
                    throw archiveChanged();
                }
                input = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
                let streamed = 0;
                const readable = Readable.toWeb(input).pipeThrough(new TransformStream({
                    transform(chunk, controller) {
                        if (streamed + chunk.byteLength > node.stat.size) throw archiveChanged();
                        streamed += chunk.byteLength;
                        controller.enqueue(chunk);
                    },
                }));
                await zip.add(archivePath, readable, {
                    compressionMethod: 0,
                    signal: abortController.signal,
                    useWebWorkers: false,
                });
                if (streamed !== node.stat.size) throw archiveChanged();
                const after = await file.stat();
                if (JSON.stringify(statFingerprint(node.stat)) !== JSON.stringify(statFingerprint(after))) {
                    throw archiveChanged();
                }
            } finally {
                input?.destroy();
                await file.close();
            }
        }

        async function addTree(node, archivePath) {
            await currentCapturedStat(node, archiveChanged);
            if (node.stat.isDirectory()) {
                await addDirectory(archivePath);
                for (const child of node.children) {
                    await addTree(child, `${archivePath}/${path.posix.basename(child.relativePath)}`);
                }
                await currentCapturedStat(node, archiveChanged);
            } else {
                await addFile(node, archivePath);
            }
        }

        try {
            await addTree(tree, path.posix.basename(tree.relativePath));
            await zip.close();
        } catch (error) {
            abortController.abort(error);
            if (!res.destroyed) res.destroy(error);
            throw error;
        } finally {
            res.off('close', onClose);
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
                if (res.headersSent) {
                    res.destroy(error);
                    return;
                }
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
        const conflict = conflictPolicy(req.body?.conflict);
        const entry = await mutate(async () => {
            assertWritableDestination(parent, name);
            if (conflict === 'overwrite') {
                const existing = await optionalEntry(drivePath(parent, name));
                if (existing) {
                    if (!existing.stat.isDirectory()) throw createApiError(codes.DRIVE_ALREADY_EXISTS, 409);
                    return metadata(drivePath(parent, name), existing.stat);
                }
            }
            return publishEntry(parent, name, conflict, true, target => fs.mkdir(target));
        });
        res.status(201).json({ entry });
    });

    route('patch', '/api/drive/rename', async (req, res) => {
        res.json(await mutate(() => transferEntry(req.body, false)));
    });

    route('post', '/api/drive/copy', async (req, res) => {
        res.json(await mutate(() => transferEntry(req.body, true)));
    });

    route('delete', '/api/drive/entry', async (req, res) => {
        const relativePath = req.body?.path;
        const parts = pathParts(relativePath);
        if (!parts.length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        rejectTrashPath(parts);
        await mutate(async () => {
            const { absolutePath, stat } = await resolveEntry(relativePath);
            await moveEntryToTrash(absolutePath, parts.at(-1), stat);
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
        const conflict = conflictPolicy(req.query.conflict);
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
            const entry = await mutate(() => publishFile(temporaryPath, relativePath, name, conflict));
            res.status(201).json({ entry });
        } finally {
            await fs.rm(temporaryPath, { force: true });
        }
    });

    route('get', '/api/drive/thumbnail', async (req, res) => {
        const relativePath = req.query.path;
        const { stat } = await resolveEntry(relativePath);
        if (!stat.isFile()) throw createApiError(codes.DRIVE_UNSUPPORTED_ENTRY, 403);
        const fingerprint = JSON.stringify(statFingerprint(stat));
        const etag = `"${createHash('sha256').update(fingerprint).digest('hex')}"`;
        res.set('Cache-Control', 'private, no-cache, no-transform');
        res.set('ETag', etag);
        if (req.fresh) return res.status(304).end();

        const build = thumbnailQueue.then(async () => {
            if (res.destroyed) return null;
            const { file, stat: openedStat } = await openFile(relativePath);
            try {
                if (JSON.stringify(statFingerprint(openedStat)) !== fingerprint) return null;
                try {
                    const input = await readDrivePreview(file, relativePath, openedStat);
                    return input && !res.destroyed ? await encodeThumbnail(input) : null;
                } catch {
                    return null;
                }
            } finally {
                await file.close();
            }
        });
        thumbnailQueue = build.then(() => {}, () => {});
        const thumbnail = await build;
        if (res.destroyed) return;
        if (!thumbnail) {
            res.removeHeader('ETag');
            res.set('Cache-Control', 'no-store, no-transform');
            return res.status(204).end();
        }
        res.type('image/webp');
        res.set('X-Content-Type-Options', 'nosniff');
        res.send(thumbnail.buffer);
    }, true);

    route('get', '/api/drive/download', async (req, res) => {
        const relativePath = req.query.path;
        const parts = pathParts(relativePath);
        if (!parts.length) throw createApiError(codes.INVALID_FILE_PATH, 400);
        const resolved = await resolveEntry(relativePath);
        if (resolved.stat.isDirectory()) {
            const tree = await captureTree(resolved.absolutePath, relativePath, 'download', new Map());
            res.attachment(`${path.posix.basename(relativePath)}.zip`);
            res.type('application/zip');
            res.set('X-Content-Type-Options', 'nosniff');
            await streamZipFolder(res, tree);
            return;
        }
        const { file, stat } = await openFile(relativePath);
        try {
            res.attachment(path.posix.basename(relativePath));
            res.type('application/octet-stream');
            res.set('X-Content-Type-Options', 'nosniff');
            res.set('Content-Length', String(stat.size));
            await pipeline(file.createReadStream(), res);
        } finally {
            await file.close();
        }
    }, true);

    void runTrashCleanup();
    return { stopTrashCleanup, refreshTrashRetention };
}

module.exports = { installDriveRoutes };
