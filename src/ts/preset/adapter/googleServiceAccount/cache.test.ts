import { describe, expect, test } from 'vitest'
import { createServiceAccountTokenCache } from './cache'
import type { AccessTokenResult, ExchangeServiceAccountInput } from './token'
import { makeServiceAccountFixture } from './__testFixtures'

interface ExchangeCall {
    scope: string | undefined
    abortSignal: AbortSignal | undefined
}

function makeExchanger(opts: {
    waitFor?: Promise<void>
    expiresInSeconds?: number
    issuedAtMs: number
    accessToken?: string
    failOnce?: boolean
}) {
    const calls: ExchangeCall[] = []
    let failedOnce = false
    let counter = 0
    const exchange = async (input: ExchangeServiceAccountInput) => {
        calls.push({ scope: input.scope, abortSignal: input.abortSignal })
        if (opts.failOnce && !failedOnce) {
            failedOnce = true
            throw new Error('simulated fetch failure')
        }
        await opts.waitFor
        counter += 1
        return {
            accessToken: opts.accessToken ?? `token-${counter}`,
            tokenType: 'Bearer',
            expiresInSeconds: opts.expiresInSeconds ?? 3600,
            issuedAtMs: opts.issuedAtMs,
        }
    }
    return { exchange, calls }
}

describe('createServiceAccountTokenCache', () => {
    test('fetches a token on first call and reuses it within TTL', async () => {
        let nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()

        const first = await cache.getAccessToken({ serviceAccount: sa })
        expect(first.accessToken).toBe('token-1')
        expect(first.expiresAtMs).toBe(nowMs + 3600 * 1000)
        expect(calls).toHaveLength(1)

        // Advance well within TTL.
        nowMs += 10_000
        const second = await cache.getAccessToken({ serviceAccount: sa })
        expect(second.accessToken).toBe('token-1')
        expect(calls).toHaveLength(1)
    })

    test('refreshes when within 60s of expiry (skew buffer)', async () => {
        let nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()

        const first = await cache.getAccessToken({ serviceAccount: sa })
        expect(first.accessToken).toBe('token-1')

        // 59s before expiry — within skew, should refresh.
        nowMs += (3600 - 59) * 1000
        const second = await cache.getAccessToken({ serviceAccount: sa })
        expect(calls).toHaveLength(2)
        expect(second.accessToken).toBe('token-2')
    })

    test('does NOT refresh when 61s remain (outside skew)', async () => {
        let nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()

        await cache.getAccessToken({ serviceAccount: sa })
        // 61s before expiry.
        nowMs += (3600 - 61) * 1000
        const second = await cache.getAccessToken({ serviceAccount: sa })
        expect(calls).toHaveLength(1)
        expect(second.accessToken).toBe('token-1')
    })

    test('single-flights concurrent requests for same key', async () => {
        const nowMs = 1_000_000
        let releaseExchange!: () => void
        const exchangeGate = new Promise<void>(resolve => { releaseExchange = resolve })
        const { exchange, calls } = makeExchanger({
            issuedAtMs: nowMs,
            expiresInSeconds: 3600,
            waitFor: exchangeGate,
        })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()

        const requests = Promise.all([
            cache.getAccessToken({ serviceAccount: sa }),
            cache.getAccessToken({ serviceAccount: sa }),
            cache.getAccessToken({ serviceAccount: sa }),
        ])
        expect(calls).toHaveLength(1)
        releaseExchange()
        const [a, b, c] = await requests
        expect(calls).toHaveLength(1)
        expect(a.accessToken).toBe('token-1')
        expect(b.accessToken).toBe('token-1')
        expect(c.accessToken).toBe('token-1')
    })

    test('uses separate cache entries per scope', async () => {
        const nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()

        const a = await cache.getAccessToken({ serviceAccount: sa, scope: 'scope-a' })
        const b = await cache.getAccessToken({ serviceAccount: sa, scope: 'scope-b' })
        expect(calls).toHaveLength(2)
        expect(calls[0].scope).toBe('scope-a')
        expect(calls[1].scope).toBe('scope-b')
        expect(a.accessToken).not.toBe(b.accessToken)
    })

    test('uses separate cache entries per service account', async () => {
        const nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa1 = makeServiceAccountFixture({ clientEmail: 'a@svc.iam.gserviceaccount.com' })
        const sa2 = makeServiceAccountFixture({ clientEmail: 'b@svc.iam.gserviceaccount.com' })

        await cache.getAccessToken({ serviceAccount: sa1 })
        await cache.getAccessToken({ serviceAccount: sa2 })
        expect(calls).toHaveLength(2)
    })

    test('retries after a failed exchange (does not cache failure)', async () => {
        let nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({
            issuedAtMs: nowMs,
            expiresInSeconds: 3600,
            failOnce: true,
        })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()

        await expect(cache.getAccessToken({ serviceAccount: sa })).rejects.toThrow(
            'simulated fetch failure',
        )
        // Subsequent call retries.
        const second = await cache.getAccessToken({ serviceAccount: sa })
        expect(calls).toHaveLength(2)
        expect(second.accessToken).toBe('token-1')
    })

    test('clear() drops cached tokens', async () => {
        const nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()

        await cache.getAccessToken({ serviceAccount: sa })
        cache.clear()
        await cache.getAccessToken({ serviceAccount: sa })
        expect(calls).toHaveLength(2)
    })

    test('never forwards the caller AbortSignal into the shared token exchange', async () => {
        const nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()
        const controller = new AbortController()

        await cache.getAccessToken({ serviceAccount: sa, abortSignal: controller.signal })
        expect(calls).toHaveLength(1)
        // Shared refresh must not be cancellable by a single caller — its signal
        // belongs to the wait, not to the work.
        expect(calls[0].abortSignal).toBeUndefined()
    })

    test('aborting one caller does NOT cancel a concurrent caller sharing the same refresh', async () => {
        const nowMs = 1_000_000
        let releaseExchange!: () => void
        const exchangeGate = new Promise<void>(resolve => { releaseExchange = resolve })
        const { exchange, calls } = makeExchanger({
            issuedAtMs: nowMs,
            expiresInSeconds: 3600,
            waitFor: exchangeGate,
        })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()
        const aController = new AbortController()

        const aPromise = cache.getAccessToken({ serviceAccount: sa, abortSignal: aController.signal })
        const bPromise = cache.getAccessToken({ serviceAccount: sa })

        // Abort A while the shared exchange is still in flight.
        aController.abort()

        await expect(aPromise).rejects.toMatchObject({
            kind: 'aborted',
            retryable: false,
            fallbackEligible: false,
        })
        releaseExchange()
        const bResult = await bPromise
        expect(bResult.accessToken).toBe('token-1')
        // Exchange ran exactly once — A's abort didn't kill B's refresh.
        expect(calls).toHaveLength(1)
    })

    test('rejects with an aborted ModelPresetAdapterError when caller signal is pre-aborted', async () => {
        const nowMs = 1_000_000
        const { exchange } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()
        const controller = new AbortController()
        controller.abort()

        await expect(
            cache.getAccessToken({ serviceAccount: sa, abortSignal: controller.signal }),
        ).rejects.toMatchObject({
            kind: 'aborted',
            retryable: false,
            fallbackEligible: false,
        })
    })

    test('pre-aborted signal does NOT start a token exchange (round-2 finding)', async () => {
        const nowMs = 1_000_000
        const { exchange, calls } = makeExchanger({ issuedAtMs: nowMs, expiresInSeconds: 3600 })
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()
        const controller = new AbortController()
        controller.abort()

        await expect(
            cache.getAccessToken({ serviceAccount: sa, abortSignal: controller.signal }),
        ).rejects.toMatchObject({ kind: 'aborted' })

        // Burning a token exchange call for a request that was already
        // cancelled is wasteful and risks unhandled background rejections.
        expect(calls).toHaveLength(0)
    })

    test('retries cleanly after an aborted caller leaves a failed shared exchange', async () => {
        // Reproduce: a single caller starts the shared refresh and aborts
        // before it resolves. The shared exchange then rejects in the
        // background. Without a defensive .catch on the inflight promise the
        // rejection would escape to process unhandledRejection.
        const nowMs = 1_000_000
        let rejectExchange: (err: unknown) => void = () => undefined
        let attempts = 0
        const exchange = (): Promise<AccessTokenResult> => {
            attempts += 1
            if (attempts > 1) {
                return Promise.resolve({
                    accessToken: 'recovered-token',
                    tokenType: 'Bearer',
                    expiresInSeconds: 3600,
                    issuedAtMs: nowMs,
                })
            }
            return new Promise((_resolve, reject) => { rejectExchange = reject })
        }
        const cache = createServiceAccountTokenCache({ now: () => nowMs, exchange })
        const sa = makeServiceAccountFixture()
        const controller = new AbortController()

        const callerPromise = cache.getAccessToken({
            serviceAccount: sa,
            abortSignal: controller.signal,
        })
        controller.abort()
        await expect(callerPromise).rejects.toMatchObject({ kind: 'aborted' })

        // The abandoned shared exchange fails after its only caller aborted.
        rejectExchange(new Error('background exchange failure'))
        await Promise.resolve()

        await expect(cache.getAccessToken({ serviceAccount: sa })).resolves.toMatchObject({
            accessToken: 'recovered-token',
        })
        expect(attempts).toBe(2)
    })
})
