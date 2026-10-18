import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let getLogClientId: typeof import('./log').getLogClientId

beforeEach(async () => {
    vi.resetModules()
    localStorage.clear()
    const log = await import('./log')
    getLogClientId = log.getLogClientId
})

afterEach(() => vi.restoreAllMocks())

test('uses the existing browser identity for logs', () => {
    localStorage.setItem('risu-client-id', 'existing-client')
    expect(getLogClientId()).toBe('existi')
    expect(localStorage.getItem('risu-client-id')).toBe('existing-client')
})

test('persists a new browser identity and reuses its short log label', () => {
    const clientId = getLogClientId()
    expect(localStorage.getItem('risu-client-id')?.slice(0, 6)).toBe(clientId)
    expect(getLogClientId()).toBe(clientId)
})

test.each(['getItem', 'setItem'] as const)('keeps a stable log identity when storage %s fails', method => {
    vi.spyOn(localStorage, method).mockImplementation(() => { throw new Error('Storage unavailable') })
    const clientId = getLogClientId()
    expect(clientId).toMatch(/^[0-9a-f]{6}$/)
    expect(getLogClientId()).toBe(clientId)
})
