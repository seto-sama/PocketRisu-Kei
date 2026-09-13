'use strict';

const { writeFileSync } = require('fs');
const rateLimit = require('express-rate-limit');
const nodeCrypto = require('crypto');

function installAuthRoutes(app, {
    SESSION_FILE,
    sessions,
    loginBlockedUntil,
    LOGIN_FAILURE_WINDOW_MS,
    jwtSecret,
    authState,
    checkAuth,
    parseSessionCookie,
    sessionExpiresAt,
    getSyncClientIdFromRequest,
    syncClientDevices,
    passwordPath,
}) {
    function saveSessions() {
        try { writeFileSync(SESSION_FILE, JSON.stringify([...sessions])) }
        catch { /* non-critical */ }
    }

    const LOGIN_FAILURE_LIMIT = 10;

    const LOGIN_LOCK_MS = 30 * 60 * 1000;

    function loginClientKey(req) {
        return rateLimit.ipKeyGenerator(req.ip);
    }

    function sendLoginBlocked(res, blockedUntil) {
        const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).send({
            error: 'Too many failed attempts. Please wait and try again later.'
        });
    }

    function startLoginBlock(req, res) {
        const blockedUntil = Date.now() + LOGIN_LOCK_MS;
        loginBlockedUntil.set(loginClientKey(req), blockedUntil);
        return sendLoginBlocked(res, blockedUntil);
    }

    function rejectBlockedLogin(req, res, next) {
        const key = loginClientKey(req);
        const blockedUntil = loginBlockedUntil.get(key) || 0;
        if (blockedUntil > Date.now()) {
            sendLoginBlocked(res, blockedUntil);
            return;
        }
        if (blockedUntil) loginBlockedUntil.delete(key);
        next();
    }

    const loginRouteLimiter = rateLimit({
        windowMs: LOGIN_FAILURE_WINDOW_MS,
        max: LOGIN_FAILURE_LIMIT,
        skipSuccessfulRequests: true,
        requestWasSuccessful: (_req, res) => res.statusCode !== 401,
        standardHeaders: false,
        legacyHeaders: false,
        handler: startLoginBlock,
        validate: { xForwardedForHeader: false }
    });

    function createServerJwt() {
        const now = Math.floor(Date.now() / 1000)
        const header = { alg: 'HS256', typ: 'JWT' }
        const payload = { iat: now, exp: now + 5 * 60 }
        const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
        const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
        const sig = nodeCrypto.createHmac('sha256', jwtSecret)
            .update(`${headerB64}.${payloadB64}`)
            .digest('base64url')
        return `${headerB64}.${payloadB64}.${sig}`
    }

    app.get('/api/test_auth', async(req, res) => {

        if(!authState.password){
            res.send({status: 'unset'})
        }
        else if(!await checkAuth(req, res, true)){
            // JWT missing/invalid – fall back to session cookie (survives page refresh)
            const sessionToken = parseSessionCookie(req)
            if (sessionToken && sessionExpiresAt(sessions.get(sessionToken)) > Date.now()) {
                res.send({status: 'success', token: createServerJwt()})
            } else {
                res.send({status: 'incorrect'})
            }
        }
        else{
            res.send({status: 'success', token: createServerJwt()})
        }
    })

    app.post('/api/login', rejectBlockedLogin, loginRouteLimiter, async (req, res) => {
        if(authState.password === ''){
            res.status(400).send({error: 'Password not set'})
            return;
        }
        if(req.body.password && req.body.password.trim() === authState.password.trim()){
            res.send({status:'success', token: createServerJwt()})
        }
        else{
            if ((req.rateLimit?.used ?? 0) >= LOGIN_FAILURE_LIMIT) {
                startLoginBlock(req, res)
                return
            }
            res.status(401).send({error: 'Password incorrect'})
        }
    })

    app.post('/api/token/refresh', async (req, res) => {
        if (!await checkAuth(req, res, false, {allowExpired: true})) return
        res.json({ token: createServerJwt() })
    })

    app.post('/api/session', async (req, res) => {
        if (!await checkAuth(req, res)) return
        const clientSessionId = getSyncClientIdFromRequest(req)
        if (clientSessionId) {
            console.log('[Session] Sync client session registered')
        }
        const now = Date.now()
        const existingToken = parseSessionCookie(req)
        const token = existingToken && sessionExpiresAt(sessions.get(existingToken)) > now
            ? existingToken
            : nodeCrypto.randomBytes(32).toString('hex')
        const maxAge = 7 * 24 * 60 * 60 // seconds
        const expiresAt = now + maxAge * 1000
        sessions.set(token, expiresAt)
        // Prune stale sessions (bounded by single-user usage, safe to do inline)
        for (const [t, session] of sessions) {
            if (sessionExpiresAt(session) <= now) sessions.delete(t)
        }
        saveSessions()
        res.setHeader('Set-Cookie', `risu-session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`)
        res.json({
            ok: true,
        })
    })

    app.get('/api/active-devices', async (req, res) => {
        if (!await checkAuth(req, res)) return
        const currentClientId = String(getSyncClientIdFromRequest(req))
        res.json({
            devices: [...syncClientDevices].map(([clientId, entry]) => ({
                id: nodeCrypto.createHash('sha256').update(clientId).digest('hex'),
                device: entry.device,
                connectedAt: entry.connectedAt,
                current: clientId === currentClientId,
            })).sort((a, b) => Number(b.current) - Number(a.current) || b.connectedAt - a.connectedAt),
        })
    })

    app.post('/api/crypto', async (req, res) => {
        try {
            const hash = nodeCrypto.createHash('sha256')
            hash.update(Buffer.from(req.body.data, 'utf-8'))
            res.send(hash.digest('hex'))
        } catch (error) {
            res.status(500).send({ error: 'Crypto operation failed' });
        }
    })

    app.post('/api/set_password', async (req, res) => {
        if(authState.password === ''){
            authState.password = req.body.password
            writeFileSync(passwordPath, authState.password, 'utf-8')
            res.send({status: 'success'})
        }
        else{
            res.status(400).send("already set")
        }
    })
}

module.exports = { installAuthRoutes };
