import { describe, expect, it } from 'vitest'
import { getTranslationSourceKey, maskUntranslatable } from './translationMask'

function scene(operation: string) {
    return `<lb-xnai translate="no" id="scene-1" operation="${operation}" scene="1">{{inlay::${operation}}}</lb-xnai>`
}

describe('translation masking', () => {
    it('keeps the source untouched without a translate="no" marker', () => {
        const text = '"Hi," she said. <lb-xnai id="scene-1" operation="a" scene="1">{{inlay::a}}</lb-xnai> & <b>more</b>'
        expect(getTranslationSourceKey(text)).toBe(text)
    })

    it('gives raw message text the same key when only a translate="no" tag changes', () => {
        const before = getTranslationSourceKey(`Hello.\n\n${scene('op-a')}\n\nBye & <3`)
        const after = getTranslationSourceKey(`Hello.\n\n${scene('op-b')}\n\nBye & <3`)

        expect(after).toBe(before)
        expect(before).toBe('Hello.\n\n<x-notrans n="0"></x-notrans>\n\nBye & <3')
    })

    it('masks self-closing tags and only the outermost of nested elements', () => {
        const kv = '<lb-xnai translate="no" id="keyvis" kv operation="op-a" />'
        const html = '<div translate="no"><div translate="no"><div>x</div></div></div>'

        expect(getTranslationSourceKey(`${kv}\nText`)).toBe('<x-notrans n="0"></x-notrans>\nText')
        expect(getTranslationSourceKey(`<p>A</p>${html}<p>B</p>`))
            .toBe('<p>A</p><x-notrans n="0"></x-notrans><p>B</p>')
    })

    it('drops placeholders carried into a source with nothing masked', () => {
        const { restore } = maskUntranslatable('Hello')

        expect(restore('Hallo<x-notrans n="0"></x-notrans>')).toBe('Hallo')
    })

    it('restores tags in place and appends ones the translator dropped', () => {
        const { restore } = maskUntranslatable(`One\n${scene('op-a')}\nTwo\n${scene('op-b')}`)

        expect(restore('Uno\n<x-notrans n="0" />\nDos'))
            .toBe(`Uno\n${scene('op-a')}\nDos\n\n${scene('op-b')}`)
    })
})
