import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { filterRemoteOnlyFolders, mergeRemoteFilteredDatabase } = require('./remoteDatabaseFilter.cjs')

describe('remote database filter', () => {
    it('keeps a character trashed from a local-only folder hidden and preserved', () => {
        const local = {
            characterOrder: ['shown'],
            characters: [
                { chaId: 'shown', name: 'Shown' },
                { chaId: 'secret', name: 'Secret', trashTime: 1, trashFolder: { id: 'F', name: 'Private', color: '', localOnly: true } },
            ],
        }

        const remote = filterRemoteOnlyFolders(local)
        expect(remote.characters.map((char: any) => char.chaId)).toEqual(['shown'])

        const merged = mergeRemoteFilteredDatabase(local, remote)
        expect(merged.characters.map((char: any) => char.chaId)).toEqual(['shown', 'secret'])
    })
})
