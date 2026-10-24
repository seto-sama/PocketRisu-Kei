'use strict';

const { createImageTagService } = require('../imageTags.cjs');

function installImageTagRoutes(app, { checkAuth, cacheDir }) {
    const service = createImageTagService({ cacheDir });
    app.get('/api/image-tags', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        const query = req.query.q;
        if (typeof query !== 'string' || query.length > 200) {
            res.status(400).json({ error: 'A tag query of at most 200 characters is required' });
            return;
        }
        try {
            res.json({ tags: await service.search(query) });
        } catch (error) {
            console.error('[ImageTags]', error);
            res.status(503).json({ error: 'Image tag autocomplete unavailable' });
        }
    });
}

module.exports = { installImageTagRoutes };
