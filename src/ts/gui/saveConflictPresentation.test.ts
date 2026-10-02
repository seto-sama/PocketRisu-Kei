import { describe, expect, it } from 'vitest'
import { language } from 'src/lang'
import { presentSaveConflict } from './saveConflictPresentation'

describe('save conflict presentation', () => {
    it('identifies nested entities by name and distinguishes chat notes from persona notes', () => {
        const source = {
            characters: [{ chaId: 'character', name: 'Character name', chats: [{ id: 'room', name: 'Chat name' }] }],
            personas: [{ id: 'persona', name: 'Persona name' }],
        }
        const chat = presentSaveConflict({
            path: ['characters', { key: 'chaId', value: 'character' }, 'chats', { key: 'id', value: 'room' }, 'note'],
            base: '', server: 'Server note', local: 'Local note',
        }, 0, source)
        const persona = presentSaveConflict({
            path: ['personas', { key: 'id', value: 'persona' }, 'note'],
            base: '', server: 'Server note', local: 'Local note',
        }, 1, source)
        expect(chat.label).toContain('Character name')
        expect(chat.label).toContain('Chat name')
        expect(chat.label).toContain(language.authorNote)
        expect(persona.label).toContain('Persona name')
        expect(persona.label.startsWith(`${language.persona} ›`)).toBe(true)
        expect(persona.label).toContain(language.note)
        expect(persona.label).not.toContain(language.authorNote)
    })

    it('retains changed nested values including false, zero, empty strings and missing fields', () => {
        const result = presentSaveConflict({
            path: ['pluginCustomStorage'], base: {},
            server: { settings: { enabled: true, count: 1, text: 'Before', removed: 'Present' }, unchanged: 'Same' },
            local: { settings: { enabled: false, count: 0, text: '' }, unchanged: 'Same' },
        }, 0)
        expect(result.blocks.map(block => block.local.text)).toEqual(['false', '0', language.saveConflict.empty, language.saveConflict.deleted])
        expect(result.blocks.map(block => block.server.text)).toEqual(['true', '1', 'Before', 'Present'])
    })
})
