import { expect, test } from 'vitest'
import { sha256Hex } from './hash'

test.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
])('hashes a string using SHA-256 (%j)', async (input, expected) => {
    expect(await sha256Hex(input)).toBe(expected)
})

test('hashes only the requested byte range', async () => {
    const bytes = new TextEncoder().encode('_abc_').subarray(1, 4)
    expect(await sha256Hex(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
