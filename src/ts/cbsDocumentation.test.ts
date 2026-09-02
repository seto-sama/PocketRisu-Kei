import { describe, expect, test } from 'vitest'
import { getCBSDocumentation } from './cbsDocumentation'

describe('CBS documentation', () => {
    test('collects public definitions and excludes internal functions', () => {
        const documentation = getCBSDocumentation()

        expect(documentation.find(item => item.name === 'char')).toMatchObject({
            aliases: ['bot'],
        })
        expect(documentation.some(item => item.name === '__')).toBe(false)
    })
})
