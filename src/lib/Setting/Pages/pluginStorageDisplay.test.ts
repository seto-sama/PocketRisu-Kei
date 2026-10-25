import { describe, expect, test } from 'vitest'
import { describePluginStorageValue } from './pluginStorageDisplay'

describe('plugin storage value display', () => {
    test('keeps ordinary JSON and local strings editable', () => {
        expect(describePluginStorageValue({ text: 'value', count: 2 })).toMatchObject({
            str: '{"text":"value","count":2}',
            type: 'object',
            jsonEditable: true,
            binarySize: false,
        })
        expect(describePluginStorageValue('plain text')).toMatchObject({
            str: 'plain text',
            type: 'string',
            jsonEditable: true,
        })
        expect(describePluginStorageValue(null)).toMatchObject({
            str: 'null',
            type: 'null',
            jsonEditable: true,
        })
        const jsonString = '{ "id": 9007199254740993, "enabled": true }\n'
        expect(describePluginStorageValue(jsonString)).toMatchObject({ str: jsonString, type: 'string', jsonEditable: true })
    })

    test('summarizes a binary value without expanding its bytes', () => {
        const display = describePluginStorageValue({ asset: new Blob(['image'], { type: 'image/png' }) })

        expect(display).toMatchObject({
            str: '{"asset":"Blob (5 B, image/png)"}',
            size: 5,
            type: 'object',
            jsonEditable: false,
            binarySize: true,
            mimeType: 'image/png',
        })
    })

    test('uses a typed array byte length in its compact preview', () => {
        expect(describePluginStorageValue(new Uint8Array([1, 2, 3]))).toMatchObject({
            str: 'Uint8Array (3 B)',
            size: 3,
            type: 'Uint8Array',
            jsonEditable: false,
            binarySize: true,
        })
    })

    test('keeps values that JSON would change read-only', () => {
        const shared = { value: 1 }
        const cycle: any = {}
        cycle.self = cycle
        for (const value of [new Map(), { value: undefined }, { value: 1n }, { value: NaN }, { value: -0 },
            { first: shared, second: shared }, cycle, new Array(2)]) {
            expect(describePluginStorageValue(value).jsonEditable).toBe(false)
        }
    })

    test('keeps truncated previews read-only', () => {
        let value: object = { text: 'deep value' }
        for (let index = 0; index < 30; index++) value = { nested: value }
        expect(describePluginStorageValue(value)).toMatchObject({ jsonEditable: false })
    })
})
