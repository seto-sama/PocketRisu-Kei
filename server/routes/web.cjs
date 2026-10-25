'use strict';

const fs = require('fs/promises');
const path = require('path');
const htmlparser = require('node-html-parser');
const { logger } = require('../logs/logs.cjs');

function installWebRoutes(app, {
    enablePatchSync,
    isCloudflareTunnelRequest,
    getDevServer = () => null,
}) {
    app.get('/', async (req, res) => {

        const clientIP = req.ip || 'Unknown IP';
        const timestamp = new Date().toISOString();
        console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);

        const devServer = getDevServer();
        let mainIndex = await fs.readFile(devServer
            ? path.join(devServer.config.root, 'index.html')
            : path.join(process.cwd(), 'dist', 'index.html'), 'utf8');
        if (devServer) mainIndex = await devServer.transformIndexHtml(req.originalUrl, mainIndex);
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        head.innerHTML = `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${enablePatchSync}; globalThis.__CLOUDFLARE_TUNNEL__ = ${isCloudflareTunnelRequest(req)}; globalThis.__POCKETRISU_DEBUG__ = ${logger.debug.enabled};</script>` + head.innerHTML

        res.set('Cache-Control', 'no-store');
        res.send(root.toString())
    })
}

module.exports = { installWebRoutes };
