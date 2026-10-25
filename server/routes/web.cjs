'use strict';

const fs = require('fs/promises');
const path = require('path');
const htmlparser = require('node-html-parser');

function installWebRoutes(app, {
    enablePatchSync,
    isCloudflareTunnelRequest,
}) {
    app.get('/', async (req, res) => {

        const clientIP = req.ip || 'Unknown IP';
        const timestamp = new Date().toISOString();
        console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);

        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        head.innerHTML = `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${enablePatchSync}; globalThis.__CLOUDFLARE_TUNNEL__ = ${isCloudflareTunnelRequest(req)}</script>` + head.innerHTML

        res.set('Cache-Control', 'no-store');
        res.send(root.toString())
    })
}

module.exports = { installWebRoutes };
