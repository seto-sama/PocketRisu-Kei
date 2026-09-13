'use strict';

const path = require('path');
const { existsSync } = require('fs');
const { execSync, spawn } = require('child_process');
const { logger } = require('../logs/logs.cjs');

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

    function findCloudflaredBinary() {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const bundled = path.join(process.cwd(), 'bin', 'cloudflared' + ext);
        if (existsSync(bundled)) return bundled;
        try {
            execSync(process.platform === 'win32' ? 'where cloudflared' : 'which cloudflared', { stdio: 'pipe' });
            return 'cloudflared';
        } catch {
            return null;
        }
    }

    function followRedirects(url) {
        return new Promise((resolve, reject) => {
            const mod = url.startsWith('https') ? require('https') : require('http');
            mod.get(url, { headers: { 'User-Agent': 'pocketrisu' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    followRedirects(res.headers.location).then(resolve, reject);
                } else if (res.statusCode === 200) {
                    resolve(res);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            }).on('error', reject);
        });
    }

    async function downloadCloudflared() {
        const key = `${process.platform}-${process.arch}`;
        const asset = CLOUDFLARED_ASSETS[key];
        if (!asset) throw new Error(`Unsupported platform: ${key}`);

        const ext = process.platform === 'win32' ? '.exe' : '';
        const binDir = path.join(process.cwd(), 'bin');
        const dest = path.join(binDir, 'cloudflared' + ext);

        if (!existsSync(binDir)) require('fs').mkdirSync(binDir, { recursive: true });

        console.log(`[Tunnel] Downloading cloudflared for ${key}...`);
        const res = await followRedirects(asset.url);

        if (asset.type === 'tgz') {
            const tmpPath = path.join(binDir, '_cloudflared.tgz');
            await new Promise((resolve, reject) => {
                const ws = require('fs').createWriteStream(tmpPath);
                res.pipe(ws);
                ws.on('finish', () => { ws.close(); resolve(); });
                ws.on('error', reject);
            });
            execSync(`tar -xzf "${tmpPath}" -C "${binDir}"`, { stdio: 'pipe' });
            require('fs').unlinkSync(tmpPath);
        } else {
            await new Promise((resolve, reject) => {
                const ws = require('fs').createWriteStream(dest);
                res.pipe(ws);
                ws.on('finish', () => { ws.close(); resolve(); });
                ws.on('error', reject);
            });
        }

        if (process.platform !== 'win32') require('fs').chmodSync(dest, 0o755);
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

        let cfPath = findCloudflaredBinary();

        // Auto-download if not found
        if (!cfPath) {
            tunnelState.tunnelStatus = 'downloading';
            tunnelState.tunnelError = null;
            res.json({ status: 'downloading' });

            try {
                cfPath = await downloadCloudflared();
            } catch (e) {
                logger.error('[Tunnel] Download failed:', e.message);
                tunnelState.tunnelStatus = 'error';
                tunnelState.tunnelError = `Failed to download cloudflared: ${e.message}`;
                return;
            }
            // After download, start the tunnel (response already sent)
            startTunnelProcess(cfPath);
            return;
        }

        tunnelState.tunnelStatus = 'starting';
        tunnelState.tunnelError = null;
        tunnelState.tunnelUrl = null;
        startTunnelProcess(cfPath);
        res.json({ status: 'starting' });
    });

    function startTunnelProcess(cfPath) {
        const port = process.env.PORT || 6001;
        tunnelState.tunnelStatus = 'starting';
        tunnelState.tunnelError = null;
        tunnelState.tunnelUrl = null;

        try {
            const originScheme = tunnelState.serverIsHttps ? 'https' : 'http';
            const args = ['tunnel', '--url', `${originScheme}://localhost:${port}`];
            if (tunnelState.serverIsHttps) args.push('--no-tls-verify');
            tunnelState.tunnelProcess = spawn(cfPath, args, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            tunnelState.tunnelProcess.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                if (match && tunnelState.tunnelStatus === 'starting') {
                    tunnelState.tunnelUrl = match[0];
                    tunnelState.tunnelStatus = 'running';
                    if (tunnelState.tunnelStartTimeout) { clearTimeout(tunnelState.tunnelStartTimeout); tunnelState.tunnelStartTimeout = null; }
                    console.log(`[Tunnel] Quick tunnel URL: ${tunnelState.tunnelUrl}`);
                }
            });

            tunnelState.tunnelProcess.on('error', (err) => {
                logger.error('[Tunnel] Process error:', err.message);
                tunnelState.tunnelStatus = 'error';
                tunnelState.tunnelError = err.message;
                tunnelState.tunnelProcess = null;
                if (tunnelState.tunnelStartTimeout) { clearTimeout(tunnelState.tunnelStartTimeout); tunnelState.tunnelStartTimeout = null; }
            });

            tunnelState.tunnelProcess.on('exit', (code) => {
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
