import { describe, expect, it } from 'vitest'
import { parseAccessTokenResponse } from './token'

describe('Google token response', () => {
    it('retains provider errors and parses token lifetime on the server', async () => {
        expect(await parseAccessTokenResponse(Response.json({ access_token: 'token', token_type: 'Bearer', expires_in: 3600 }), 100))
            .toMatchObject({ accessToken: 'token', expiresInSeconds: 3600, issuedAtMs: 100 })
        await expect(parseAccessTokenResponse(Response.json({ error: 'invalid_grant' }, { status: 400 }), 100))
            .rejects.toMatchObject({ status: 400 })
    })
})
