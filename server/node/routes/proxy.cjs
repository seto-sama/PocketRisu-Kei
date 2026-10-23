'use strict';

const express = require('express');
const { executeHttpRequest, executeUpstreamRequest, filterUpstreamResponseHeaders } = require('../upstreamRequest.cjs');
const { PROXY_PATH, REALM_PROXY_PATH, REALM_ORIGIN } = require('../../../shared/proxy.mjs');
const { requestIdleTimeoutMs } = require('../../../shared/requestTimeout.mjs');
const { pipeline } = require('stream/promises');
const { logger } = require('../logs/logs.cjs');

const REALM_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'x-risuai-info'];
const PROXY_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

function getRequestTimeoutMs(header) {
    const timeoutMs = Number.parseInt(Array.isArray(header) ? header[0] : header, 10);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
}

function createProxyRequestController(res, timeoutMs) {
    const controller = new AbortController();
    const onClose = () => {
        if (!res.writableEnded) controller.abort();
    };
    res.once('close', onClose);
    // Authentication may have awaited while the client disconnected.
    if (res.destroyed) onClose();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timer);
            res.off('close', onClose);
        },
    };
}

function executeRealmRequest(path, req, signal) {
    const headers = { origin: REALM_ORIGIN };
    for (const name of REALM_REQUEST_HEADERS) {
        if (req.headers[name]) headers[name] = req.headers[name];
    }
    return executeHttpRequest(signal => fetch(REALM_ORIGIN + path, {
        method: req.method, headers, signal, redirect: 'manual',
    }), {
        signal,
        filterHeaders: headers => filterUpstreamResponseHeaders(headers, { preserveCacheControl: true }),
    });
}

function installProxyRoutes(app, { checkAuth, outboundPolicy }) {
    const parseBody = express.raw({ type: () => true, limit: '2gb' });

    async function prepareRequest(req, res, next) {
        res.locals.skipCompression = true;
        const realm = res.locals.proxyRealmPath !== undefined;
        const methods = realm ? ['GET', 'HEAD'] : PROXY_METHODS;
        if (!methods.includes(req.method)) return res.set('Allow', methods.join(', ')).sendStatus(405);
        if (realm) {
            if (!res.locals.proxyRealmPath.startsWith('/')) {
                return res.status(400).json({ error: 'Invalid Realm path' });
            }
            return next();
        }
        if (await checkAuth(req, res)) return parseBody(req, res, next);
    }

    async function handleRequest(req, res) {
        const realmPath = res.locals.proxyRealmPath;
        const realm = realmPath !== undefined;
        const timeoutMs = realm ? null : getRequestTimeoutMs(req.headers['risu-timeout-ms']);
        const controller = createProxyRequestController(res, timeoutMs);
        let url = req.headers['risu-url'] || req.query.url;
        try {
            let response;
            if (realm) {
                response = await executeRealmRequest(realmPath, req, controller.signal);
            } else {
                if (req.headers['risu-url']) url = decodeURIComponent(url);
                if (!url) return res.status(400).json({ error: 'URL has no param' });
                response = await executeUpstreamRequest({
                    url,
                    method: req.method,
                    headers: req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : {},
                    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
                    signal: controller.signal,
                    idleTimeoutMs: requestIdleTimeoutMs(timeoutMs),
                    outboundPolicy,
                });
            }
            res.status(response.status).set(response.headers);
            if (response.body) await pipeline(response.body, res);
            else res.end();
        } catch (error) {
            if (res.destroyed) return;
            if (res.headersSent) return res.destroy(error);
            if (realm) {
                logger.error('[Realm Proxy] Error:', error);
                return res.status(502).json({ error: 'Proxy request failed: ' + error.message });
            }
            if (error?.code === 'OUTBOUND_TARGET_BLOCKED') {
                return res.status(403).json({ error: error.message });
            }
            if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
                return res.status(504).json({
                    error: error.name === 'TimeoutError' ? error.message : timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms` : 'Proxy request aborted',
                });
            }
            logger.error(`[Proxy] ${req.method} ${url}`, error);
            throw error;
        } finally {
            controller.cleanup();
        }
    }

    const router = express.Router();
    router.use(REALM_PROXY_PATH, (req, res, next) => {
        // Preserve the raw upstream path and query, including encoded separators.
        res.locals.proxyRealmPath = req.url;
        return prepareRequest(req, res, next);
    }, handleRequest);
    router.all(PROXY_PATH, prepareRequest, handleRequest);
    app.use(router);
}

module.exports = { installProxyRoutes };
