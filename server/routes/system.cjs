'use strict';

const { readFileSync } = require('fs');
const path = require('path');
const { logger } = require('../logs/logs.cjs');

const RELEASE_TAG_PREFIX = 'kei-v';
const UPDATE_CHECK_URL = 'https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest';
const PUBLIC_STATS_URL = 'https://risu-update-worker.nodridan.workers.dev/api/public-stats';

function getCurrentVersion() {
    try {
        const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch { return '0.0.0'; }
}

function compareVersions(left, right) {
    const parse = (value) => {
        const [core, prerelease = ''] = value.split('-', 2);
        return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), prerelease };
    };
    const a = parse(left);
    const b = parse(right);
    for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
        const difference = (a.core[i] || 0) - (b.core[i] || 0);
        if (difference !== 0) return Math.sign(difference);
    }
    if (a.prerelease === b.prerelease) return 0;
    if (!a.prerelease) return 1;
    if (!b.prerelease) return -1;
    return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

async function checkForUpdate() {
    const currentVersion = getCurrentVersion();
    const noUpdate = { currentVersion, latestVersion: currentVersion, hasUpdate: false, releaseNotes: '' };
    try {
        const res = await fetch(UPDATE_CHECK_URL, {
            headers: { 'User-Agent': 'PocketRisu-Kei', Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) {
            await res.body?.cancel();
            return noUpdate;
        }
        const release = await res.json();
        const tag = String(release?.tag_name || '').trim();
        if (!tag.toLowerCase().startsWith(RELEASE_TAG_PREFIX)) return noUpdate;

        const latestVersion = tag.slice(RELEASE_TAG_PREFIX.length);
        if (compareVersions(latestVersion, currentVersion) <= 0) return noUpdate;

        logger.info(`[Update] New version available: v${latestVersion} (current: v${currentVersion})`);
        return { currentVersion, latestVersion, hasUpdate: true, releaseNotes: release?.body || '' };
    } catch (e) {
        logger.error('[Update] Failed to check for updates:', e.message);
        return noUpdate;
    }
}

function installSystemRoutes(app) {
    app.get('/api/public-stats', async (req, res) => {
        try {
            const r = await fetch(PUBLIC_STATS_URL);
            if (!r.ok) {
                await r.body?.cancel();
                res.status(r.status).json({ error: 'upstream error' });
                return;
            }
            res.json(await r.json());
        } catch {
            res.status(502).json({ error: 'fetch failed' });
        }
    });

    app.get('/api/update-check', async (req, res) => {
        res.json(await checkForUpdate());
    });
}

module.exports = { installSystemRoutes };
