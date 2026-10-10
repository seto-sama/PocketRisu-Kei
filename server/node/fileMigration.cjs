'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ORIGIN_RETENTION_MS = 24 * 60 * 60 * 1000;
let cleanupTimer;

function paths(saveDir, name) {
    const root = path.join(saveDir, 'migration');
    return {
        state: path.join(root, `${name}.json`),
        origin: path.join(root, 'origin', name),
        tmp: path.join(root, 'tmp', name),
    };
}

function databaseFiles(filename) {
    return [filename, `${filename}-wal`, `${filename}-shm`];
}

function writeState(location, state) {
    fs.writeFileSync(`${location}.tmp`, JSON.stringify(state), { flush: true });
    fs.renameSync(`${location}.tmp`, location);
}

function states(saveDir) {
    const root = path.join(saveDir, 'migration');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(filename => filename.endsWith('.json'))
        .map(filename => JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8')));
}

function restoreTargets(saveDir, state) {
    const { origin } = paths(saveDir, state.name);
    for (const filename of state.targets.flatMap(databaseFiles)) {
        if (state.backedUp.includes(filename)) {
            fs.copyFileSync(path.join(origin, filename), path.join(saveDir, filename));
        } else {
            fs.rmSync(path.join(saveDir, filename), { force: true });
        }
    }
}

function finishMigration(saveDir, state) {
    for (const filename of state.sources.filter(filename => !state.targets.includes(filename)).flatMap(databaseFiles)) {
        fs.rmSync(path.join(saveDir, filename), { force: true });
    }
    fs.rmSync(paths(saveDir, state.name).tmp, { recursive: true, force: true });
}

function recoveryFailure(name, origin, cause) {
    return new Error(`Migration ${name} could not restore its files. Restore the backups in ${origin} and restart the server.`, { cause });
}

function recoverFileMigrations(saveDir) {
    for (const state of states(saveDir)) {
        const location = paths(saveDir, state.name);
        if (state.phase === 'complete') {
            finishMigration(saveDir, state);
            continue;
        }
        if (state.phase === 'installing') {
            try { restoreTargets(saveDir, state); }
            catch (error) { throw recoveryFailure(state.name, location.origin, error); }
        }
        fs.rmSync(location.tmp, { recursive: true, force: true });
        state.phase = 'failed';
        writeState(location.state, state);
    }
    cleanupMigrationOrigins(saveDir);
}

function runFileMigration({ saveDir, name, sources, targets, build }) {
    const location = paths(saveDir, name);
    fs.rmSync(location.origin, { recursive: true, force: true });
    fs.rmSync(location.tmp, { recursive: true, force: true });
    fs.mkdirSync(location.origin, { recursive: true });
    fs.mkdirSync(location.tmp, { recursive: true });
    const backedUp = [...new Set([...sources, ...targets].flatMap(databaseFiles))]
        .filter(filename => fs.existsSync(path.join(saveDir, filename)));
    for (const filename of backedUp) {
        fs.copyFileSync(path.join(saveDir, filename), path.join(location.origin, filename));
    }
    const state = { name, sources, targets, backedUp, phase: 'building' };
    writeState(location.state, state);
    try {
        build(location.tmp, location.origin);
        state.phase = 'installing';
        writeState(location.state, state);
        for (const filename of targets) {
            for (const sidecar of databaseFiles(filename).slice(1)) {
                fs.rmSync(path.join(saveDir, sidecar), { force: true });
            }
            fs.renameSync(path.join(location.tmp, filename), path.join(saveDir, filename));
        }
        state.phase = 'complete';
        state.completedAt = Date.now();
        state.retainUntil = state.completedAt + ORIGIN_RETENTION_MS;
        writeState(location.state, state);
    } catch (error) {
        try {
            if (state.phase === 'installing' || state.phase === 'complete') restoreTargets(saveDir, state);
            fs.rmSync(location.tmp, { recursive: true, force: true });
            state.phase = 'failed';
            writeState(location.state, state);
        } catch (recoveryError) {
            throw recoveryFailure(name, location.origin, new AggregateError([error, recoveryError]));
        }
        throw new Error(`Migration ${name} failed. Original files were preserved; restart the server to retry.`, { cause: error });
    }
    finishMigration(saveDir, state);
}

function cleanupMigrationOrigins(saveDir, now = Date.now()) {
    for (const state of states(saveDir)) {
        if (state.phase !== 'complete' || state.retainUntil > now) continue;
        const location = paths(saveDir, state.name);
        try {
            fs.rmSync(location.origin, { recursive: true, force: true });
            fs.rmSync(location.state, { force: true });
        } catch (error) {
            console.error('[Migration] Failed to remove expired originals:', error);
        }
    }
}

function scheduleMigrationCleanup(saveDir) {
    clearTimeout(cleanupTimer);
    const deadlines = states(saveDir).filter(state => state.phase === 'complete').map(state => state.retainUntil);
    if (deadlines.length === 0) return;
    cleanupTimer = setTimeout(() => {
        cleanupMigrationOrigins(saveDir);
        scheduleMigrationCleanup(saveDir);
    }, Math.max(60 * 1000, Math.min(...deadlines) - Date.now()));
    cleanupTimer.unref();
}

module.exports = { runFileMigration, recoverFileMigrations, cleanupMigrationOrigins, scheduleMigrationCleanup };
