import { describe, expect, it } from 'vitest'
import { mergeLanguage } from './index'

describe('mergeLanguage', () => {
    it('fills missing nested entries from the fallback language', () => {
        const fallback = {
            menu: {
                title: 'Settings',
                description: 'Configure the application',
            },
            steps: ['first', 'second'],
        }
        const translation = {
            menu: { title: '설정' },
            steps: ['첫 번째'],
        }

        const result = mergeLanguage(fallback, translation)

        expect(result).toEqual({
            menu: {
                title: '설정',
                description: 'Configure the application',
            },
            steps: ['첫 번째'],
        })
        expect(result.steps).toBe(translation.steps)
        expect(fallback.menu.title).toBe('Settings')
    })
})
