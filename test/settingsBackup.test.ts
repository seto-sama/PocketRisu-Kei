import { describe, expect, it } from 'vitest'
import settingsBackup from '../server/node/settingsBackup.cjs'

const { buildSettingsBackupPlan } = settingsBackup

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
        database,
        assetRows,
        includeModuleAssets,
    })
}

describe('settings backup', () => {
    it('module asset option never drops assets with another settings owner', () => {
        const withModules = createPlan(true)
        const withoutModules = createPlan(false)

        expect(withModules.includedAssets.map((asset: { key: string }) => asset.key)).toContain('assets/module-only.png')
        expect(new Set(withoutModules.includedAssets.map((asset: { key: string }) => asset.key))).toEqual(
            new Set(['assets/shared.png', 'assets/module-icon.png']),
        )
        expect(withModules.breakdown.moduleAssets.bytes).toBe(40)
        expect(withModules.breakdown.moduleAssets.count).toBe(1)

        const exportedDatabase = withoutModules.database
        expect(exportedDatabase.characters).toEqual([])
        expect(exportedDatabase.characterOrder).toEqual([])
        expect(exportedDatabase.apiType).toBe('openai')
        expect(database.characters).toHaveLength(1)
    })
})
