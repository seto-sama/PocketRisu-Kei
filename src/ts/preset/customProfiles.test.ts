import { describe, expect, it } from 'vitest'
import {
    buildProfileFragment,
    CUSTOM_ID_PREFIX,
    CUSTOM_REGISTRY_ID,
    getProfileUpdateStatus,
    importFragment,
    removeCustomProfile,
    validateFragment,
    type ProfileFragment,
} from './customProfiles'
import type { BaseProviderDefinition, ModelProfile, RegistryCache } from './types'
import { loadSpecialRegistry } from './registry/loader'

function makeBaseProvider(): BaseProviderDefinition {
    return {
        id: 'mybase',
        displayName: 'My Base',
        adapterKind: 'openai-compatible',
        authKinds: ['bearer'],
        endpointKinds: ['static'],
        requestSchema: [
            { key: 'apiKey', type: 'string', label: 'API Key', mapsTo: { target: 'auth', path: 'apiKey' } },
        ],
        uiSchema: { groups: [], fields: [] },
        sourceUrls: [],
    }
}

function makeProfile(): ModelProfile {
    return {
        id: 'myprofile',
        displayName: 'My Profile',
        providerBaseId: 'mybase',
        profileStatus: 'current',
        modelId: 'my-model',
        endpoint: { kind: 'static', url: 'https://api.example.com/v1/chat/completions' },
        auth: { kind: 'bearer', fields: ['apiKey'] },
        defaults: {},
        schema: [{ key: 'modelId', type: 'string', label: 'Model ID', mapsTo: { target: 'body', path: 'model' } }],
        uiSchema: { groups: [], fields: [] },
        sourceUrls: [],
    }
}

function makeFragment(): ProfileFragment {
    return { schemaVersion: 1, profile: makeProfile(), baseProvider: makeBaseProvider() }
}

function emptyCache(): RegistryCache {
    return { schemaVersion: 4, registries: {} }
}

describe('buildProfileFragment', () => {
    it('strips retired version fields and stamps exportedAt', () => {
        const profile = Object.assign(makeProfile(), { version: 7 })
        const baseProvider = Object.assign(makeBaseProvider(), { version: 3 })
        const f = buildProfileFragment(profile, baseProvider, 1000)
        expect(f.exportedAt).toBe(1000)
        expect('version' in f.profile).toBe(false)
        expect('version' in f.baseProvider).toBe(false)
        expect(f.profile.modelId).toBe('my-model')
    })
})

describe('validateFragment', () => {
    it('accepts a well-formed fragment', () => {
        const res = validateFragment(makeFragment())
        expect(res.ok).toBe(true)
    })

    it('rejects non-object root', () => {
        expect(validateFragment('nope').ok).toBe(false)
        expect(validateFragment(null).ok).toBe(false)
    })

    it('rejects missing profile/baseProvider', () => {
        const res = validateFragment({ schemaVersion: 1, baseProvider: makeBaseProvider() })
        expect(res.ok).toBe(false)
    })

    it('rejects an unsupported adapterKind', () => {
        const frag = makeFragment()
        ;(frag.baseProvider as { adapterKind: string }).adapterKind = 'cohere'
        const res = validateFragment(frag)
        expect(res.ok).toBe(false)
        expect(res.errors.some((e) => e.includes('adapterKind'))).toBe(true)
    })

    it('rejects providerBaseId / baseProvider.id mismatch', () => {
        const frag = makeFragment()
        frag.profile.providerBaseId = 'other'
        const res = validateFragment(frag)
        expect(res.ok).toBe(false)
        expect(res.errors.some((e) => e.includes('providerBaseId'))).toBe(true)
    })

    it('rejects a profile missing modelId', () => {
        const frag = makeFragment()
        delete (frag.profile as { modelId?: string }).modelId
        expect(validateFragment(frag).ok).toBe(false)
    })

    it('accepts an empty modelId (supplied via userValues, e.g. deepinfra)', () => {
        const frag = makeFragment()
        frag.profile.modelId = ''
        expect(validateFragment(frag).ok).toBe(true)
    })
})

describe('importFragment', () => {
    it('namespaces ids, matches providerBaseId, and defaults updatedAt', () => {
        const cache = emptyCache()
        const fragment = makeFragment()
        Object.assign(fragment.profile, { version: 5 })
        Object.assign(fragment.baseProvider, { version: 2 })
        const { profileId, overwritten } = importFragment(cache, fragment, 2000)

        expect(profileId).toBe(`${CUSTOM_ID_PREFIX}myprofile`)
        expect(overwritten).toBe(false)

        const reg = cache.registries[CUSTOM_REGISTRY_ID]
        const stored = reg.profiles![profileId]
        expect(stored.providerBaseId).toBe(`${CUSTOM_ID_PREFIX}mybase`)
        expect(stored.updatedAt).toBe(2000)
        expect('version' in stored).toBe(false)
        expect('version' in reg.baseProviders![`${CUSTOM_ID_PREFIX}mybase`]).toBe(false)
        expect(reg.baseProviders![`${CUSTOM_ID_PREFIX}mybase`]).toBeDefined()
    })

    it('keeps already-prefixed ids and reports overwrite on second import', () => {
        const cache = emptyCache()
        const frag = makeFragment()
        frag.profile.id = `${CUSTOM_ID_PREFIX}fixed`
        frag.profile.providerBaseId = `${CUSTOM_ID_PREFIX}fixedbase`
        frag.baseProvider.id = `${CUSTOM_ID_PREFIX}fixedbase`

        const first = importFragment(cache, frag, 1)
        expect(first.profileId).toBe(`${CUSTOM_ID_PREFIX}fixed`)
        expect(first.overwritten).toBe(false)

        const second = importFragment(cache, frag, 2)
        expect(second.overwritten).toBe(true)
    })

    it('preserves an explicit updatedAt', () => {
        const cache = emptyCache()
        const frag = makeFragment()
        frag.profile.updatedAt = 12345
        importFragment(cache, frag, 9999)
        const reg = cache.registries[CUSTOM_REGISTRY_ID]
        expect(reg.profiles![`${CUSTOM_ID_PREFIX}myprofile`].updatedAt).toBe(12345)
    })
})

describe('special profiles round-trip (export → import validation)', () => {
    it('every special profile exports to a fragment that re-imports cleanly', () => {
        const reg = loadSpecialRegistry()
        const failures: string[] = []
        for (const r of Object.values(reg.registries)) {
            for (const profile of Object.values(r.profiles ?? {})) {
                const base = r.baseProviders?.[profile.providerBaseId]
                if (!base) {
                    failures.push(`${profile.id}: missing base provider ${profile.providerBaseId}`)
                    continue
                }
                const frag = buildProfileFragment(profile, base, 1)
                const res = validateFragment(frag)
                if (!res.ok) failures.push(`${profile.id}: ${res.errors.join('; ')}`)
            }
        }
        expect(failures).toEqual([])
    })
})

describe('getProfileUpdateStatus', () => {
    const withUpdatedAt = (t?: number) => ({ ...makeProfile(), updatedAt: t })

    it('missing when current profile is undefined', () => {
        expect(getProfileUpdateStatus(undefined, 100)).toBe('missing')
    })
    it('updatable when current is strictly newer', () => {
        expect(getProfileUpdateStatus(withUpdatedAt(200), 100)).toBe('updatable')
    })
    it('none when equal or older', () => {
        expect(getProfileUpdateStatus(withUpdatedAt(100), 100)).toBe('none')
        expect(getProfileUpdateStatus(withUpdatedAt(50), 100)).toBe('none')
    })
    it('none when either timestamp is unknown', () => {
        expect(getProfileUpdateStatus(withUpdatedAt(undefined), 100)).toBe('none')
        expect(getProfileUpdateStatus(withUpdatedAt(200), undefined)).toBe('none')
    })
})

describe('removeCustomProfile', () => {
    it('removes the profile and its now-unreferenced base provider', () => {
        const cache = emptyCache()
        const { profileId } = importFragment(cache, makeFragment(), 1)
        removeCustomProfile(cache, profileId)
        const reg = cache.registries[CUSTOM_REGISTRY_ID]
        expect(reg.profiles![profileId]).toBeUndefined()
        expect(reg.baseProviders![`${CUSTOM_ID_PREFIX}mybase`]).toBeUndefined()
    })

    it('keeps a base provider still used by another profile', () => {
        const cache = emptyCache()
        const a = makeFragment()
        a.profile.id = `${CUSTOM_ID_PREFIX}a`
        const b = makeFragment()
        b.profile.id = `${CUSTOM_ID_PREFIX}b`
        importFragment(cache, a, 1)
        importFragment(cache, b, 1)
        removeCustomProfile(cache, `${CUSTOM_ID_PREFIX}a`)
        const reg = cache.registries[CUSTOM_REGISTRY_ID]
        expect(reg.baseProviders![`${CUSTOM_ID_PREFIX}mybase`]).toBeDefined()
    })
})
