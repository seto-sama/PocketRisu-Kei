'use strict';

require('sucrase/register/ts');
const { decode, encode } = require('msgpackr');
const { BINARY_MESSAGE_CONTENT_TYPE } = require('../../../src/ts/network/binaryMessage.ts');
const { binaryBodyParser } = require('../utils/binaryHttp.cjs');
const { decodeFile, encodeFile } = require('../fileFormats.cjs');
const FILE_FORMAT_BODY_LIMIT = '100mb';

function sendFileFormatError(res, error) {
    return res.status(error?.statusCode || 400).json({
        error: error?.message || 'Invalid file format',
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.details ? { details: error.details } : {}),
    });
}

function installFileFormatRoutes(app, { checkAuth }) {
    const authenticate = async (req, res, next) => {
        if (await checkAuth(req, res)) next();
    };

    app.post('/api/file-formats/:format/encode', authenticate, binaryBodyParser(FILE_FORMAT_BODY_LIMIT), async (req, res) => {
        if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Request requires a MessagePack body' });

        let value;
        try {
            value = decode(req.body);
        } catch (error) {
            return sendFileFormatError(res, error);
        }

        try {
            const data = await encodeFile(req.params.format, value);
            res.set('content-type', BINARY_MESSAGE_CONTENT_TYPE).send(data);
        } catch (error) {
            sendFileFormatError(res, error);
        }
    });

    app.post('/api/file-formats/:format/decode', authenticate, binaryBodyParser(FILE_FORMAT_BODY_LIMIT), async (req, res) => {
        if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Request requires a native file body' });

        try {
            const value = await decodeFile(req.params.format, req.body);
            res.set('content-type', BINARY_MESSAGE_CONTENT_TYPE).send(encode(value));
        } catch (error) {
            sendFileFormatError(res, error);
        }
    });
}

module.exports = { installFileFormatRoutes };
