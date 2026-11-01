'use strict';

const path = require('path');
const nodeCrypto = require('crypto');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const { codes: API_ERROR_CODES, sendApiError } = require('./utils/apiErrors.cjs');

const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;

function sessionExpiresAt(session) {
    return typeof session === 'number' ? session : session?.expiresAt ?? 0
}

function parseSessionCookie(req) {
    const cookieHeader = req.headers.cookie || ''
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        if (part.slice(0, eq).trim() === 'risu-session') return part.slice(eq + 1).trim()
    }
    return null
}

function createAuthService({ savePath }) {
    const passwordPath = path.join(savePath, '__password')
    const authState = {
        password: existsSync(passwordPath) ? readFileSync(passwordPath, 'utf-8') : '',
    };

    // Upstream signs ECDSA JWTs in the browser with crypto.subtle, which needs a
    // secure context. Signing with HMAC-SHA256 on the server keeps login working
    // over plain HTTP. Sync manually if upstream changes its auth flow.
    const jwtSecretPath = path.join(savePath, '__jwt_secret')
    let jwtSecret
    if (existsSync(jwtSecretPath)) {
        jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim()
    } else {
        jwtSecret = nodeCrypto.randomBytes(64).toString('hex')
        writeFileSync(jwtSecretPath, jwtSecret, 'utf-8')
    }

    // <img src="/api/asset/..."> cannot send custom headers, so we use a session
    // cookie issued after initial JWT auth. Single-user environment: Map is fine.
    // Sessions are persisted to disk so they survive server restarts.
    const sessionFile = path.join(savePath, '__sessions')
    const sessions = new Map() // token → expiresAt (ms)
    try {
        const raw = readFileSync(sessionFile, 'utf-8')
        const now = Date.now()
        for (const [token, storedSession] of JSON.parse(raw)) {
            const expiresAt = sessionExpiresAt(storedSession)
            if (expiresAt > now) sessions.set(token, expiresAt)
        }
    } catch { /* file missing or corrupt – start fresh */ }

    const loginBlockedUntil = new Map();
    const loginBlockCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, blockedUntil] of loginBlockedUntil) {
            if (blockedUntil <= now) loginBlockedUntil.delete(key);
        }
    }, LOGIN_FAILURE_WINDOW_MS);
    loginBlockCleanupTimer.unref?.();

    function hasValidSession(req) {
        const token = parseSessionCookie(req)
        return !!token && sessionExpiresAt(sessions.get(token)) > Date.now()
    }

    function sessionAuthMiddleware(req, res, next) {
        if (hasValidSession(req)) return next()
        res.status(401).end()
    }

    async function checkAuth(req, res, returnOnlyStatus = false, {allowExpired = false} = {}){
        const reject = (code) => {
            if(!returnOnlyStatus){
                sendApiError(res, 401, code);
            }
            return false
        }
        try {
            const authHeader = req.headers['risu-auth'];
            if(!authHeader){
                return reject(API_ERROR_CODES.AUTH_REQUIRED)
            }

            const [jsonHeaderB64, jsonPayloadB64, signatureB64] = authHeader.split('.');
            const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));
            const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

            if(!allowExpired && jsonPayload.exp < Math.floor(Date.now() / 1000)){
                return reject(API_ERROR_CODES.AUTH_TOKEN_EXPIRED)
            }
            if(jsonHeader.alg !== "HS256"){
                return reject(API_ERROR_CODES.AUTH_INVALID_TOKEN)
            }

            const expectedSig = nodeCrypto.createHmac('sha256', jwtSecret)
                .update(`${jsonHeaderB64}.${jsonPayloadB64}`)
                .digest()
            const actualSig = Buffer.from(signatureB64, 'base64url')
            if(expectedSig.length !== actualSig.length || !nodeCrypto.timingSafeEqual(expectedSig, actualSig)){
                return reject(API_ERROR_CODES.AUTH_INVALID_TOKEN)
            }
            return true
        } catch {
            return reject(API_ERROR_CODES.AUTH_INVALID_TOKEN)
        }
    }

    async function checkDownloadAuth(req, res) {
        return hasValidSession(req) || await checkAuth(req, res)
    }

    return {
        authState,
        passwordPath,
        jwtSecret,
        sessionFile,
        sessions,
        loginBlockedUntil,
        LOGIN_FAILURE_WINDOW_MS,
        sessionExpiresAt,
        parseSessionCookie,
        sessionAuthMiddleware,
        checkAuth,
        checkDownloadAuth,
    };
}

module.exports = { createAuthService };
