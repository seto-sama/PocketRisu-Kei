'use strict';

const { readFileSync, existsSync, writeFileSync } = require('fs');
const path = require('path');
const { logger } = require('../logs/logs.cjs');
const os = require('os');
const fs = require('fs/promises');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execSync, spawn } = require('child_process');
const { checkpointWal } = require('../db.cjs');

function installSystemRoutes(app, {
    instanceId,
    checkAuth,
    stopTunnel,
    flushPendingDb,
}) {
    const GITHUB_REPO = 'seto-sama/PocketRisu-Kei';

    const UPDATE_CHECK_DISABLED = process.env.RISU_UPDATE_CHECK === 'false';

    const CUSTOM_UPDATE_CHECK_URL = process.env.RISU_UPDATE_URL || '';

    const UPDATE_CHECK_URL = CUSTOM_UPDATE_CHECK_URL || `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

    const PUBLIC_STATS_URL = UPDATE_CHECK_DISABLED
        ? ''
        : (CUSTOM_UPDATE_CHECK_URL || 'https://risu-update-worker.nodridan.workers.dev/check')
            .replace(/\/check$/, '/api/public-stats');

    function getCurrentVersion() {
        try {
            const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
            return pkg.version || '0.0.0';
        } catch { return '0.0.0'; }
    }

    const deploymentType = (() => {
        // Only portable builds have the .portable marker (created by CI release workflow).
        // Self-update is gated on this — all other types are inferred for analytics only.
        // Wrapped in try/catch so unexpected filesystem errors can't crash server boot.
        try {
            if (existsSync(path.join(process.cwd(), '.portable'))) return 'portable';
            if (existsSync(path.join(process.cwd(), '.git'))) return 'git';
            if (existsSync('/.dockerenv')) return 'docker';
            try {
                const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
                if (cgroup.includes('docker') || cgroup.includes('containerd')) return 'docker';
            } catch {}
            if (process.platform === 'android') return 'termux';
        } catch {}
        return 'unknown';
    })();

    function getSelfUpdateAssetInfo(version) {
        const platformMap = { win32: 'win', linux: 'linux', darwin: 'macos' };
        const platformName = platformMap[process.platform];
        if (!platformName) return null;
        const arch = process.arch; // x64, arm64
        const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
        const filename = `PocketRisu-v${version}-${platformName}-${arch}.${ext}`;
        const url = `https://github.com/${GITHUB_REPO}/releases/download/kei-v${version}/${filename}`;
        return { platformName, arch, ext, filename, url };
    }

    async function fetchLatestRelease(lang) {
        if (UPDATE_CHECK_DISABLED) return null;
        try {
            const currentVersion = getCurrentVersion();
            let url = UPDATE_CHECK_URL;
            const headers = { 'User-Agent': 'PocketRisu-Kei-Updater', Accept: 'application/vnd.github+json' };

            if (CUSTOM_UPDATE_CHECK_URL) {
                const params = new URLSearchParams({
                    v: currentVersion,
                    d: deploymentType,
                    os: `${process.platform}-${process.arch}`,
                    id: instanceId,
                });
                if (lang) params.set('l', String(lang).slice(0, 16));
                url = `${UPDATE_CHECK_URL}?${params}`;
            }

            const res = await fetch(url, { headers });
            if (!res.ok) return null;
            const data = await res.json();

            const updateInfo = CUSTOM_UPDATE_CHECK_URL
                ? data
                : normalizeGitHubRelease(data, currentVersion);

            if (updateInfo.hasUpdate) {
                console.log(`[Update] New version available: v${updateInfo.latestVersion} (current: v${currentVersion}, ${updateInfo.severity})`);
            }
            return updateInfo;
        } catch (e) {
            logger.error('[Update] Failed to check for updates:', e.message);
            return null;
        }
    }

    function compareReleaseVersions(left, right) {
        const parse = (value) => {
            const normalized = normalizeReleaseVersion(value);
            const [core, prerelease = ''] = normalized.split('-', 2);
            return {
                core: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
                prerelease,
            };
        };
        const a = parse(left);
        const b = parse(right);
        const length = Math.max(a.core.length, b.core.length, 3);

        for (let i = 0; i < length; i++) {
            const difference = (a.core[i] || 0) - (b.core[i] || 0);
            if (difference !== 0) return Math.sign(difference);
        }
        if (a.prerelease === b.prerelease) return 0;
        if (!a.prerelease) return 1;
        if (!b.prerelease) return -1;
        return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
    }

    function normalizeReleaseVersion(value) {
        return String(value || '').trim().replace(/^(?:kei-)?v/i, '');
    }

    function normalizeGitHubRelease(release, currentVersion) {
        const latestVersion = normalizeReleaseVersion(release?.tag_name);
        const hasUpdate = !!latestVersion && compareReleaseVersions(latestVersion, currentVersion) > 0;
        return {
            currentVersion,
            latestVersion: latestVersion || currentVersion,
            hasUpdate,
            severity: hasUpdate ? 'optional' : 'none',
            releaseUrl: release?.html_url || `https://github.com/${GITHUB_REPO}/releases`,
            releaseName: release?.name || release?.tag_name || '',
            publishedAt: release?.published_at || '',
            popupMessage: release?.body || '',
            manualOnly: false,
        };
    }

    app.get('/api/public-stats', async (req, res) => {
        if (!PUBLIC_STATS_URL) {
            res.status(204).end();
            return;
        }
        try {
            const r = await fetch(PUBLIC_STATS_URL);
            if (!r.ok) { res.status(r.status).json({ error: 'upstream error' }); return; }
            const data = await r.json();
            res.json(data);
        } catch {
            res.status(502).json({ error: 'fetch failed' });
        }
    });

    app.get('/api/update-check', async (req, res) => {
        const currentVersion = getCurrentVersion();
        if (UPDATE_CHECK_DISABLED) {
            res.json({ currentVersion, hasUpdate: false, severity: 'none', disabled: true, deploymentType, canSelfUpdate: false });
            return;
        }
        const result = await fetchLatestRelease(req.query.lang);
        const response = result || { currentVersion, hasUpdate: false, severity: 'none' };
        response.deploymentType = deploymentType;
        response.canSelfUpdate = deploymentType === 'portable'
            && !!response.hasUpdate
            && !response.manualOnly
            && !!getSelfUpdateAssetInfo(response.latestVersion);
        res.json(response);
    });

    let selfUpdateInProgress = false;

    app.post('/api/self-update', async (req, res) => {
        if (!await checkAuth(req, res)) return;

        if (deploymentType !== 'portable') {
            res.status(400).json({ error: 'Self-update is only available for portable deployments' });
            return;
        }
        if (selfUpdateInProgress) {
            res.status(409).json({ error: 'Update already in progress' });
            return;
        }
        selfUpdateInProgress = true;

        // Track client disconnect — used to abort download, but NOT to release the lock.
        // The lock stays held until the update fully completes or fails, preventing
        // a second request from touching the same install directory concurrently.
        let clientDisconnected = false;
        res.on('close', () => {
            clientDisconnected = true;
            console.log('[Update] Client disconnected (update continues if past download stage).');
        });

        // NDJSON streaming response
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        });
        const send = (step, progress, message) => {
            try { res.write(JSON.stringify({ step, progress, message }) + '\n'); } catch {}
        };

        let tmpDir = null;
        try {
            // 1. Check update
            send('checking', 0, 'Checking for updates...');
            const updateInfo = await fetchLatestRelease();
            if (!updateInfo?.hasUpdate) {
                send('done', 100, 'Already up to date.');
                res.end();
                selfUpdateInProgress = false;
                return;
            }

            const targetVersion = updateInfo.latestVersion;
            const assetInfo = getSelfUpdateAssetInfo(targetVersion);
            if (!assetInfo) {
                throw new Error(`No release asset for ${process.platform}-${process.arch}`);
            }

            // 2. Download
            tmpDir = path.join(os.tmpdir(), `risu-update-${Date.now()}`);
            await fs.mkdir(tmpDir, { recursive: true });
            const archivePath = path.join(tmpDir, assetInfo.filename);

            send('downloading', 0, 'Starting download...');
            const dlRes = await fetch(assetInfo.url, { redirect: 'follow' });
            if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status} ${dlRes.statusText}`);

            const totalSize = parseInt(dlRes.headers.get('content-length'), 10) || 0;
            const fileStream = require('fs').createWriteStream(archivePath);
            let downloaded = 0;
            let lastPct = -1;

            const progress = new Transform({
                transform(chunk, _enc, cb) {
                    if (clientDisconnected) { cb(new Error('Client disconnected')); return; }
                    downloaded += chunk.length;
                    if (totalSize > 0) {
                        const pct = Math.round((downloaded / totalSize) * 100);
                        if (pct >= lastPct + 5) {
                            lastPct = pct;
                            const dlMB = (downloaded / 1048576).toFixed(0);
                            const totalMB = (totalSize / 1048576).toFixed(0);
                            send('downloading', pct, `Downloading... ${pct}% (${dlMB}/${totalMB} MB)`);
                        }
                    }
                    cb(null, chunk);
                },
            });
            await pipeline(Readable.fromWeb(dlRes.body), progress, fileStream);
            send('downloading', 100, 'Download complete.');

            // 3. Extract
            send('extracting', null, 'Extracting...');
            const extractDir = path.join(tmpDir, 'extracted');
            await fs.mkdir(extractDir, { recursive: true });

            if (process.platform === 'win32') {
                try {
                    // Windows 10 1803+ has tar.exe built-in, handles zip, much faster than PowerShell
                    execSync(`tar -xf "${archivePath}" -C "${extractDir}"`, { timeout: 300000 });
                } catch {
                    execSync(
                        `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${extractDir}'"`,
                        { timeout: 300000 },
                    );
                }
            } else {
                execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, { timeout: 300000 });
            }

            // Resolve possibly nested root directory (same as updater.cjs resolveExtractedRoot)
            const entries = await fs.readdir(extractDir);
            let sourceDir = extractDir;
            if (entries.length === 1) {
                const candidate = path.join(extractDir, entries[0]);
                if ((await fs.stat(candidate)).isDirectory()) sourceDir = candidate;
            }

            // 4. Validate extracted package (mirrors updater.cjs validateExtractedRoot)
            const REQUIRED_ENTRIES = ['dist', 'server', 'package.json'];
            const REQUIRED_DIST_FILES = ['index.html'];
            for (const entry of REQUIRED_ENTRIES) {
                try { await fs.access(path.join(sourceDir, entry)); }
                catch { throw new Error(`Downloaded package is missing required entry: ${entry}`); }
            }
            for (const file of REQUIRED_DIST_FILES) {
                try { await fs.access(path.join(sourceDir, 'dist', file)); }
                catch { throw new Error(`Downloaded package is missing dist/${file}`); }
            }
            if (process.platform === 'win32') {
                try { await fs.access(path.join(sourceDir, 'bin')); }
                catch { throw new Error('Downloaded Windows package is missing bin/'); }
            }

            // 5. Replace files (follows updater.cjs Phase 1-4 pattern)
            // Stop tunnel before replacing files to avoid file lock issues
            stopTunnel();
            send('replacing', null, 'Replacing files...');
            const appDir = process.cwd();
            const isWin = process.platform === 'win32';
            const updateTmp = path.join(appDir, '.update-tmp');

            // Restore from a previous interrupted update only when its in-progress
            // marker is still there. A leftover backup/ alone is not proof of an
            // interrupted update: on Windows the running launcher exe keeps
            // backup/PocketRisu.exe locked, so the restart script's rmdir leaves
            // the folder behind after a SUCCESSFUL update — restoring from it
            // would roll the app back to the previous version.
            const prevBackup = path.join(updateTmp, 'backup');
            const inProgressMarker = path.join(updateTmp, 'in-progress');
            if (existsSync(inProgressMarker) && existsSync(prevBackup)) {
                console.log('[Update] Restoring files from previous interrupted update...');
                await restoreBackup(prevBackup, appDir);
            }
            await fs.rm(updateTmp, { recursive: true, force: true }).catch(() => {});
            await fs.mkdir(updateTmp, { recursive: true });

            // Carry over SSL certificates into new package before swap
            const sslSrc = path.join(appDir, 'server', 'node', 'ssl', 'certificate');
            try {
                await fs.access(sslSrc);
                const sslDst = path.join(sourceDir, 'server', 'node', 'ssl', 'certificate');
                await fs.mkdir(path.dirname(sslDst), { recursive: true });
                await fs.cp(sslSrc, sslDst, { recursive: true });
            } catch { /* no user certs */ }

            // Keep set — matches updater.cjs + user data/config that must survive updates
            const keep = new Set(['save', 'backups', '.installed-version', '.update-tmp', 'scripts', '.env', '.npmrc', '.portable']);
            if (isWin) keep.add('bin');

            // Phase 1: move old files to backup — rollback immediately on any failure
            const backupDir = path.join(updateTmp, 'backup');
            await fs.mkdir(backupDir, { recursive: true });
            // Present only while app files are being replaced. A leftover backup
            // after a successful update must never roll back the installed release.
            await fs.writeFile(inProgressMarker, `v${targetVersion}`);


            const oldEntries = await fs.readdir(appDir);
            for (const e of oldEntries) {
                if (keep.has(e)) continue;
                try {
                    await fs.rename(path.join(appDir, e), path.join(backupDir, e));
                } catch (backupErr) {
                    logger.error(`[Update] Failed to back up ${e}: ${backupErr.message}`);
                    console.log('[Update] Restoring files already moved to backup...');
                    await restoreBackup(backupDir, appDir);
                    throw new Error(isWin
                        ? 'Update failed: some files are in use. Close RisuAI first, then try again.'
                        : 'Update failed: some files are in use. Stop the server first, then try again.');
                }
            }

            // Phase 2: move new files from extracted to app root
            const skipMove = new Set(['save', 'scripts']);
            if (isWin) skipMove.add('bin');
            const moved = [];
            try {
                const newEntries = await fs.readdir(sourceDir);
                for (const e of newEntries) {
                    if (skipMove.has(e)) continue;
                    const dest = path.join(appDir, e);
                    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
                    await moveAcrossVolumes(path.join(sourceDir, e), dest);
                    moved.push(e);
                }
                // Post-move validation
                for (const entry of REQUIRED_ENTRIES) {
                    if (!moved.includes(entry) && !existsSync(path.join(appDir, entry))) {
                        throw new Error(`Required entry was not installed: ${entry}`);
                    }
                }
                for (const file of REQUIRED_DIST_FILES) {
                    if (!existsSync(path.join(appDir, 'dist', file))) {
                        throw new Error(`Required file was not installed: dist/${file}`);
                    }
                }
            } catch (moveErr) {
                logger.error(`[Update] Move failed: ${moveErr.message}`);
                console.log('[Update] Restoring from backup...');
                await restoreBackup(backupDir, appDir);
                throw new Error('Update failed, previous version restored. Please try again.');
            }

            // Phase 3: update scripts/ from new release
            const newScripts = path.join(sourceDir, 'scripts');
            try {
                await fs.access(newScripts);
                await fs.mkdir(path.join(appDir, 'scripts'), { recursive: true });
                for (const f of await fs.readdir(newScripts)) {
                    await fs.copyFile(path.join(newScripts, f), path.join(appDir, 'scripts', f));
                }
            } catch { /* no scripts in release */ }

            // The app files are complete and verified; keep successful-update
            // leftovers from being mistaken for an interrupted replacement.
            await fs.rm(inProgressMarker, { force: true }).catch(() => {});

            // Phase 4 (Windows): stage bin/ for restart script to apply after exit
            if (isWin) {
                const newBin = path.join(sourceDir, 'bin');
                const stagedBin = path.join(updateTmp, 'new-bin');
                await fs.rm(stagedBin, { recursive: true, force: true }).catch(() => {});
                await fs.cp(newBin, stagedBin, { recursive: true });
                // Version marker — finalized after bin/ is applied
                await fs.writeFile(path.join(updateTmp, 'latest-version'), `v${targetVersion}`);
            } else {
                await fs.writeFile(path.join(appDir, '.installed-version'), `v${targetVersion}`);
            }

            // Cleanup temp download (not .update-tmp — that stays on Windows for bin/ post-step)
            fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            tmpDir = null;
            if (!isWin) {
                fs.rm(updateTmp, { recursive: true, force: true }).catch(() => {});
            }

            send('restarting', 100, 'Update complete. Restarting...');
            res.end();

            // 6. Flush DB and restart
            setTimeout(async () => {
                try {
                console.log(`[Update] Self-update to v${targetVersion} complete. Restarting...`);
                try { await flushPendingDb(); } catch {}
                try { checkpointWal('TRUNCATE'); } catch {}

                const port = process.env.PORT || 6001;

                if (isWin) {
                    // Windows: use a .bat script to apply bin/, finalize version, and restart.
                    // A bat script can replace bin/node.exe after the Node process exits,
                    // avoiding file-lock issues that a Node child process would hit.
                    //
                    // cmd.exe parses .bat files in the OEM code page (e.g. CP949 on Korean
                    // Windows), not UTF-8, so any non-ASCII path (Korean user name, "바탕 화면")
                    // written literally into the script would be mangled and every command
                    // would fail. Keep the script pure ASCII and pass paths through environment
                    // variables, which reach cmd.exe as UTF-16 via CreateProcessW.
                    const batScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.bat`);
                    const utmp = path.join(appDir, '.update-tmp');
                    const batLines = [
                        '@echo off',
                        // Wait ~3s for the Node process to exit before touching
                        // bin/. Not `timeout`: with stdio ignored, stdin is NUL
                        // and timeout exits at once ("input redirection is not
                        // supported"); ping does not read stdin.
                        'ping -n 4 127.0.0.1 >nul',
                        // Apply staged bin/: backup current → copy new → on failure restore backup
                        'if exist "%RISU_UTMP%\\new-bin\\" (',
                        '  if exist "%RISU_APP_DIR%\\bin\\" (',
                        '    xcopy /E /I /Y "%RISU_APP_DIR%\\bin\\*" "%RISU_UTMP%\\old-bin\\" >nul',
                        '  )',
                        '  xcopy /E /I /Y "%RISU_UTMP%\\new-bin\\*" "%RISU_APP_DIR%\\bin\\" >nul',
                        '  if errorlevel 1 (',
                        '    echo [Update] bin/ copy failed, restoring backup...',
                        '    if exist "%RISU_UTMP%\\old-bin\\" (',
                        '      xcopy /E /I /Y "%RISU_UTMP%\\old-bin\\*" "%RISU_APP_DIR%\\bin\\" >nul',
                        '    )',
                        '    echo [Update] bin/ restored. Staged files kept for retry.',
                        '    goto start',
                        '  )',
                        ')',
                        // Finalize version marker only after successful bin/ copy
                        'if exist "%RISU_UTMP%\\latest-version" (',
                        '  copy /Y "%RISU_UTMP%\\latest-version" "%RISU_APP_DIR%\\.installed-version" >nul',
                        ')',
                        // Cleanup .update-tmp (includes old-bin backup)
                        'rmdir /s /q "%RISU_UTMP%" 2>nul',
                        ':start',
                        // Start server with correct working directory
                        'cd /d "%RISU_APP_DIR%"',
                        'start "" "%RISU_APP_DIR%\\bin\\node.exe" "%RISU_APP_DIR%\\server\\node\\server.cjs"',
                        'exit /b 0',
                    ];
                    writeFileSync(batScript, batLines.join('\r\n'), 'ascii');
                    spawn('cmd.exe', ['/c', batScript], {
                        detached: true,
                        stdio: 'ignore',
                        env: Object.assign({}, process.env, { RISU_APP_DIR: appDir, RISU_UTMP: utmp }),
                    }).unref();
                } else {
                    // Unix: Node restart helper with port-check to avoid clashing with process managers
                    const restartScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.cjs`);
                    writeFileSync(restartScript, [
                        `const net = require('net');`,
                        `const { spawn } = require('child_process');`,
                        `setTimeout(() => {`,
                        `  const s = net.createServer();`,
                        `  s.once('error', () => process.exit(0));`,
                        `  s.once('listening', () => {`,
                        `    s.close();`,
                        `    spawn(${JSON.stringify(process.execPath)}, ['server/node/server.cjs'], {`,
                        `      cwd: ${JSON.stringify(appDir)},`,
                        `      detached: true,`,
                        `      stdio: 'inherit',`,
                        `      env: Object.assign({}, process.env),`,
                        `    }).unref();`,
                        `    setTimeout(() => process.exit(0), 500);`,
                        `  });`,
                        `  s.listen(${Number(port)});`,
                        `}, 3000);`,
                    ].join('\n'));
                    spawn(process.execPath, [restartScript], { detached: true, stdio: 'ignore' }).unref();
                }
                process.exit(0);
                } catch (restartErr) {
                    logger.error('[Update] Restart failed:', restartErr);
                    selfUpdateInProgress = false;
                }
            }, 500);

        } catch (e) {
            logger.error('[Update] Self-update failed:', e);
            send('error', null, `Update failed: ${e.message}`);
            res.end();
            selfUpdateInProgress = false;
            if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    async function moveAcrossVolumes(src, dest) {
        try {
            await fs.rename(src, dest);
        } catch (err) {
            if (err && err.code === 'EXDEV') {
                await fs.cp(src, dest, { recursive: true, force: true });
                await fs.rm(src, { recursive: true, force: true });
                return;
            }
            throw err;
        }
    }

    async function restoreBackup(backupDir, rootDir) {
        try { await fs.access(backupDir); } catch { return; }
        for (const entry of await fs.readdir(backupDir)) {
            const src = path.join(backupDir, entry);
            const dest = path.join(rootDir, entry);
            try {
                await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
                await moveAcrossVolumes(src, dest);
            } catch { /* best effort */ }
        }
    }
}

module.exports = { installSystemRoutes };
