'use strict';

const express = require('express');
const { BINARY_MESSAGE_CONTENT_TYPE } = require('./utils/binaryHttp.cjs');

function installAuthenticatedBodyParsing(app, { checkAuth }) {
    const authenticate = async (req, res, next) => {
        if (await checkAuth(req, res)) next();
    };

    app.use('/api', (req, res, next) => {
        if (!req.is(['application/json', 'text/plain', BINARY_MESSAGE_CONTENT_TYPE])) return next();
        return authenticate(req, res, next);
    }, express.json({ limit: '100mb' }), express.text({ limit: '100mb' }));
}

module.exports = { installAuthenticatedBodyParsing };
