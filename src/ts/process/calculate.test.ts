import { describe, expect, it } from 'vitest'
import { calculateExpression } from './calculate'

describe('shared trigger expression calculator', () => {
    it('preserves arithmetic precedence and parentheses', () => {
        expect(calculateExpression('1 + 2 * 3')).toBe(7)
        expect(calculateExpression('(1 + 2) * 3')).toBe(9)
    })

    it('resolves chat and global variables without browser state', () => {
        expect(calculateExpression('$local + @global', {
            chat: key => key === 'local' ? '4' : '0',
            global: key => key === 'global' ? '5' : '0',
        })).toBe(9)
    })
})
