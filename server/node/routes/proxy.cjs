'use strict';

const { binaryBodyParser } = require('../binaryHttp.cjs');

const path = require('path');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const fs = require('fs/promises');
const { executeUpstreamRequest } = require('../upstreamRequest.cjs');
const { requestIdleTimeoutMs } = require('../../../shared/requestTimeout.mjs');
const { pipeline } = require('stream/promises');
const { logger } = require('../logs/logs.cjs');

function installProxyRoutes(app, {
    checkAuth,
    isCloudflareTunnelRequest,
}) {
    const hubURL = 'https://sv.risuai.xyz';

    const authCodePath = path.join(process.cwd(), 'save', '__authcode')

    function getRequestTimeoutMs(timeoutHeader) {
        const raw = Array.isArray(timeoutHeader) ? timeoutHeader[0] : timeoutHeader;
        if (!raw) {
            return null;
        }
        const timeoutMs = Number.parseInt(raw, 10);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return null;
        }
        return timeoutMs;
    }

    function createTimeoutController(timeoutMs) {
        if (!timeoutMs) {
            return {
                signal: undefined,
                cleanup: () => {}
            };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        return {
            signal: controller.signal,
            cleanup: () => clearTimeout(timer)
        };
    }

    const reverseProxyFunc = async (req, res, next) => {
        if(!await checkAuth(req, res)){
            return;
        }

        const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

        if (!urlParam) {
            res.status(400).send({
                error:'URL has no param'
            });
            return;
        }
        const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
        const timeout = createTimeoutController(timeoutMs);
        let originalResponse;
        try {
        const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
        if (req.headers['x-risu-tk'] && !header['x-risu-tk']) {
            header['x-risu-tk'] = req.headers['x-risu-tk'];
        }
        if (req.headers['risu-location'] && !header['risu-location']) {
            header['risu-location'] = req.headers['risu-location'];
        }
        if(!header['x-forwarded-for']){
            header['x-forwarded-for'] = req.ip
        }

        if(req.headers['authorization']?.startsWith('X-SERVER-REGISTER')){
            if(!existsSync(authCodePath)){
                delete header['authorization']
            }
            else{
                const authCode = await fs.readFile(authCodePath, {
                    encoding: 'utf-8'
                })
                header['authorization'] = `Bearer ${authCode}`
            }
        }
            let requestBody = undefined;
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
                    requestBody = req.body;
                }
                else if (req.body !== undefined) {
                    requestBody = JSON.stringify(req.body);
                }
            }
            originalResponse = await executeUpstreamRequest({
                url: urlParam,
                method: req.method,
                headers: header,
                body: requestBody,
                signal: timeout.signal,
                idleTimeoutMs: requestIdleTimeoutMs(timeoutMs),
            });
            res.header(originalResponse.headers);
            res.status(originalResponse.status);
            await pipeline(originalResponse.body, res);


        }
        catch (err) {
            if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
                if (!res.headersSent) {
                    res.status(504).send({
                        error: err.name === 'TimeoutError' ? err.message : timeoutMs
                            ? `Proxy request timed out after ${timeoutMs}ms`
                            : 'Proxy request aborted'
                    });
                } else {
                    res.destroy(err);
                }
                return;
            }
            // Pass the actual `err` (not err.cause) so logger.* can tag it and the
            // Express error middleware knows to skip. The cause chain is preserved
            // via formatErrorWithCause in normalizeArgs.
            logger.error(`[Proxy] ${req.method} ${urlParam}`, err);
            next(err);
            return;
        } finally {
            timeout.cleanup();
        }
    }

    let accessTokenCache = {
        token: null,
        expiry: 0
    }

    async function getSionywAccessToken() {
        if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
            return accessTokenCache.token;
        }
        //Schema of the client data file
        // {
        //     refresh_token: string;
        //     client_id: string;
        //     client_secret: string;
        // }

        const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
        let refreshToken = ''
        let clientId = ''
        let clientSecret = ''
        if(!existsSync(clientDataPath)){
            throw new Error('No Sionyw client data found');
        }
        const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
        const clientData = JSON.parse(clientDataRaw);
        refreshToken = clientData.refresh_token;
        clientId = clientData.client_id;
        clientSecret = clientData.client_secret;

        //Oauth Refresh Token Flow

        const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: clientId,
                client_secret: clientSecret
            })
        })

        if(!tokenResponse.ok){
            throw new Error('Failed to refresh Sionyw access token');
        }

        const tokenData = await tokenResponse.json();

        //Update the refresh token in the client data file
        if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
            clientData.refresh_token = tokenData.refresh_token;
            writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
        }

        accessTokenCache.token = tokenData.access_token;
        accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

        return tokenData.access_token;
    }

    async function hubProxyFunc(req, res) {
        const excludedHeaders = [
            'content-encoding',
            'content-length',
            'transfer-encoding'
        ];

        try {
            let externalURL = '';

            const pathHeader = req.headers['x-risu-node-path'];
            if (pathHeader) {
                if (isCloudflareTunnelRequest(req)) {
                    res.status(403).send({ error: 'x-risu-node-path is not allowed through tunnel requests' });
                    return;
                }
                const decodedPath = decodeURIComponent(pathHeader);
                externalURL = decodedPath;
            } else {
                const pathAndQuery = req.originalUrl.replace(/^\/hub-proxy/, '');
                externalURL = hubURL + pathAndQuery;
            }

            const headersToSend = { ...req.headers };
            delete headersToSend.host;
            delete headersToSend.connection;
            delete headersToSend['content-length'];
            delete headersToSend['x-risu-node-path'];

            const hubOrigin = new URL(hubURL).origin;
            headersToSend.origin = hubOrigin;

            //if Authorization header is "Server-Auth, set the token to be Server-Auth
            if(headersToSend['Authorization'] === 'X-Node-Server-Auth'){
                //this requires password auth
                if(!await checkAuth(req, res)){
                    return;
                }

                headersToSend['Authorization'] = "Bearer " + await getSionywAccessToken();
                delete headersToSend['risu-auth'];
            }


            const response = await fetch(externalURL, {
                method: req.method,
                headers: headersToSend,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });

            for (const [key, value] of response.headers.entries()) {
                // Skip encoding-related headers to prevent double decoding
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                res.setHeader(key, value);
            }
            res.status(response.status);

            if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
                const redirectUrl = response.headers.get('location');
                const newHeaders = { ...headersToSend };
                const redirectResponse = await fetch(redirectUrl, {
                    method: req.method,
                    headers: newHeaders,
                    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                    redirect: 'manual',
                    duplex: 'half'
                });
                for (const [key, value] of redirectResponse.headers.entries()) {
                    if (excludedHeaders.includes(key.toLowerCase())) {
                        continue;
                    }
                    res.setHeader(key, value);
                }
                res.status(redirectResponse.status);
                if (redirectResponse.body) {
                    await pipeline(redirectResponse.body, res);
                } else {
                    res.end();
                }
                return;
            }

            if (response.body) {
                await pipeline(response.body, res);
            } else {
                res.end();
            }

        } catch (error) {
            logger.error("[Hub Proxy] Error:", error);
            if (!res.headersSent) {
                res.status(502).send({ error: 'Proxy request failed: ' + error.message });
            } else {
                res.end();
            }
        }
    }

    app.get('/proxy2', binaryBodyParser('2gb'), reverseProxyFunc);

    app.get('/hub-proxy/*splat', hubProxyFunc);

    app.post('/proxy2', binaryBodyParser('2gb'), reverseProxyFunc);

    app.put('/proxy2', binaryBodyParser('2gb'), reverseProxyFunc);

    app.patch('/proxy2', binaryBodyParser('2gb'), reverseProxyFunc);

    app.delete('/proxy2', binaryBodyParser('2gb'), reverseProxyFunc);

    app.post('/hub-proxy/*splat', binaryBodyParser('2gb'), hubProxyFunc);
}

module.exports = { installProxyRoutes };
