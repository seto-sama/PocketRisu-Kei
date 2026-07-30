import { describe, expect, it } from 'vitest'
import { resolveSnapshot } from './snapshot'
import type { RegistryCache } from '../types'

// Guards against the "Cannot read properties of null (reading 'key')" crash:
// malformed registry data with null array elements must not break resolution.
describe('resolveSnapshot null-element tolerance', () => {
    const reg = {
        schemaVersion: 4,
        registries: {
            bundled: {
                fetchedAt: 0,
                baseProviders: {
                    p: {
                        id: 'p',
                        adapterKind: 'openaiCompatible',
                        requestSchema: [null, { key: 'a', type: 'string' }],
                        uiSchema: { groups: [null], fields: [null, { key: 'a' }] },
                    },
                },
                profiles: {
                    x: {
                        id: 'x',
                        providerBaseId: 'p',
                        displayName: 'X',
                        schema: [null, { key: 'b', type: 'string' }],
                        uiSchema: { groups: [null], fields: [null, { key: 'b' }] },
                    },
                },
            },
        },
    } as unknown as RegistryCache

    it('does not throw and drops null entries', () => {
        const snap = resolveSnapshot(reg, 'x')
        expect(snap.schema.every((f) => f != null)).toBe(true)
        expect(snap.uiSchema.fields.every((f) => f != null)).toBe(true)
        expect(snap.uiSchema.groups.every((g) => g != null)).toBe(true)
        expect(snap.schema.map((f) => f.key).sort()).toEqual(['a', 'b'])
    })
})
