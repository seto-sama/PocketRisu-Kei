'use strict';

require('sucrase/register/ts');
const { decodeBinaryMessage, BINARY_MESSAGE_CONTENT_TYPE } = require('../../src/ts/network/binaryMessage.ts');

function binaryBodyParser(limit) {
    return require('express').raw({ type: BINARY_MESSAGE_CONTENT_TYPE, limit });
}

function decodeBinaryRequest(req, res, decode = decodeBinaryMessage) {
    if (!Buffer.isBuffer(req.body)) {
        res.status(415).send({ error: 'Request requires a binary envelope' });
        return undefined;
    }
    try {
        return decode(req.body);
    } catch (error) {
        res.status(error instanceof RangeError ? 413 : 400).send({ error: error.message });
        return undefined;
    }
}

module.exports = { decodeBinaryRequest, binaryBodyParser };
