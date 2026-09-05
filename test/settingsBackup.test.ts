import { describe, expect, it } from 'vitest'
import settingsBackup from '../server/node/settingsBackup.cjs'

const {
    buildSettingsBackupPlan,
    stripToSettingsOnly,
} = settingsBackup

const database = {
    characters: [{ image: 'assets/character.png', chats: [{ message: ['secret'] }] }],
    characterOrder: ['character-id'],
    apiType: 'openai',
    personas: [{ icon: 'assets/shared.png' }],
    modules: [{
        icon: 'assets/module-icon.png',
        assets: [
            ['only', 'assets/module-only.png'],
            ['shared', 'assets/shared.png'],
        ],
    }],
}

const assetRows = [
    { key: 'assets/character.png', size: 10 },
    { key: 'assets/shared.png', size: 20 },
    { key: 'assets/module-icon.png', size: 30 },
    { key: 'assets/module-only.png', size: 40 },
    { key: 'assets/orphan.png', size: 50 },
]

function createPlan(includeModuleAssets: boolean) {
    return buildSettingsBackupPlan({
        databaseValue: Buffer.from('database'),
        assetRows,
        decodeDatabase: async () => database,
        encodeDatabase: (value: unknown) => Buffer.from(JSON.stringify(value)),
        includeModuleAssets,
    })
}

describe('settings backup', () => {
    it('removes characters and their ordering', () => {
        const trimmed = stripToSettingsOnly(database)
        expect(trimmed.characters).toEqual([])
        expect(trimmed.characterOrder).toEqual([])
        expect(trimmed.apiType).toBe('openai')
        expect(database.characters).toHaveLength(1)
    })

    it('module asset option never drops assets with another settings owner', async () => {
        const withModules = await createPlan(true)
        const withoutModules = await createPlan(false)

        expect(withModules.includedAssetNames).toContain('module-only.png')
        expect(withoutModules.includedAssetNames).not.toContain('module-only.png')
        expect(withoutModules.includedAssetNames).toContain('shared.png')
        expect(withoutModules.includedAssetNames).toContain('module-icon.png')
        expect(withoutModules.includedAssetNames).not.toContain('character.png')
        expect(new Set(withoutModules.includedAssets.map((asset: { key: string }) => asset.key))).toEqual(
            new Set(['assets/shared.png', 'assets/module-icon.png']),
        )
        expect(withModules.breakdown.moduleAssets.bytes).toBe(40)
        expect(withModules.breakdown.moduleAssets.count).toBe(1)

        const exportedDatabase = JSON.parse(withoutModules.encodedDatabase.toString('utf-8'))
        expect(exportedDatabase.characters).toEqual([])
        expect(exportedDatabase.characterOrder).toEqual([])
    })
})
