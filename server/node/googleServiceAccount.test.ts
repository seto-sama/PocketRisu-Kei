import { verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import serviceAccountPkg from './googleServiceAccount.cjs'
import { getTestKeyPair, makeServiceAccountFixture } from '../../src/ts/preset/adapter/googleServiceAccount/__testFixtures'

const { exchangeGoogleServiceAccountToken, createServerServiceAccountTokenCache, createServerProviderAuthResolver } = serviceAccountPkg

describe('server service account token exchange', () => {
    it('resolves deferred credentials at provider dispatch and reuses the server token', async () => {
        const account = makeServiceAccountFixture()
        const fetchImpl = vi.fn(async () => Response.json({ access_token: 'server-token', expires_in: 3600 }))
        const resolveAuth = createServerProviderAuthResolver({ fetchImpl })
        const auth = { kind: 'google-service-account', serviceAccountJson: account.sourceJson }
        const headers = { Authorization: 'Bearer [server-auth]' }
        await resolveAuth(auth, headers)
        await resolveAuth(auth, {})
        expect(headers).toEqual({ authorization: 'Bearer server-token' })
        expect(fetchImpl).toHaveBeenCalledOnce()
    })
    it('signs and exchanges directly with Google without browser session authentication', async () => {
        const serviceAccount = makeServiceAccountFixture()
        const fetchImpl = vi.fn(async () => Response.json({ access_token: 'token', expires_in: 3600 }))
        const response = await exchangeGoogleServiceAccountToken({
            serviceAccountJson: serviceAccount.sourceJson, scope: 'test-scope',
            now: () => 1_000_000, fetchImpl,
        })
        expect(response.status).toBe(200)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('https://oauth2.googleapis.com/token')
        expect(init.headers).not.toHaveProperty('risu-auth')
        const params = new URLSearchParams(init.body as string)
        expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
        const [header, payload, signature] = params.get('assertion')!.split('.')
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' })
        expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
            iss: serviceAccount.clientEmail, scope: 'test-scope',
            aud: url, iat: 1000, exp: 4600,
        })
        expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), getTestKeyPair().publicKey,
            Buffer.from(signature, 'base64url'))).toBe(true)
    })

    it('preserves input validation and rejects other token destinations before sending', async () => {
        const fetchImpl = vi.fn()
        const serviceAccount = makeServiceAccountFixture()
        for (const value of ['', '{', JSON.stringify({ client_email: 'test' }),
            JSON.stringify({ ...JSON.parse(serviceAccount.sourceJson), token_uri: 'https://other.invalid/token' })]) {
            const response = await exchangeGoogleServiceAccountToken({ serviceAccountJson: value, fetchImpl })
            expect(response.status).toBe(400)
        }
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('shares token refreshes, reuses fresh tokens, and refreshes before expiry', async () => {
        let now = 1_000_000
        const fetchImpl = vi.fn(async () => Response.json({ access_token: `token-${fetchImpl.mock.calls.length}`, expires_in: 3600 }))
        const cache = createServerServiceAccountTokenCache({ now: () => now, fetchImpl })
        const input = { serviceAccount: makeServiceAccountFixture() }
        const results = await Promise.all([cache.getAccessToken(input), cache.getAccessToken(input)])
        expect(results[0]).toEqual(results[1])
        await cache.getAccessToken(input)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        now += 3541_000
        expect((await cache.getAccessToken(input)).accessToken).toBe('token-2')
    })

    it('propagates Google failures and permits a later refresh retry', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }))
            .mockResolvedValueOnce(Response.json({ access_token: 'token', expires_in: 3600 }))
        const cache = createServerServiceAccountTokenCache({ fetchImpl })
        const input = { serviceAccount: makeServiceAccountFixture() }
        await expect(cache.getAccessToken(input)).rejects.toMatchObject({ status: 400 })
        await expect(cache.getAccessToken(input)).resolves.toMatchObject({ accessToken: 'token' })
    })
})
