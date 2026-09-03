import { beforeEach, describe, expect, it } from 'vitest'
import { clearGuiHtmlRenderCache, getParsedGuiHtml } from './guiHtmlRenderCache'

describe('guiHtmlRenderCache', () => {
    beforeEach(clearGuiHtmlRenderCache)

    it('shares parsed DOM for identical expanded HTML', () => {
        const first = getParsedGuiHtml('<div class="paper">same</div>')
        const second = getParsedGuiHtml('<div class="paper">same</div>')

        expect(second).toBe(first)
        expect(second.querySelector('.paper')?.textContent).toBe('same')
    })

    it('keeps distinct CBS outputs separate', () => {
        const character = getParsedGuiHtml('<span>Character</span>')
        const user = getParsedGuiHtml('<span>User</span>')

        expect(user).not.toBe(character)
        expect(character.textContent).toBe('Character')
        expect(user.textContent).toBe('User')
    })

    it('evicts the least recently used entry when bounded', () => {
        const oldest = getParsedGuiHtml('<div>oldest</div>')
        for (let index = 0; index < 32; index += 1) {
            getParsedGuiHtml(`<div>${index}</div>`)
        }

        expect(getParsedGuiHtml('<div>oldest</div>')).not.toBe(oldest)
    })
})
