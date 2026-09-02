import { describe, expect, test } from 'vitest'
import { getOfficialRegistryId, loadSpecialRegistry } from './loader'

describe('loadSpecialRegistry', () => {
    test('contains the always-available Developer recipes', () => {
        const registry = loadSpecialRegistry()
        const entry = registry.registries[getOfficialRegistryId()]

        expect(entry?.profiles?.['developer:echo']?.providerBaseId).toBe('developer')
        expect(entry?.profiles?.['developer:custom']?.providerBaseId).toBe('developer-custom')
        expect(entry?.profiles?.['developer:echo']?.uiSchema.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'echoMessage', widget: 'textarea', layout: 'row' }),
            expect.objectContaining({ key: 'echoDelay', widget: 'number-input', layout: 'row' }),
        ]))
        expect(entry?.profiles?.['developer:echo']?.defaults).toMatchObject({
            echoMessage: 'Echo Message',
            echoDelay: 0,
        })
        expect(entry?.profiles?.['developer:echo']?.schema).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'echoMessage', default: 'Echo Message' }),
            expect.objectContaining({ key: 'echoDelay', default: 0 }),
        ]))
    })
})
