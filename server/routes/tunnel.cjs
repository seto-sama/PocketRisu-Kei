'use strict';

const path = require('path');
const { existsSync, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { decompressFile } = require('../utils/decompressFile.cjs');
const { logger } = require('../logs/logs.cjs');

const execFileAsync = promisify(execFile);

function installTunnelRoutes(app, {
    checkAuth,
    tunnelState,
    stopTunnel,
}) {
    const TUNNEL_DISABLED = process.env.RISU_TUNNEL_DISABLED === 'true';

    const CLOUDFLARED_ASSETS = {
        'darwin-arm64':  { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz', type: 'tgz' },
        'darwin-x64':    { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz', type: 'tgz' },
        'linux-x64':     { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', type: 'bin' },
        'linux-arm64':   { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64', type: 'bin' },
        // Termux reports process.platform === 'android' but the linux-arm64
        // cloudflared binary (statically linked Go) runs cleanly on Bionic.
        'android-arm64': { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64', type: 'bin' },
        'win32-x64':     { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', type: 'bin' },
    };

    async function findCloudflaredBinary() {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const bundled = path.join(process.cwd(), 'bin', 'cloudflared' + ext);
        if (existsSync(bundled)) return bundled;
        try {
            await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared']);
            return 'cloudflared';
        } catch {
            return null;
        }
    }

    async function downloadCloudflared() {
        const key = `${process.platform}-${process.arch}`;
        const asset = CLOUDFLARED_ASSETS[key];
        if (!asset) throw new Error(`Unsupported platform: ${key}`);

        const ext = process.platform === 'win32' ? '.exe' : '';
        const binDir = path.join(process.cwd(), 'bin');
        const dest = path.join(binDir, 'cloudflared' + ext);

        await fs.mkdir(binDir, { recursive: true });

        console.log(`[Tunnel] Downloading cloudflared for ${key}...`);
        const downloadDir = await fs.mkdtemp(path.join(binDir, '.cloudflared-'));
        const binaryPath = path.join(downloadDir, 'cloudflared' + ext);
        const downloadPath = asset.type === 'tgz' ? path.join(downloadDir, 'cloudflared.tgz') : binaryPath;
        try {
            const response = await fetch(asset.url, { headers: { 'User-Agent': 'pocketrisu' } });
            if (response.status !== 200 || !response.body) {
                await response.body?.cancel();
                throw new Error(`HTTP ${response.status}`);
            }
            await pipeline(response.body, createWriteStream(downloadPath));
            if (asset.type === 'tgz') await decompressFile(downloadPath, downloadDir);
            if (process.platform !== 'win32') await fs.chmod(binaryPath, 0o755);
            await fs.rename(binaryPath, dest);
        } finally {
            await fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
        }
        console.log('[Tunnel] cloudflared downloaded successfully.');
        return dest;
    }

    app.get('/api/tunnel/status', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.json({
            disabled: TUNNEL_DISABLED,
            status: tunnelState.tunnelStatus,
            url: tunnelState.tunnelUrl,
            error: tunnelState.tunnelError,
            platform: process.platform,
        });
    });

    app.post('/api/tunnel/start', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        if (TUNNEL_DISABLED) return res.status(403).json({ error: 'Tunnel is disabled via RISU_TUNNEL_DISABLED' });
        if (tunnelState.tunnelStatus === 'running' || tunnelState.tunnelStatus === 'starting' || tunnelState.tunnelStatus === 'downloading') {
            return res.status(409).json({ error: 'Tunnel is already ' + tunnelState.tunnelStatus });
        }

        tunnelState.tunnelStatus = 'starting';
        tunnelState.tunnelError = null;
        tunnelState.tunnelUrl = null;
        let cfPath = await findCloudflaredBinary();

        if (!cfPath) {
            tunnelState.tunnelStatus = 'downloading';
            res.json({ status: 'downloading' });
            try {
                cfPath = await downloadCloudflared();
            } catch (e) {
                logger.error('[Tunnel] Download failed:', e.message);
                tunnelState.tunnelStatus = 'error';
                tunnelState.tunnelError = `Failed to download cloudflared: ${e.message}`;
                return;
            }
            startTunnelProcess(cfPath);
            return;
        }
        startTunnelProcess(cfPath);
        res.json({ status: 'starting' });
    });

    function startTunnelProcess(cfPath) {
        const port = process.env.PORT || 6001;
        tunnelState.tunnelStatus = 'starting';

        try {
            const originScheme = tunnelState.serverIsHttps ? 'https' : 'http';
            const args = ['tunnel', '--url', `${originScheme}://localhost:${port}`];
            if (tunnelState.serverIsHttps) args.push('--no-tls-verify');
            const child = spawn(cfPath, args, {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            tunnelState.tunnelProcess = child;

            child.stderr.on('data', (chunk) => {
                if (tunnelState.tunnelProcess !== child) return;
                const text = chunk.toString();
                const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                if (match && tunnelState.tunnelStatus === 'starting') {
                    tunnelState.tunnelUrl = match[0];
                    tunnelState.tunnelStatus = 'running';
                    if (tunnelState.tunnelStartTimeout) { clearTimeout(tunnelState.tunnelStartTimeout); tunnelState.tunnelStartTimeout = null; }
                    console.log(`[Tunnel] Quick tunnel URL: ${tunnelState.tunnelUrl}`);
                }
            });

            child.on('error', (err) => {
                if (tunnelState.tunnelProcess !== child) return;
                logger.error('[Tunnel] Process error:', err.message);
                tunnelState.tunnelStatus = 'error';
                tunnelState.tunnelError = err.message;
                tunnelState.tunnelProcess = null;
                tunnelState.tunnelUrl = null;
                if (tunnelState.tunnelStartTimeout) { clearTimeout(tunnelState.tunnelStartTimeout); tunnelState.tunnelStartTimeout = null; }
            });

            child.on('exit', (code) => {
                if (tunnelState.tunnelProcess !== child) return;
                if (tunnelState.tunnelStatus === 'running' || tunnelState.tunnelStatus === 'starting') {
                    console.log(`[Tunnel] Process exited with code ${code}`);
                    tunnelState.tunnelStatus = 'error';
                    tunnelState.tunnelError = `cloudflared exited unexpectedly (code ${code})`;
                }
                tunnelState.tunnelProcess = null;
                tunnelState.tunnelUrl = null;
                if (tunnelState.tunnelStartTimeout) { clearTimeout(tunnelState.tunnelStartTimeout); tunnelState.tunnelStartTimeout = null; }
            });

            tunnelState.tunnelStartTimeout = setTimeout(() => {
                if (tunnelState.tunnelStatus === 'starting') {
                    tunnelState.tunnelStatus = 'error';
                    tunnelState.tunnelError = 'Tunnel failed to start within 30 seconds';
                    if (tunnelState.tunnelProcess) { try { tunnelState.tunnelProcess.kill('SIGTERM'); } catch {} tunnelState.tunnelProcess = null; }
                }
                tunnelState.tunnelStartTimeout = null;
            }, 30000);
        } catch (e) {
            tunnelState.tunnelStatus = 'error';
            tunnelState.tunnelError = e.message;
            tunnelState.tunnelProcess = null;
        }
    }

    app.post('/api/tunnel/stop', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        stopTunnel();
        res.json({ status: 'off' });
    });
}

module.exports = { installTunnelRoutes };
