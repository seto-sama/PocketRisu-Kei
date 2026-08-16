import { describe, expect, it } from 'vitest'
import {
    characterToClientWriteShape,
    characterToPersistentShape,
    initializeCharacterRuntimeState,
    isClientWritableCharacterField,
    isRuntimeOnlyCharacterField,
    rootValueToClientWriteShape,
    visitClientWritableRootValues,
} from './persistenceShape'

describe('character persistence shape', () => {
    it('removes render invalidation state without changing the live character', () => {
        const character = {
            chaId: 'character',
            name: 'Name',
            reloadKeys: 42,
            lastInteraction: 123,
        }

        expect(characterToPersistentShape(character)).toEqual({
            chaId: 'character',
            name: 'Name',
            lastInteraction: 123,
        })
        expect(character.reloadKeys).toBe(42)
        expect(isRuntimeOnlyCharacterField('reloadKeys')).toBe(true)
        expect(isRuntimeOnlyCharacterField('lastInteraction')).toBe(false)
    })

    it('omits server-owned metadata from browser writes', () => {
        expect(characterToClientWriteShape({
            chaId: 'character',
            name: 'Name',
            reloadKeys: 42,
            lastInteraction: 123,
        })).toEqual({
            chaId: 'character',
            name: 'Name',
        })
        expect(rootValueToClientWriteShape('statics', {
            messages: 7,
            imports: 2,
        })).toEqual({ imports: 2 })
        expect(isClientWritableCharacterField('name')).toBe(true)
        expect(isClientWritableCharacterField('reloadKeys')).toBe(false)
        expect(isClientWritableCharacterField('lastInteraction')).toBe(false)
    })

    it('does not read server-owned root values during reactive tracking', () => {
        let messagesRead = false
        const statics = {
            imports: 2,
            get messages() {
                messagesRead = true
                return 7
            },
        }
        const visited: unknown[] = []

        visitClientWritableRootValues('statics', statics, value => visited.push(value))

        expect(visited).toEqual([2])
        expect(messagesRead).toBe(false)
    })

    it('restores the render counter after loading a persistent character', () => {
        expect(initializeCharacterRuntimeState({ chaId: 'character' })).toEqual({
            chaId: 'character',
            reloadKeys: 0,
        })
    })
})
