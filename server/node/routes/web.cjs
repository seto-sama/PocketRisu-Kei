'use strict';

const fs = require('fs/promises');
const path = require('path');
const htmlparser = require('node-html-parser');

function installWebRoutes(app, {
    enablePatchSync,
}) {
    app.get('/', async (req, res, next) => {

        const clientIP = req.ip || 'Unknown IP';
        const timestamp = new Date().toISOString();
        console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);

        try {
            const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
            const root = htmlparser.parse(mainIndex)
            const head = root.querySelector('head')
            head.innerHTML = `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${enablePatchSync}</script>` + head.innerHTML

            res.send(root.toString())
        } catch (error) {
            console.log(error)
            next(error)
        }
    })
}

module.exports = { installWebRoutes };
