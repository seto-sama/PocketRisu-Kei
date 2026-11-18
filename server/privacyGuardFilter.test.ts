import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createHiddenInlayFilter, filterHiddenFolders, mergeHiddenFolders } = require('./privacyGuardFilter.cjs')

describe('privacy guard filter', () => {
    it('keeps a character trashed from a local-only folder hidden and preserved', () => {
        const local = {
            characterOrder: ['shown'],
            characters: [
                { chaId: 'shown', name: 'Shown' },
                { chaId: 'secret', name: 'Secret', trashTime: 1, trashFolder: { id: 'F', name: 'Private', color: '', localOnly: true } },
            ],
        }

        const visible = filterHiddenFolders(local)
        expect(visible.characters.map((char: any) => char.chaId)).toEqual(['shown'])

        const merged = mergeHiddenFolders(local, visible)
        expect(merged.characters.map((char: any) => char.chaId)).toEqual(['shown', 'secret'])
    })

    it('hides inlays owned by a hidden character or a chat in a hidden chat folder', () => {
        const isHidden = createHiddenInlayFilter({
            characterOrder: [{ id: 'F', name: 'Private', localOnly: true, data: ['secret'] }, 'shown'],
            characters: [
                { chaId: 'secret', chats: [{ id: 'secret-chat' }] },
                {
                    chaId: 'shown',
                    chatFolders: [{ id: 'CF', localOnly: true }],
                    chats: [{ id: 'open-chat' }, { id: 'private-chat', folderId: 'CF' }],
                },
            ],
        })

        expect(isHidden({ charId: 'secret' })).toBe(true)
        expect(isHidden({ chatId: 'secret-chat' })).toBe(true)
        expect(isHidden({ charId: 'shown', chatId: 'private-chat' })).toBe(true)
        expect(isHidden({ charId: 'shown', chatId: 'open-chat' })).toBe(false)
        expect(isHidden({})).toBe(false)
    })
})
