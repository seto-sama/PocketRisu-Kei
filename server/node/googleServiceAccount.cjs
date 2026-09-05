'use strict';

const nodeCrypto = require('crypto');
const path = require('path');
require('sucrase/register/ts');
const { createServiceAccountTokenCache } = require(path.join(
    __dirname, '../../src/ts/preset/adapter/googleServiceAccount/cache.ts',
));
const { parseAccessTokenResponse } = require(path.join(
    __dirname, '../../src/ts/preset/adapter/googleServiceAccount/token.ts',
));
const GOOGLE_OAUTH_TOKEN_URI = 'https://oauth2.googleapis.com/token';

function errorResponse(status, error) {
    return Response.json({ error }, { status });
}

// Shared by the authenticated browser route and server-owned generation.
// Never log service account keys, signed assertions, or token responses.
async function exchangeGoogleServiceAccountToken(input) {
    const serviceAccountJson = input.serviceAccountJson
    const scope = (typeof input.scope === 'string' && input.scope.length > 0)
        ? input.scope
        : 'https://www.googleapis.com/auth/cloud-platform'
    if (typeof serviceAccountJson !== 'string' || serviceAccountJson.length === 0) {
        return errorResponse(400, 'serviceAccountJson required')
    }
    let sa
    try {
        sa = JSON.parse(serviceAccountJson)
    } catch {
        return errorResponse(400, 'invalid service account JSON')
    }
    const clientEmail = sa && sa.client_email
    const privateKey = sa && sa.private_key
    const kid = sa && sa.private_key_id
    const tokenUri = (sa && typeof sa.token_uri === 'string' && sa.token_uri.length > 0)
        ? sa.token_uri
        : GOOGLE_OAUTH_TOKEN_URI
    if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
        return errorResponse(400, 'service account missing client_email / private_key')
    }
    // SSRF / signed-JWT exfiltration guard: only Google's documented endpoint.
    if (tokenUri !== GOOGLE_OAUTH_TOKEN_URI) {
        return errorResponse(400, 'unsupported token_uri')
    }
    const nowSec = Math.floor((input.now ?? Date.now)() / 1000)
    const header = { alg: 'RS256', typ: 'JWT' }
    if (typeof kid === 'string' && kid.length > 0) header.kid = kid
    const payload = { iss: clientEmail, scope, aud: tokenUri, iat: nowSec, exp: nowSec + 3600 }
    const signingInput =
        `${Buffer.from(JSON.stringify(header)).toString('base64url')}.` +
        `${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
    let signature
    try {
        const signer = nodeCrypto.createSign('RSA-SHA256')
        signer.update(signingInput)
        signer.end()
        signature = signer.sign(privateKey).toString('base64url')
    } catch {
        return errorResponse(400, 'failed to sign with the provided private key')
    }
    const assertion = `${signingInput}.${signature}`

    let googleRes
    try {
        googleRes = await (input.fetchImpl ?? globalThis.fetch)(tokenUri, {
            method: 'POST',
            signal: input.abortSignal
                ? AbortSignal.any([input.abortSignal, AbortSignal.timeout(60_000)])
                : AbortSignal.timeout(60_000),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion,
            }).toString(),
        })
    } catch {
        return errorResponse(502, 'OAuth token endpoint unreachable')
    }

    return googleRes;
}

function createServerServiceAccountTokenCache(options = {}) {
    return createServiceAccountTokenCache({
        now: options.now,
        exchange: async input => {
            const issuedAtMs = (input.now ?? Date.now)();
            const response = await exchangeGoogleServiceAccountToken({
                serviceAccountJson: input.serviceAccount.sourceJson,
                scope: input.scope,
                now: () => issuedAtMs,
                fetchImpl: options.fetchImpl,
            });
            return parseAccessTokenResponse(response, issuedAtMs);
        },
    });
}

function createServerProviderAuthResolver(options = {}) {
    const cache = createServerServiceAccountTokenCache(options);
    const { parseServiceAccountJson } = require(path.join(
        __dirname, '../../src/ts/preset/adapter/googleServiceAccount/serviceAccount.ts',
    ));
    return async (auth, headers, signal) => {
        if (!auth) return;
        if (auth.kind !== 'google-service-account') throw new Error('Invalid provider authentication');
        const token = await cache.getAccessToken({
            serviceAccount: parseServiceAccountJson(auth.serviceAccountJson),
            scope: auth.scope, abortSignal: signal,
        });
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key];
        headers.authorization = `Bearer ${token.accessToken}`;
    };
}

module.exports = { exchangeGoogleServiceAccountToken, createServerServiceAccountTokenCache, createServerProviderAuthResolver };
