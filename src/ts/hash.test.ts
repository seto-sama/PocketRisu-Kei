import { expect, test } from 'vitest'
import { sha256Hex } from './hash'

test('hashes only the requested byte range', async () => {
    const bytes = new TextEncoder().encode('_abc_').subarray(1, 4)
    expect(await sha256Hex(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
